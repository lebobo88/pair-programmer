// Shared hermeticity helper for daemon/test/.
//
// src/util/paths.ts resolves the daemon's ledger location as:
//   ROOT_DIR = PP_HOME ? join(PP_HOME, ".pair-programmer") : join(homedir(), ".pair-programmer")
//   DB_PATH  = PP_DB_PATH ?? join(ROOT_DIR, "state.db")
// PP_DB_PATH WINS over PP_HOME. A test that spawns a `pp-daemon` subprocess
// (or a hook subprocess, or any child that imports dist/) via
// `env: { ...process.env, PP_HOME: someTempDir }` still leaks straight into
// the operator's REAL ~/.pair-programmer/state.db whenever the operator has
// PP_DB_PATH exported in their shell -- the temp PP_HOME override is silently
// ignored. The same is true for a raw `new Database(...)` call in test code
// that falls back to `process.env.PP_DB_PATH` when its own PP_DB_PATH wasn't
// explicitly threaded through.
//
// Every daemon-spawning test and every raw SQLite-opening test MUST build
// its child env / db path through this helper instead of hand-rolling
// `{ ...process.env, PP_HOME: x }`. See test/no-real-ledger-access.unit.mjs
// for the static guard that enforces this.

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The only two variables that relocate the daemon's ledger (confirmed
// against src/util/paths.ts -- ROOT_DIR/DB_PATH are the sole ledger-location
// derivation in daemon/src).
export const LEDGER_LOCATION_VARS = Object.freeze(["PP_DB_PATH", "PP_HOME"]);

/**
 * Returns a shallow copy of `base` (default process.env) with every
 * ledger-location override variable removed. Never mutates `base`.
 */
export function scrubLedgerEnv(base = process.env) {
  const out = { ...base };
  for (const key of LEDGER_LOCATION_VARS) delete out[key];
  return out;
}

/**
 * Creates a fresh temp PP_HOME and returns { ppHome, ppDbPath }, where
 * ppDbPath is the explicit path INSIDE that temp home that the daemon will
 * actually open once it sees this PP_HOME with no PP_DB_PATH override
 * (mirrors src/util/paths.ts's ROOT_DIR/DB_PATH derivation).
 */
export function makeTempLedger(prefix = "pp-isolated-") {
  const ppHome = mkdtempSync(join(tmpdir(), prefix));
  const ppDbPath = join(ppHome, ".pair-programmer", "state.db");
  return { ppHome, ppDbPath };
}

/**
 * Builds a child env for a spawned `pp-daemon mcp` (or `dist/index.js hook`,
 * or any other dist-importing) subprocess: a scrubbed copy of `base` plus an
 * explicit temp PP_HOME + explicit temp PP_DB_PATH (derived together so they
 * always agree), plus any `extra` overrides the caller supplies (applied
 * last -- a caller MAY legitimately pin its own PP_DB_PATH, e.g. a
 * schema-migration fixture; that explicit intent always wins over this
 * helper's default temp ledger).
 *
 * Returns { env, ppHome, ppDbPath } -- callers that also need to open the
 * daemon's own SQLite file directly (bypassing the MCP tool layer) must use
 * the returned `ppDbPath`, never `process.env.PP_DB_PATH`.
 */
export function isolatedChildEnv({ ppHome, ppDbPath, extra = {}, base = process.env, prefix } = {}) {
  const temp = ppHome && ppDbPath ? { ppHome, ppDbPath } : makeTempLedger(prefix);
  return {
    env: {
      ...scrubLedgerEnv(base),
      PP_HOME: temp.ppHome,
      PP_DB_PATH: temp.ppDbPath,
      ...extra,
    },
    ppHome: temp.ppHome,
    ppDbPath: temp.ppDbPath,
  };
}

/**
 * For tests that set PP_HOME on their OWN process (no spawn) before the
 * first `dist/` import: scrubs any ambient PP_DB_PATH from process.env
 * in-place, then sets explicit PP_HOME + PP_DB_PATH. Must be called before
 * the first import of anything under dist/ (paths.ts reads these at module
 * load, per the ANTI-STALL TEST RULE's R3.2 convention).
 */
export function setIsolatedProcessEnv({ ppHome, ppDbPath, prefix } = {}) {
  const temp = ppHome && ppDbPath ? { ppHome, ppDbPath } : makeTempLedger(prefix);
  delete process.env.PP_DB_PATH;
  process.env.PP_HOME = temp.ppHome;
  process.env.PP_DB_PATH = temp.ppDbPath;
  return temp;
}
