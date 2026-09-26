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
 * L1B TheEights-hermeticity finding (2026-09-26): this helper only ever
 * scrubbed/relocated the two PP LEDGER-location vars. It never touched
 * `HOME`/`USERPROFILE`/`EIGHTS_HOME`, so every spawned child built through it
 * inherited the OPERATOR'S REAL `HOME`. `eights-client.ts`'s
 * `resolveDaemonEntry()` then fell through to the well-known sibling
 * TheEights checkout (when present, e.g. on this dev box) and that spawned
 * REAL TheEights defaulted its OWN state home to the operator's REAL
 * `~/.eights` too (TheEights `config.ts:23`,
 * `process.env.EIGHTS_HOME ?? join(homedir(), ".eights")`). See
 * `.harness/evidence/l1b-artifact-validators-smoke-eights-hermeticity.md`
 * for the full file:line inventory of every call site this affected.
 *
 * Default (no `eights` option, the overwhelming majority of call sites,
 * none of which assert anything about TheEights): sets
 * `PP_ECOSYSTEM_DISABLED=1` in the built env. This short-circuits
 * `eights-client.ts`'s `probe()` to `"unavailable"` BEFORE
 * `resolveDaemonEntry()` is even called -- no transport is constructed, no
 * subprocess (real TheEights or otherwise) is ever spawned by the child this
 * env is handed to, full stop. This is a stronger guarantee than merely
 * redirecting `EIGHTS_HOME`: a wrong/leftover `PP_EIGHTS_DAEMON` pointing at
 * a bogus path, or a live daemon that's slow to fail, can't matter if the
 * probe itself never runs.
 *
 * Explicit opt-in, `eights: { enabled: true }`, for the rare caller that
 * legitimately DOES want a live eights-client connection (currently: none of
 * the `isolatedChildEnv()` call sites -- `eights-integration.smoke.mjs`,
 * gated on `PP_LIVE_EIGHTS=1`, and the fake-eights-daemon-fixture unit tests
 * set `PP_EIGHTS_DAEMON`/manage `PP_ECOSYSTEM_DISABLED` directly on their OWN
 * process instead of going through this helper, so they are unaffected by
 * this default either way). Opting in never falls back to the real
 * `~/.eights`: unless the caller's `extra` already pins its own
 * `PP_EIGHTS_DAEMON`/`EIGHTS_HOME`, this sets `EIGHTS_HOME` to a fresh
 * isolated temp directory (or `eights.eightsHome` if supplied).
 *
 * Returns { env, ppHome, ppDbPath } -- callers that also need to open the
 * daemon's own SQLite file directly (bypassing the MCP tool layer) must use
 * the returned `ppDbPath`, never `process.env.PP_DB_PATH`.
 */
export function isolatedChildEnv({ ppHome, ppDbPath, extra = {}, base = process.env, prefix, eights } = {}) {
  const temp = ppHome && ppDbPath ? { ppHome, ppDbPath } : makeTempLedger(prefix);
  const eightsOpts = eights ?? {};
  const eightsEnv = {};
  if (eightsOpts.enabled) {
    if (!("PP_EIGHTS_DAEMON" in extra) && !("EIGHTS_HOME" in extra)) {
      eightsEnv.EIGHTS_HOME =
        eightsOpts.eightsHome ?? mkdtempSync(join(tmpdir(), "pp-isolated-eights-home-"));
    }
  } else {
    eightsEnv.PP_ECOSYSTEM_DISABLED = "1";
  }
  return {
    env: {
      ...scrubLedgerEnv(base),
      PP_HOME: temp.ppHome,
      PP_DB_PATH: temp.ppDbPath,
      ...eightsEnv,
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
