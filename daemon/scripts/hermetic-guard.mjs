#!/usr/bin/env node
// Leak-specific hermeticity guard.
//
// Snapshots the operator's real ~/.pair-programmer/state.db (READ-ONLY --
// this script never opens it for writing) before the `npm test` chain runs,
// then compares it again after. It does NOT fail on any and every byte
// change to the ledger file: a live daemon the operator has running in a
// parallel Claude Code / Hydra session is allowed to keep writing its own
// real runs throughout the test run without tripping this guard. Instead it
// looks specifically for NEW rows in `runs` that are *test-attributable* --
// rows whose `project_path` sits under the OS temp directory (every test in
// this suite that spawns a `pp-daemon mcp` subprocess creates its project
// dir via `mkdtempSync(join(tmpdir(), "pp-...-"))`, per the ANTI-STALL TEST
// RULE convention -- grep test/*.mjs for `mkdtempSync(join(tmpdir()`) or
// whose `request_text` starts with one of a short list of markers used by
// the daemon-spawning smoke tests. A concurrent live daemon's own real runs
// use the operator's real project paths and real request text, so they
// never match this filter and never fail the guard.
//
// Usage:
//   node scripts/hermetic-guard.mjs snapshot   # run before the suite (pretest)
//   node scripts/hermetic-guard.mjs verify     # run after the suite (posttest)

import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { existsSync, writeFileSync, readFileSync, mkdirSync, realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import Database from "better-sqlite3";

// Mirrors daemon/src/util/paths.ts's PP_DB_PATH > PP_HOME > default
// precedence, so the guard watches whatever ledger location the operator's
// real daemon (and this test run's OWN un-isolated top-level process env --
// pretest/posttest run before any per-test PP_HOME override, which each
// test sets only on its OWN spawned subprocess) actually uses.
// PP_HERMETIC_GUARD_DB_PATH takes precedence over both -- it exists solely
// so the guard's own unit tests (hermetic-guard.unit.mjs) can point the
// guard at a disposable temp ledger instead of touching any real path.
function realLedgerPath() {
  if (process.env.PP_HERMETIC_GUARD_DB_PATH) return process.env.PP_HERMETIC_GUARD_DB_PATH;
  if (process.env.PP_DB_PATH) return process.env.PP_DB_PATH;
  const root = process.env.PP_HOME ? join(process.env.PP_HOME, ".pair-programmer") : join(homedir(), ".pair-programmer");
  return join(root, "state.db");
}

// PP_HERMETIC_GUARD_SNAPSHOT_PATH lets hermetic-guard.unit.mjs point
// snapshot/verify at a private snapshot file, so its calls to cmd_snapshot/
// cmd_verify (against disposable PP_HERMETIC_GUARD_DB_PATH temp ledgers)
// never clobber the real snapshot the pretest/posttest lifecycle hooks
// wrote for THIS npm test run's own real-ledger check. Read at CALL time
// (not module-load time) so a test can set the env var after importing.
function snapshotFilePath() {
  return process.env.PP_HERMETIC_GUARD_SNAPSHOT_PATH ?? join(tmpdir(), "pp-hermetic-guard-snapshot.json");
}

// Test-attributable `request_text` prefixes used by the daemon-spawning
// tests (test/smoke.mjs, test/artifact-validators.smoke.mjs,
// test/best-of-data-loss.mjs) as a second, defense-in-depth signal beside
// the project_path-under-tmpdir check. Kept in sync by grepping
// `request_text:` literals in those files; a future smoke test that adds a
// new marker without also using a tmpdir-rooted project_path should add its
// prefix here too.
const TEST_REQUEST_TEXT_PREFIXES = [
  "av-smoke",
  "smoke test request",
  "dispatched sub-agent fan-out",
  "after finalize, fresh run",
  "best-of data-loss",
];

function tmpPrefixes() {
  const raw = tmpdir();
  const variants = new Set([raw]);
  try {
    variants.add(realpathSync(raw));
  } catch {
    // tmpdir() may not exist yet in some sandboxes -- fine, raw is still used.
  }
  // Normalize to forward slashes and lowercase (Windows paths are
  // case-insensitive) so a startsWith check is reliable cross-platform.
  return [...variants].map((p) => resolve(p).replace(/\\/g, "/").toLowerCase());
}

function isTestAttributable(row, prefixes) {
  const proj = String(row.project_path ?? "").replace(/\\/g, "/").toLowerCase();
  if (prefixes.some((p) => proj.startsWith(p))) return true;
  const req = String(row.request_text ?? "");
  return TEST_REQUEST_TEXT_PREFIXES.some((m) => req.startsWith(m));
}

// Opens the ledger READ-ONLY. Never writes to it. Returns null if the file
// doesn't exist (snapshot/verify are then no-ops with a notice) so a fresh
// operator machine with no ledger yet doesn't fail the guard.
function openReadOnly(path) {
  if (!existsSync(path)) return null;
  return new Database(path, { readonly: true, fileMustExist: true });
}

// Returns { maxRowid } describing the current high-water mark of
// test-attributable rows in `runs`, or null if the table doesn't exist yet
// (a brand new, empty ledger).
function testAttributableWatermark(db) {
  const tableExists = db
    .prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'runs'`)
    .get();
  if (!tableExists) return null;
  const rows = db.prepare(`SELECT rowid, project_path, request_text FROM runs`).all();
  const prefixes = tmpPrefixes();
  let maxRowid = 0;
  for (const row of rows) {
    if (isTestAttributable(row, prefixes) && row.rowid > maxRowid) maxRowid = row.rowid;
  }
  return { maxRowid };
}

// Returns the test-attributable rows with rowid strictly greater than
// `sinceRowid` -- i.e. NEW test-attributable rows written since the
// snapshot. Rows written by a live, unrelated daemon session never appear
// here because they fail the project_path/request_text filter.
function newTestAttributableRows(db, sinceRowid) {
  const tableExists = db
    .prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'runs'`)
    .get();
  if (!tableExists) return [];
  const rows = db
    .prepare(`SELECT rowid, id, project_path, request_text FROM runs WHERE rowid > ?`)
    .all(sinceRowid);
  const prefixes = tmpPrefixes();
  return rows.filter((row) => isTestAttributable(row, prefixes));
}

