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
import {
  ClaudeTier,
  isClaudeTier,
  JUDGE_REASONING_EFFORTS,
  isAllowedJudgeModel,
  judgePolicyFor,
} from "../config.js";
import { log } from "../util/logger.js";

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
     * "claude"; ignored for Codex/agy producers.
     */
    model_tier?: ClaudeTier;
  };
  judge: {
    tier: "cross_vendor" | "same_vendor";
    rubric?: string;
    /**
     * Advisory producer hint only. `gate_eligible_judges` is authoritative —
     * its filtered `preferred_producers` wins over this field (e.g. when
     * `PP_DISABLE_AGY=1` drops agy from the pool). Kept as a free-form string
     * because it also carries non-producer sentinels such as
     * `codex_alt_model` / `claude_alt_model`.
     */
    model_pref?: string;
    /**
     * J8 — driver-consumed operator overrides for the judge invocation.
     *
     * `model` / `reasoning_effort` / `escalate` are read by the `/pp:run`
     * driver and passed through to `resolveJudgeSelection` with
     * `override_source: "team_yaml"`. They are validated here against
     * `JUDGE_MODEL_POLICY` so a typo fails loudly at load time instead of
     * being silently ignored, or worse, silently falling through to a
     * built-in team of the same name.
     *
     * `model` and `escalate: true` are mutually exclusive — the same rule the
     * daemon-side resolver enforces (config.ts `resolveJudgeSelection`).
     *
     * These do NOT change who judges: `model_pref` remains an advisory
     * producer hint and `gate_eligible_judges` remains authoritative over the
     * producer choice. They only pin how the chosen vendor's judge runs.
     */
    model?: string;
    reasoning_effort?: string;
    escalate?: boolean;
  };
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

/**
 * Thrown by `validateTeamSpec`. Distinguished from "file missing" and "YAML
 * did not parse" so `getTeam` can rethrow it instead of falling through to the
 * next candidate directory — a mis-configured project or user team yaml must
 * never be silently replaced by a built-in team of the same name (J8).
 */
export class TeamSpecValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TeamSpecValidationError";
  }
}

function isTeamSpecValidationError(err: unknown): err is Error {
  return err instanceof Error && err.name === "TeamSpecValidationError";
}

function originOf(dir: string, projectPath: string): "project" | "user" | "builtin" {
  if (dir.startsWith(projectPath)) return "project";
  if (dir === USER_TEAMS_DIR) return "user";
  return "builtin";
}

export function getTeam(opts: { name: string; project_path: string }): { team: TeamSpec; origin: "project" | "user" | "builtin" } | null {
  for (const dir of teamsDirCandidates(opts.project_path)) {
    const path = join(dir, `${opts.name}.yaml`);
    // File missing → this scope simply does not define the team; fall through.
    if (!existsSync(path)) continue;
    const origin = originOf(dir, opts.project_path);

    let text: string;
    let parsed: TeamSpec | undefined;
    try {
      text = readFileSync(path, "utf8");
      parsed = YAML.parse(text) as TeamSpec;
    } catch (err) {
      // Unreadable or syntactically broken YAML → tolerated fallthrough, but
      // never silent: the operator gets the path.
      log.warn({ err, path, origin }, "team yaml could not be read/parsed; skipping this candidate");
      continue;
    }
    if (!parsed?.name) {
      log.warn({ path, origin }, "team yaml has no `name` field; skipping this candidate");
      continue;
    }

    // Validation failure → LOUD. Do NOT continue to the next directory.
    try {
      validateTeamSpec(parsed, path);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      throw new TeamSpecValidationError(
        `invalid ${origin} team yaml for "${opts.name}" (${path}): ${detail} ` +
        `Refusing to fall through to another scope — fix or remove the file. ` +
        `(Resolution order is project → user → builtin; a broken ${origin} copy would ` +
        `otherwise be silently replaced by a different team of the same name.)`,
      );
    }

    try {
      cacheTeamRow(parsed.name, origin, text);
    } catch (err) {
      // Cache is an optimization, not a correctness requirement.
      log.warn({ err, path, origin }, "failed to cache team row; continuing with the loaded spec");
    }
    return { team: parsed, origin };
  }
  return null;
}

