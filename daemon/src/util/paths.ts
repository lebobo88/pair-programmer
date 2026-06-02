import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdirSync } from "node:fs";

export const HOME = homedir();
// PP_HOME overrides the root dir (useful for tests that need an isolated DB).
// PP_DB_PATH overrides the DB path directly. Both default to the standard layout.
export const ROOT_DIR = process.env.PP_HOME
  ? join(process.env.PP_HOME, ".pair-programmer")
  : join(HOME, ".pair-programmer");
export const DB_PATH = process.env.PP_DB_PATH ?? join(ROOT_DIR, "state.db");
export const LOG_DIR = join(ROOT_DIR, "logs");
export const SANDBOX_DIR = join(ROOT_DIR, "sandboxes");
export const PRICES_PATH = join(ROOT_DIR, "prices.json");
export const PID_LOCK = join(ROOT_DIR, "daemon.lock");

export function ensureDirs(): void {
  for (const d of [ROOT_DIR, LOG_DIR, SANDBOX_DIR]) {
    mkdirSync(d, { recursive: true });
  }
}

export function projectArtifactDir(projectPath: string, runId: string): string {
  return join(projectPath, ".harness", runId);
}

export function projectLockPath(projectPath: string): string {
  return join(projectPath, ".harness", ".lock");
}

/**
 * Dynamic sibling-project resolution (mirrors AgentSmith's daemon/src/paths.ts
 * so the ecosystem shares one convention — see the cross-project-conventions
 * skill). Every default path is derived from THIS module's own on-disk location
 * so a fresh `git clone` to any directory works with no hardcoded absolute
 * paths. The package is ESM, so `import.meta.url` is valid at runtime;
 * `fileURLToPath` converts the Windows `file:///C:/…` form correctly.
 *
 * The anchor is paths.js's OWN location, never a caller-supplied path, so any
 * importer (e.g. ecosystem/eights-client.js) inherits a correct repo-root
 * anchor regardless of its own dist depth.
 */

/** Directory of the compiled module: `<repo>/daemon/dist/util/paths.js`. */
const thisDir = dirname(fileURLToPath(import.meta.url));

/**
 * Repo root, derived from this module's location.
 *   <repo>/daemon/dist/util/paths.js  ->  ../../..  ->  <repo>
 * (Three levels because this module lives under `util/`; AgentSmith's
 * daemon/dist/paths.js needs only `../..`.) Forward-slash normalized.
 */
export function repoRootDefault(): string {
  return resolve(thisDir, "..", "..", "..").replace(/\\/g, "/");
}

/**
 * Base directory that holds the sibling projects (AgentSmith, ExecutiveSuite,
 * TheEights, …). They live adjacent to the pair-programmer clone (same parent
 * folder), so the default is the parent of the repo root.
 */
export function siblingsBaseDefault(): string {
  return dirname(repoRootDefault()).replace(/\\/g, "/");
}

/**
 * Effective consumer/sibling base. `PP_CONSUMER_BASE` (AgentSmith parity) or
 * its `PP_ECOSYSTEM_ROOT` alias override the adjacent-folder default. Read at
 * call-time so tests/env can override.
 */
export function consumerBase(): string {
  const override = process.env.PP_CONSUMER_BASE ?? process.env.PP_ECOSYSTEM_ROOT;
  return (override ?? siblingsBaseDefault()).replace(/\\/g, "/");
}

/** Join a sibling project name onto the (env-aware) consumer base. */
export function siblingPath(name: string, base = consumerBase()): string {
  return join(base, name).replace(/\\/g, "/");
}