function cmd_snapshot() {
  const path = realLedgerPath();
  const snapshotPath = snapshotFilePath();
  const db = openReadOnly(path);
  if (!db) {
    mkdirSync(tmpdir(), { recursive: true });
    writeFileSync(snapshotPath, JSON.stringify({ path, exists: false, maxRowid: 0 }, null, 2));
    console.log(`[hermetic-guard] snapshot: ${path} does not exist yet -- no-op, will still verify clean.`);
    return;
  }
  try {
    const watermark = testAttributableWatermark(db);
    const maxRowid = watermark ? watermark.maxRowid : 0;
    mkdirSync(tmpdir(), { recursive: true });
    writeFileSync(snapshotPath, JSON.stringify({ path, exists: true, maxRowid }, null, 2));
    console.log(`[hermetic-guard] snapshot: ${path} (read-only) -- test-attributable watermark rowid=${maxRowid}.`);
  } finally {
    db.close();
  }
}

function cmd_verify() {
  const snapshotPath = snapshotFilePath();
  if (!existsSync(snapshotPath)) {
    console.log("[hermetic-guard] no prior snapshot found -- skipping verify (did pretest run?)");
    return;
  }
  const { path, exists: existedBefore, maxRowid } = JSON.parse(readFileSync(snapshotPath, "utf8"));
  const db = openReadOnly(path);
  if (!db) {
    console.log(`[hermetic-guard] OK: ${path} still does not exist -- nothing to leak into.`);
    return;
  }
  try {
    const leaked = newTestAttributableRows(db, existedBefore ? maxRowid : 0);
    if (leaked.length > 0) {
      console.error(
        `[hermetic-guard] FAIL: ${leaked.length} test-attributable row(s) were written to the real ledger during the test run:\n` +
        leaked.map((r) => `  rowid=${r.rowid} id=${r.id} project_path=${r.project_path} request_text=${r.request_text}`).join("\n") +
        `\nA test spawned a pp-daemon without an isolated PP_HOME (or PP_DB_PATH) and wrote ` +
        `to the operator's real state.db at ${path}. Every test that spawns \`pp-daemon mcp\` ` +
        `(or otherwise calls db()) must set PP_HOME (or PP_DB_PATH) to a fresh temp directory ` +
        `before doing so. This is leak-specific: unrelated writes from a live daemon session ` +
        `(rows whose project_path/request_text don't match the test markers) do NOT fail this check.`
      );
      process.exitCode = 1;
      return;
    }
    console.log(`[hermetic-guard] OK: ${path} (read-only) -- no test-attributable rows leaked.`);
  } finally {
    db.close();
  }
}

// Exported for hermetic-guard.unit.mjs -- importing this module must NOT
// trigger CLI dispatch (below), only calling these functions directly does.
export {
  realLedgerPath,
  tmpPrefixes,
  isTestAttributable,
  openReadOnly,
  testAttributableWatermark,
  newTestAttributableRows,
  cmd_snapshot,
  cmd_verify,
  snapshotFilePath,
};

// Only dispatch the CLI when this file is executed directly (`node
// scripts/hermetic-guard.mjs snapshot|verify`), not when it's imported as a
// module by hermetic-guard.unit.mjs -- otherwise importing it for testing
// would itself run snapshot/verify against argv it doesn't control and could
// set process.exitCode as a side effect of import.
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const mode = process.argv[2];
  if (mode === "snapshot") cmd_snapshot();
  else if (mode === "verify") cmd_verify();
  else {
    console.error(`[hermetic-guard] usage: node scripts/hermetic-guard.mjs <snapshot|verify>`);
    process.exitCode = 2;
  }
}