/**
 * Map a `judge.model_pref` hint onto the vendor whose judge-model allow-list
 * governs `judge.model` / `judge.reasoning_effort`.
 *
 * `*_alt_model` sentinels mean "the same vendor, but not the model the
 * generator used" — they are vendor-bearing, so they resolve like their base.
 * Anything else (including an absent hint) returns undefined and the caller
 * infers the vendor from the model id instead.
 */
function judgeVendorFromPref(pref: string | undefined): "codex" | "agy" | "claude" | undefined {
  switch (pref) {
    case "codex":
    case "codex_alt_model":
      return "codex";
    case "agy":
      return "agy";
    case "claude":
    case "claude_alt_model":
      return "claude";
    default:
      return undefined;
  }
}

function validateJudgeBlock(stage: TeamStage, path: string): void {
  const judge = stage.judge;
  if (!judge) return;
  const where = `team yaml ${path}: stage "${stage.kind}"`;

  // Typo safety on the tier itself — previously unvalidated, so "cross-vendor"
  // (hyphen) or "crossvendor" silently degraded judge routing.
  if (judge.tier !== undefined && judge.tier !== "cross_vendor" && judge.tier !== "same_vendor") {
    throw new TeamSpecValidationError(
      `${where} has judge.tier=${JSON.stringify(judge.tier)}. Valid values: "cross_vendor" | "same_vendor".`,
    );
  }

  if (judge.escalate !== undefined && typeof judge.escalate !== "boolean") {
    throw new TeamSpecValidationError(
      `${where} has judge.escalate=${JSON.stringify(judge.escalate)}. Must be a boolean (true | false).`,
    );
  }

  const rawModel = typeof judge.model === "string" ? judge.model.trim() : judge.model;
  const hasModel = rawModel !== undefined && rawModel !== "";

  if (hasModel && judge.escalate === true) {
    throw new TeamSpecValidationError(
      `${where} sets judge.model=${JSON.stringify(rawModel)} together with judge.escalate=true. ` +
      `That is ambiguous — the escalated lane is itself a pin. Pass one or the other, not both. ` +
      `(Same rule as the daemon-side resolveJudgeSelection.)`,
    );
  }

  const prefVendor = judgeVendorFromPref(judge.model_pref);

  if (hasModel) {
    if (typeof rawModel !== "string") {
      throw new TeamSpecValidationError(
        `${where} has judge.model=${JSON.stringify(judge.model)}. Must be a model-id string.`,
      );
    }
    if (prefVendor === "claude") {
      throw new TeamSpecValidationError(
        `${where} pins judge.model="${rawModel}" with model_pref="${judge.model_pref}". ` +
        `Claude judges run through the Task() sub-agent path and carry no CLI model pin — ` +
        `only codex and agy have a judge model policy. Drop judge.model, or set model_pref to codex/agy.`,
      );
    }
    const vendor = prefVendor
      ?? (isAllowedJudgeModel("codex", rawModel) ? "codex"
        : isAllowedJudgeModel("agy", rawModel) ? "agy"
        : undefined);
    if (vendor === undefined) {
      throw new TeamSpecValidationError(
        `${where} has judge.model="${rawModel}", which is not an allowed judge model for any vendor. ` +
        `Allowed (codex): ${judgePolicyFor("codex")!.allowed_models.join(", ")}. ` +
        `Allowed (agy): ${judgePolicyFor("agy")!.allowed_models.join(", ")}.`,
      );
    }
    if (!isAllowedJudgeModel(vendor, rawModel)) {
      throw new TeamSpecValidationError(
        `${where} has judge.model="${rawModel}", which is not an allowed ${vendor} judge model. ` +
        `Allowed (${vendor}): ${judgePolicyFor(vendor)!.allowed_models.join(", ")}.`,
      );
    }
  }

  const rawEffort = typeof judge.reasoning_effort === "string"
    ? judge.reasoning_effort.trim()
    : judge.reasoning_effort;
  if (rawEffort !== undefined && rawEffort !== "") {
    if (typeof rawEffort !== "string" || !(JUDGE_REASONING_EFFORTS as readonly string[]).includes(rawEffort)) {
      throw new TeamSpecValidationError(
        `${where} has judge.reasoning_effort=${JSON.stringify(judge.reasoning_effort)}. ` +
        `Valid values: ${JUDGE_REASONING_EFFORTS.join(" | ")}.`,
      );
    }
    // Not every vendor serves every level — agy tops out at "high".
    const effortVendor = prefVendor === "codex" || prefVendor === "agy"
      ? prefVendor
      : hasModel && typeof rawModel === "string" && isAllowedJudgeModel("agy", rawModel) ? "agy"
      : hasModel && typeof rawModel === "string" && isAllowedJudgeModel("codex", rawModel) ? "codex"
      : undefined;
    if (effortVendor) {
      const policy = judgePolicyFor(effortVendor)!;
      if (!(policy.allowed_efforts as readonly string[]).includes(rawEffort)) {
        throw new TeamSpecValidationError(
          `${where} has judge.reasoning_effort="${rawEffort}", which ${effortVendor} does not serve. ` +
          `Allowed (${effortVendor}): ${policy.allowed_efforts.join(" | ")}.`,
        );
      }
    }
  }
}

