#!/usr/bin/env node
// Real-ledger hermeticity guard.
//
// Snapshots the OPERATOR'S REAL ~/.pair-programmer/state.db (size + mtime,
// honouring the same PP_HOME/PP_DB_PATH precedence as daemon/src/util/paths.ts
// so this guard checks whatever location the operator's real daemon actually
// uses) before the `npm test` chain runs, then compares it again after. If
// any test in the chain wrote to that file — because it forgot to isolate
// its own PP_HOME before spawning a `pp-daemon mcp` subprocess — this guard
// fails the run with a clear message instead of letting the leak pass
// silently. Wired via package.json `pretest`/`posttest` lifecycle hooks so
// it runs around whatever the `test` script does without editing that
// script's own contents.
//
// Usage:
//   node scripts/hermetic-guard.mjs snapshot   # run before the suite (pretest)
//   node scripts/hermetic-guard.mjs verify     # run after the suite (posttest)

import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { existsSync, statSync, writeFileSync, readFileSync, mkdirSync } from "node:fs";

// Mirrors daemon/src/util/paths.ts precedence (PP_DB_PATH > PP_HOME > default)
// WITHOUT importing dist/ (this guard must work even when dist/ is stale or
// mid-build), and deliberately ignores any PP_HOME the guard's own caller
// might have set — it always watches the REAL operator ledger, because a
// non-hermetic test that leaks writes there is exactly the failure mode this
// guard exists to catch.
function realLedgerPath() {
  if (process.env.PP_HERMETIC_GUARD_DB_PATH) return process.env.PP_HERMETIC_GUARD_DB_PATH;
  return join(homedir(), ".pair-programmer", "state.db");
}

// SQLite runs in WAL mode (see database.ts: `conn.pragma("journal_mode =
// WAL")`), so a write lands in `<db>-wal` (and touches `<db>-shm`) and is
// NOT reflected in the main `state.db` file's own size/mtime until a
// checkpoint happens — which may never occur inside a short-lived test
// process. Watching state.db alone would silently miss every leaked write.
// Watch the whole WAL triple.
function ledgerPaths(basePath) {
  return [basePath, `${basePath}-wal`, `${basePath}-shm`];
}

const SNAPSHOT_PATH = join(tmpdir(), "pp-hermetic-guard-snapshot.json");

function snapshotOf(path) {
  if (!existsSync(path)) return { exists: false };
  const st = statSync(path);
  return { exists: true, size: st.size, mtimeMs: st.mtimeMs };
}

function snapshotAll(basePath) {
  const paths = ledgerPaths(basePath);
  return Object.fromEntries(paths.map((p) => [p, snapshotOf(p)]));
}

function cmd_snapshot() {
  const path = realLedgerPath();
  const snap = snapshotAll(path);
  mkdirSync(tmpdir(), { recursive: true });
  writeFileSync(SNAPSHOT_PATH, JSON.stringify({ path, snap }, null, 2));
  const main = snap[path];
  console.log(
    `[hermetic-guard] snapshot: ${path} (+ -wal/-shm) — ${main.exists ? `${main.size} bytes @ ${new Date(main.mtimeMs).toISOString()}` : "(absent)"}`
  );
}

function fileChanged(before, after) {
  return (
    before.exists !== after.exists ||
    (before.exists && after.exists && (before.size !== after.size || before.mtimeMs !== after.mtimeMs))
  );
}

function cmd_verify() {
  if (!existsSync(SNAPSHOT_PATH)) {
    console.log("[hermetic-guard] no prior snapshot found — skipping verify (did pretest run?)");
    return;
  }
  const { path, snap: before } = JSON.parse(readFileSync(SNAPSHOT_PATH, "utf8"));
  const after = snapshotAll(path);

  const changedPaths = ledgerPaths(path).filter((p) => fileChanged(before[p] ?? { exists: false }, after[p]));

  if (changedPaths.length > 0) {
    console.error(
      `[hermetic-guard] FAIL: the real ledger changed during the test run: ${changedPaths.join(", ")}\n` +
      `  before: ${JSON.stringify(before)}\n` +
      `  after:  ${JSON.stringify(after)}\n` +
      `A test spawned a pp-daemon without an isolated PP_HOME and wrote to the ` +
      `operator's real state.db (WAL mode means even a -wal/-shm-only change ` +
      `without a checkpoint counts). Every test that spawns \`pp-daemon mcp\` ` +
      `(or otherwise calls db()) must set PP_HOME (or PP_DB_PATH) to a fresh ` +
      `temp directory before doing so.`
    );
    process.exitCode = 1;
    return;
  }
  console.log(`[hermetic-guard] OK: ${path} (+ -wal/-shm) unchanged.`);
}

const mode = process.argv[2];
if (mode === "snapshot") cmd_snapshot();
else if (mode === "verify") cmd_verify();
else {
  console.error(`[hermetic-guard] usage: node scripts/hermetic-guard.mjs <snapshot|verify>`);
  process.exitCode = 2;
}
