// Tests for daemon/scripts/hermetic-guard.mjs itself.
//
// Critique fix (Reflexion retry, codex gpt-5.6-terra): the guard used to
// fail on ANY size/mtime change to the real ledger file, with no
// attribution to test-created rows — a false positive whenever a live,
// unrelated daemon session (the operator's own Claude Code/Hydra session)
// wrote to the real ledger during a test run. It is now leak-specific: it
// only fails on NEW rows in `runs` whose project_path sits under the OS
// temp dir (the convention every daemon-spawning test in this suite uses)
// or whose request_text matches one of the enumerated smoke-test markers.
//
// ANTI-STALL TEST RULE: every ledger this test touches is a disposable
// temp SQLite file created here, pointed at via PP_HERMETIC_GUARD_DB_PATH.
// It NEVER opens, reads, or writes the operator's real
// ~/.pair-programmer/state.db.

import { strict as assert } from "node:assert";
import { it } from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import Database from "better-sqlite3";
import {
  tmpPrefixes,
  isTestAttributable,
  testAttributableWatermark,
  newTestAttributableRows,
  cmd_snapshot,
  cmd_verify,
  snapshotFilePath,
} from "../scripts/hermetic-guard.mjs";

const SUITE_DIR = mkdtempSync(join(tmpdir(), "pp-hermetic-guard-test-"));
// This suite's OWN private snapshot file -- distinct from the real one
// package.json's pretest/posttest hooks write for the surrounding `npm
// test` run. Never clobber that one.
const TEST_SNAPSHOT_PATH = join(SUITE_DIR, "snapshot.json");
process.env.PP_HERMETIC_GUARD_SNAPSHOT_PATH = TEST_SNAPSHOT_PATH;

function freshLedger() {
  const dbPath = join(SUITE_DIR, `ledger-${Math.random().toString(36).slice(2)}.db`);
  const db = new Database(dbPath);
  db.exec(`CREATE TABLE runs (id TEXT PRIMARY KEY, project_path TEXT NOT NULL, request_text TEXT NOT NULL)`);
  db.close();
  return dbPath;
}

function insertRun(dbPath, { id, project_path, request_text }) {
  const db = new Database(dbPath);
  db.prepare(`INSERT INTO runs(id, project_path, request_text) VALUES (?, ?, ?)`).run(id, project_path, request_text);
  db.close();
}

/** Runs snapshot/verify against dbPath via PP_HERMETIC_GUARD_DB_PATH, restoring env after. */
function withGuardEnv(dbPath, fn) {
  const prior = process.env.PP_HERMETIC_GUARD_DB_PATH;
  process.env.PP_HERMETIC_GUARD_DB_PATH = dbPath;
  try {
    return fn();
  } finally {
    if (prior === undefined) delete process.env.PP_HERMETIC_GUARD_DB_PATH;
    else process.env.PP_HERMETIC_GUARD_DB_PATH = prior;
  }
}

function captureExitCode(fn) {
  const prior = process.exitCode;
  process.exitCode = undefined;
  fn();
  const result = process.exitCode;
  process.exitCode = prior;
  return result;
}

it("isTestAttributable: a row whose project_path is under the OS temp dir is test-attributable", () => {
  const prefixes = tmpPrefixes();
  const row = { project_path: join(tmpdir(), "pp-smoke-abc123"), request_text: "anything at all" };
  assert.ok(isTestAttributable(row, prefixes));
});

it("isTestAttributable: a row whose request_text matches a known smoke marker is test-attributable even outside tmpdir", () => {
  const prefixes = tmpPrefixes();
  const row = { project_path: "/home/operator/real-project", request_text: "av-smoke happy path" };
  assert.ok(isTestAttributable(row, prefixes));
});

it("isTestAttributable: an operator's real row (real project path, real request text) is NOT test-attributable", () => {
  const prefixes = tmpPrefixes();
  const row = { project_path: "/home/operator/real-project", request_text: "ship the auth refactor" };
  assert.ok(!isTestAttributable(row, prefixes));
});

it("snapshot -> verify: missing ledger is a clean no-op (no DB created, no error)", () => {
  const dbPath = join(SUITE_DIR, "does-not-exist.db");
  withGuardEnv(dbPath, () => {
    const snapExit = captureExitCode(cmd_snapshot);
    assert.equal(snapExit, undefined);
    assert.ok(!existsSync(dbPath), "guard must never create the ledger it watches");
    const verifyExit = captureExitCode(cmd_verify);
    assert.equal(verifyExit, undefined, "verify against a still-missing DB must be a clean no-op");
  });
});