/**
 * Reject team yamls that set generator.model_tier to an unknown value, or
 * that carry a malformed `judge:` block (J8). Catches typos like "sonet" —
 * silent fallthrough would defeat the tier policy. Other fields are not
 * validated here (the harness has always tolerated extra/missing fields on
 * the team-yaml hot path).
 *
 * Every throw is a `TeamSpecValidationError` so `getTeam` can tell a bad file
 * apart from a missing one and refuse to fall through.
 */
export function validateTeamSpec(spec: TeamSpec, path: string): void {
  for (const stage of spec.stages ?? []) {
    const tier = stage.generator?.model_tier;
    if (tier !== undefined && !isClaudeTier(tier)) {
      throw new TeamSpecValidationError(
        `team yaml ${path}: stage "${stage.kind}" has generator.model_tier="${tier}". ` +
        `Valid values: "opus" | "sonnet" | "haiku" | "fable" (or omit the field). ` +
        `Note: "fable" is capability-gated and expensive — prefer explicit opt-in via deep-reasoning-team.`
      );
    }
    // R3-tail Fix 0.4: best_of_n_on_major_scope must be a sane integer.
    // Typos like "3.5" or strings would silently disable the policy.
    const bon = stage.best_of_n_on_major_scope;
    if (bon !== undefined) {
      if (!Number.isInteger(bon) || bon < 2 || bon > 7) {
        throw new TeamSpecValidationError(
          `team yaml ${path}: stage "${stage.kind}" has best_of_n_on_major_scope=${JSON.stringify(bon)}. ` +
          `Must be an integer in [2, 7] — best-of-N below 2 is meaningless and above 7 burns budget.`,
        );
      }
    }
    // J8: judge overrides (model / reasoning_effort / escalate) + tier typos.
    validateJudgeBlock(stage, path);
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
      } catch (err) {
        // listTeams stays deliberately tolerant: one broken file must not make
        // the whole listing fail. Warn (never silent) and skip. The loud path
        // is getTeam, which is what actually runs a pipeline.
        log.warn({ err, path: join(dir, file), origin }, "team yaml unreadable; omitted from listing");
      }
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
