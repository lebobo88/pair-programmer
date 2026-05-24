/**
 * Team yaml loader. Resolution: project → user → built-in. Loaded teams
 * are cached in the `teams` SQLite table; `team_get` always re-reads from
 * disk to honor edits.
 */

import { readFileSync, existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import { db, txImmediate } from "../db/database.js";
import { ClaudeTier, isClaudeTier } from "../config.js";

export type TeamStage = {
  kind: string;
  artifact_kind?: string;
  gate_type: string;
  generator: {
    agent: string;
    primary?: string;
    fallback?: string;
    /**
     * Optional per-stage Claude tier pin. Sits in layer 5 of the driver's
     * tier resolver (above agent frontmatter, below profile policy /
     * triage / CLI). Only meaningful when generator.primary resolves to
     * "claude"; ignored for Codex/Gemini producers.
     */
    model_tier?: ClaudeTier;
  };
  judge:     { tier: "cross_vendor" | "same_vendor"; rubric?: string; model_pref?: string };
  /**
   * R3-tail post-mortem Fix 0.4 (2026-05-21): when triage classifies the
   * request as `scope: "major"` (high surface area, ≥3 in major-keyword
   * signal heuristics, or operator-flagged), the driver upgrades this
   * stage to a best-of-N candidate race with the configured fan-out.
   * Borda picks a winner from N parallel candidates — avoids the R3-tail
   * trap of reflexion-ing one engineer to death across 10 retry rounds
   * when the surface area is too large for a single attempt to converge.
   * Recommended values: 3 (default) for feature/bug-fix; 5 for marketing
   * page generation where seed diversity matters most.
   * Ignored when triage.scope ∈ {trivial, standard}.
   */
  best_of_n_on_major_scope?: number;
};

export type TeamSpec = {
  name: string;
  description: string;
  profiles_compatible?: string[];
  stages: TeamStage[];
  taxonomy_required?: string[];
  missability_required?: string[];
};

const __dirname = dirname(fileURLToPath(import.meta.url));
// daemon/dist/orchestrator/teams.js → daemon/dist/.. → daemon/.. → project root → .claude/teams
const PROJECT_ROOT = join(__dirname, "..", "..", "..");
const BUILTIN_TEAMS_DIR = join(PROJECT_ROOT, ".claude", "teams");
const USER_TEAMS_DIR    = join(homedir(), ".claude", "teams");

export function teamsDirCandidates(projectPath: string): string[] {
  return [
    join(projectPath, ".claude", "teams"),
    USER_TEAMS_DIR,
    BUILTIN_TEAMS_DIR,
  ];
}

export function getTeam(opts: { name: string; project_path: string }): { team: TeamSpec; origin: "project" | "user" | "builtin" } | null {
  for (const dir of teamsDirCandidates(opts.project_path)) {
    const path = join(dir, `${opts.name}.yaml`);
    if (!existsSync(path)) continue;
    try {
      const text = readFileSync(path, "utf8");
      const parsed = YAML.parse(text) as TeamSpec;
      if (!parsed?.name) continue;
      validateTeamSpec(parsed, path);
      const origin: "project" | "user" | "builtin" =
        dir.startsWith(opts.project_path) ? "project" :
        dir === USER_TEAMS_DIR ? "user" :
        "builtin";
      cacheTeamRow(parsed.name, origin, text);
      return { team: parsed, origin };
    } catch {
      continue;
    }
  }
  return null;
}

/**
 * Reject team yamls that set generator.model_tier to an unknown value.
 * Catches typos like "sonet" — silent fallthrough would defeat the tier
 * policy. Other fields are not validated here (the harness has always
 * tolerated extra/missing fields on the team-yaml hot path).
 */
function validateTeamSpec(spec: TeamSpec, path: string): void {
  for (const stage of spec.stages ?? []) {
    const tier = stage.generator?.model_tier;
    if (tier !== undefined && !isClaudeTier(tier)) {
      throw new Error(
        `team yaml ${path}: stage "${stage.kind}" has generator.model_tier="${tier}". ` +
        `Valid values: "opus" | "sonnet" | "haiku" (or omit the field).`
      );
    }
    // R3-tail Fix 0.4: best_of_n_on_major_scope must be a sane integer.
    // Typos like "3.5" or strings would silently disable the policy.
    const bon = stage.best_of_n_on_major_scope;
    if (bon !== undefined) {
      if (!Number.isInteger(bon) || bon < 2 || bon > 7) {
        throw new Error(
          `team yaml ${path}: stage "${stage.kind}" has best_of_n_on_major_scope=${JSON.stringify(bon)}. ` +
          `Must be an integer in [2, 7] — best-of-N below 2 is meaningless and above 7 burns budget.`,
        );
      }
    }
  }
}

export function listTeams(opts: { project_path: string }): Array<{ name: string; description: string; origin: "project" | "user" | "builtin"; profiles_compatible?: string[]; taxonomy_required?: string[] }> {
  const seen = new Map<string, { name: string; description: string; origin: "project" | "user" | "builtin"; profiles_compatible?: string[]; taxonomy_required?: string[] }>();
  for (const dir of teamsDirCandidates(opts.project_path)) {
    if (!existsSync(dir)) continue;
    const origin: "project" | "user" | "builtin" =
      dir.startsWith(opts.project_path) ? "project" :
      dir === USER_TEAMS_DIR ? "user" :
      "builtin";
    for (const file of readdirSync(dir)) {
      if (!file.endsWith(".yaml") && !file.endsWith(".yml")) continue;
      const name = file.replace(/\.ya?ml$/, "");
      if (seen.has(name)) continue;        // first-resolution wins
      try {
        const text = readFileSync(join(dir, file), "utf8");
        const parsed = YAML.parse(text) as TeamSpec;
        if (!parsed?.name) continue;
        seen.set(name, {
          name: parsed.name,
          description: parsed.description ?? "",
          origin,
          profiles_compatible: parsed.profiles_compatible,
          taxonomy_required: parsed.taxonomy_required,
        });
      } catch { /* ignore */ }
    }
  }
  return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function cacheTeamRow(name: string, origin: "project" | "user" | "builtin", yaml_text: string): void {
  txImmediate(() => {
    db()
      .prepare(`INSERT OR REPLACE INTO teams(name, origin, yaml_text, loaded_at) VALUES (?, ?, ?, ?)`)
      .run(name, origin, yaml_text, new Date().toISOString());
  });
}