it("snapshot -> verify: a NEW test-attributable row written after snapshot FAILS verify", () => {
  const dbPath = freshLedger();
  withGuardEnv(dbPath, () => {
    captureExitCode(cmd_snapshot);
    insertRun(dbPath, { id: "leak-1", project_path: join(tmpdir(), "pp-smoke-leak"), request_text: "smoke test request: do nothing" });
    const verifyExit = captureExitCode(cmd_verify);
    assert.equal(verifyExit, 1, "a leaked test-attributable row must fail verify");
  });
});

it("snapshot -> verify: an UNRELATED concurrent row (real project path/text, simulating a live daemon session) PASSES verify", () => {
  const dbPath = freshLedger();
  withGuardEnv(dbPath, () => {
    captureExitCode(cmd_snapshot);
    insertRun(dbPath, { id: "live-1", project_path: "/home/operator/real-project", request_text: "operator's own concurrent work" });
    const verifyExit = captureExitCode(cmd_verify);
    assert.equal(verifyExit, undefined, "an unrelated live-daemon write must NOT fail the leak-specific guard");
  });
});

it("REGRESSION (old mtime/size guard would have failed this): an unrelated row growing the DB file still passes the new leak-specific verify", () => {
  // This is exactly the false-positive scenario the critique named: the
  // file's size/mtime changes (a real row got inserted) but no
  // test-attributable row appeared. The old guard compared raw
  // size/mtime and would unconditionally FAIL here; the new guard must
  // pass because nothing test-attributable leaked.
  const dbPath = freshLedger();
  withGuardEnv(dbPath, () => {
    captureExitCode(cmd_snapshot);
    for (let i = 0; i < 5; i++) {
      insertRun(dbPath, { id: `live-bulk-${i}`, project_path: "/home/operator/real-project", request_text: `operator work item ${i}` });
    }
    const verifyExit = captureExitCode(cmd_verify);
    assert.equal(verifyExit, undefined, "bulk unrelated writes (file definitely grew) must still pass the leak-specific guard");
  });
});

it("path precedence: PP_HERMETIC_GUARD_DB_PATH wins over PP_DB_PATH and PP_HOME", () => {
  const guardPath = freshLedger();
  const otherPath = freshLedger();
  const priorDbPath = process.env.PP_DB_PATH;
  const priorHome = process.env.PP_HOME;
  process.env.PP_DB_PATH = otherPath;
  process.env.PP_HOME = join(SUITE_DIR, "unused-home");
  try {
    withGuardEnv(guardPath, () => {
      captureExitCode(cmd_snapshot);
      // Leak into the PP_DB_PATH-resolved ledger, NOT the guard-pinned one.
      insertRun(otherPath, { id: "wrong-ledger", project_path: join(tmpdir(), "pp-smoke-wrong"), request_text: "smoke test request: do nothing" });
      const verifyExit = captureExitCode(cmd_verify);
      assert.equal(verifyExit, undefined, "PP_HERMETIC_GUARD_DB_PATH must override PP_DB_PATH/PP_HOME for what the guard watches");
    });
  } finally {
    if (priorDbPath === undefined) delete process.env.PP_DB_PATH;
    else process.env.PP_DB_PATH = priorDbPath;
    if (priorHome === undefined) delete process.env.PP_HOME;
    else process.env.PP_HOME = priorHome;
  }
});

it("testAttributableWatermark / newTestAttributableRows: rowid-based watermark ignores pre-existing test rows and only reports NEW ones", () => {
  const dbPath = freshLedger();
  insertRun(dbPath, { id: "pre-existing", project_path: join(tmpdir(), "pp-smoke-preexisting"), request_text: "smoke test request: do nothing" });
  const db1 = new Database(dbPath, { readonly: true, fileMustExist: true });
  const watermark = testAttributableWatermark(db1);
  db1.close();
  assert.ok(watermark && watermark.maxRowid >= 1);

  insertRun(dbPath, { id: "new-leak", project_path: join(tmpdir(), "pp-smoke-newleak"), request_text: "smoke test request: do nothing" });
  const db2 = new Database(dbPath, { readonly: true, fileMustExist: true });
  const leaked = newTestAttributableRows(db2, watermark.maxRowid);
  db2.close();
  assert.equal(leaked.length, 1);
  assert.equal(leaked[0].id, "new-leak");
});

process.on("exit", () => {
  rmSync(snapshotFilePath(), { force: true });
  delete process.env.PP_HERMETIC_GUARD_SNAPSHOT_PATH;
  rmSync(SUITE_DIR, { recursive: true, force: true });
});
