/**
 * Constitution — the Immortal Head. A per-project covenant document that
 * no agent rewrites; the harness only reads, hashes, and attests against it.
 *
 * Inspired by Hydra's `CONSTITUTION.md` ("one head that cannot die"). The
 * constitution captures invariants the user has chosen for THIS project:
 * identity, hard guarantees, forbidden operations, and required
 * attestations. It binds /pp:replay determinism (the SHA at run-time is
 * recorded on the runs row) and gates release-stage finalization (a new
 * missability check refuses to mark a release run complete without an
 * attestation against the current SHA).
 *
 * Public surface (read-only from pp's side):
 *   - `ensureConstitution(projectPath)` — idempotent scaffold of
 *     CONSTITUTION.md from the template. Never overwrites an existing file.
 *   - `constitutionSha(projectPath)` — content-hash of the on-disk file;
 *     null when no constitution exists.
 *   - `readConstitution(projectPath)` — returns `{ path, body, sha }` or
 *     null when absent.
 *   - `forbiddenPatterns(projectPath)` — naive extraction of Article III
 *     bullet text; used by the constitution-guard hook to advise (not
 *     hard-block) destructive operations.
 *
 * What this module does NOT do:
 *   - Edit the constitution. Amendments are HITL-only via /pp:constitution
 *     amend (Phase C, a separate command implementation).
 *   - Call TheEights. Attestation happens in missability.ts via
 *     eights-client.constitution.attest(); this module is pure local I/O.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, basename, dirname } from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

const CONSTITUTION_NAME = "CONSTITUTION.md";

export function constitutionPath(projectPath: string): string {
  return join(projectPath, CONSTITUTION_NAME);
}

function templatePath(): string {
  // dist/orchestrator/constitution.js → ../../../templates/CONSTITUTION.template.md
  // src/orchestrator/constitution.ts  → ../../templates/CONSTITUTION.template.md
  // Try both — whichever exists.
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(here, "..", "..", "..", "templates", "CONSTITUTION.template.md"),
    join(here, "..", "..", "templates", "CONSTITUTION.template.md"),
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return candidates[0]!; // first will surface as ENOENT in caller
}

function renderTemplate(projectName: string, isoDate: string): string {
  const raw = readFileSync(templatePath(), "utf8");
  return raw
    .replaceAll("{{PROJECT_NAME}}", projectName)
    .replaceAll("{{ADOPTED_DATE}}", isoDate);
}

export type EnsureConstitutionResult = {
  path: string;
  created: boolean;
  sha: string;
};

export function ensureConstitution(projectPath: string): EnsureConstitutionResult {
  const path = constitutionPath(projectPath);
  if (existsSync(path)) {
    const body = readFileSync(path, "utf8");
    return { path, created: false, sha: sha256(body) };
  }
  mkdirSync(projectPath, { recursive: true });
  const body = renderTemplate(basename(projectPath) || "project", new Date().toISOString().slice(0, 10));
  writeFileSync(path, body, "utf8");
  return { path, created: true, sha: sha256(body) };
}

export type ReadConstitutionResult = {
  path: string;
  body: string;
  sha: string;
};

export function readConstitution(projectPath: string): ReadConstitutionResult | null {
  const path = constitutionPath(projectPath);
  if (!existsSync(path)) return null;
  const body = readFileSync(path, "utf8");
  return { path, body, sha: sha256(body) };
}

export function constitutionSha(projectPath: string): string | null {
  return readConstitution(projectPath)?.sha ?? null;
}

/**
 * Best-effort extraction of bullets under "## Article III" (Forbidden
 * Operations). Returns an array of bullet text lines. Empty when the
 * article is absent or empty.
 *
 * The constitution-guard hook (PreToolUse on destructive shell tools)
 * uses this to advise the operator when their command matches a forbidden
 * pattern. We deliberately keep this informational, not blocking — the
 * existing block-destructive-shell hook is the hard enforcement layer.
 */
export function forbiddenPatterns(projectPath: string): string[] {
  const c = readConstitution(projectPath);
  if (!c) return [];
  // Match "## Article III" up to the next "## " or EOF.
  const m = c.body.match(/##\s+Article\s+III[\s\S]*?(?=\n##\s|$)/i);
  if (!m) return [];
  return m[0]
    .split("\n")
    .filter(l => /^\s*[-*]\s+/.test(l))
    .map(l => l.replace(/^\s*[-*]\s+/, "").trim())
    .filter(l => l.length > 0);
}

function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}
