// RA-4 unit tests: ack_run MCP tool / ackRun orchestrator function.
//
// Covers:
//  1. ackRun happy path: sets acked_at + acked_reason, returns acked=true.
//  2. Idempotent: second call returns already_acked=true with original timestamp.
//  3. Unknown run_id: throws RunNotFound.
//  4. Banner query — surfaced-runs list: acked runs are excluded; un-acked still listed.
//  5. Banner query — surfaced-run-reminder: acked runs are excluded; un-acked still surfaced.

import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import assert from "node:assert/strict";

const SUITE_DIR = mkdtempSync(join(tmpdir(), "pp-ack-run-"));
mkdirSync(join(SUITE_DIR, ".pair-programmer"), { recursive: true });
process.env.PP_HOME = SUITE_DIR;
process.env.EIGHTS_SKIP_AUDIT_CHECK = "1";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DIST = join(__dirname, "..", "dist");
const importDist = (relPath) => import(pathToFileURL(join(DIST, relPath)).href);

let passed = 0;
let failed = 0;
function record(name, fn) {
  return fn().then(
    () => { console.log(`  pass  ${name}`); passed++; },
    (err) => { console.error(`  FAIL  ${name}\n         ${err.message}`); failed++; },
  );
}

function setupProject() {
  const dir = mkdtempSync(join(tmpdir(), "pp-ack-proj-"));
  mkdirSync(join(dir, ".harness"), { recursive: true });
  writeFileSync(join(dir, "AGENTS.md"), "# AGENTS\n", "utf8");
  return dir;
}

// ─── Test 1: happy path ──────────────────────────────────────────────────────
await record("ackRun happy path — sets acked_at and acked_reason", async () => {
  const project = setupProject();
  try {
    const runs = await importDist("orchestrator/runs.js");
    const { db } = await importDist("db/database.js");

    const run = await runs.ensureRun({ request_text: "ack test run", project_path: project });
    // Transition to surfaced so it resembles a real surfaced-run scenario.
    runs.finalizeRun({ run_id: run.run_id, status: "surfaced", summary_md: "Surfaced for test" });

    const result = runs.ackRun({ run_id: run.run_id, reason: "Preserved and merged manually — work landed in main." });
    assert.ok(result.acked === true, "acked=true on first call");
    assert.equal(result.run_id, run.run_id, "run_id echoed back");
    assert.ok(typeof result.acked_at === "string" && result.acked_at.length > 0, "acked_at is ISO string");

    // Verify the DB columns were set correctly.
    const row = db().prepare("SELECT acked_at, acked_reason FROM runs WHERE id = ?").get(run.run_id);
    assert.ok(row.acked_at, "acked_at persisted in DB");
    assert.equal(row.acked_reason, "Preserved and merged manually — work landed in main.", "acked_reason persisted");
    assert.equal(row.acked_at, result.acked_at, "DB acked_at matches return value");
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

// ─── Test 2: idempotent ──────────────────────────────────────────────────────
await record("ackRun is idempotent — second call returns already_acked=true", async () => {
  const project = setupProject();
  try {
    const runs = await importDist("orchestrator/runs.js");

    const run = await runs.ensureRun({ request_text: "idempotent ack test", project_path: project });
    runs.finalizeRun({ run_id: run.run_id, status: "surfaced" });

    const first  = runs.ackRun({ run_id: run.run_id, reason: "First ack reason here" });
    const second = runs.ackRun({ run_id: run.run_id, reason: "Different reason on second call" });

    assert.ok(first.acked === true,          "first call: acked=true");
    assert.ok(second.already_acked === true, "second call: already_acked=true");
    assert.equal(second.acked_at, first.acked_at, "timestamp is unchanged on re-ack");
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

// ─── Test 3: unknown run_id ──────────────────────────────────────────────────
await record("ackRun throws RunNotFound for unknown run_id", async () => {
  const runs = await importDist("orchestrator/runs.js");
  assert.throws(
    () => runs.ackRun({ run_id: "run_does_not_exist_123", reason: "any reason" }),
    (err) => err.name === "RunNotFound" || /not found/i.test(err.message),
    "RunNotFound thrown for unknown id",
  );
});

// ─── Test 4: banner list query excludes acked runs ───────────────────────────
await record("surfaced-runs banner query excludes acked, lists un-acked", async () => {
  // Use two separate projects so ensureRun doesn't return the same run for both.
  // The banner queries filter by project_path so we inject a sentinel project
  // path manually to cover both runs in one query.
  const projectA = setupProject();
  const projectB = setupProject();
  // Use a shared sentinel project_path value in the runs table for querying.
  // We do this by starting the runs with the same project but using startRun
  // (not ensureRun which is idempotent per open run). The easiest approach
  // is to use two separate projects and query across both via LIKE or just
  // verify each run independently.
  try {
    const runs = await importDist("orchestrator/runs.js");
    const { db } = await importDist("db/database.js");

    // startRun creates a new run unconditionally. The project lock is held while
    // a run is open, so we finalize each run before starting the next one.
    const runA = await runs.startRun({ request_text: "surfaced run A (will be acked)", project_path: projectA, mode: "single" });
    runs.finalizeRun({ run_id: runA.run_id, status: "surfaced" });  // releases lock
    const runB = await runs.startRun({ request_text: "surfaced run B (un-acked)", project_path: projectA, mode: "single" });
    runs.finalizeRun({ run_id: runB.run_id, status: "surfaced" });

    // Ack run A.
    runs.ackRun({ run_id: runA.run_id, reason: "Merged manually, no retry needed." });

    // Replicate the banner query from dispatcher.ts surfaced-runs handler.
    const rows = db()
      .prepare(`SELECT id, request_text FROM runs WHERE project_path = ? AND status = 'surfaced' AND acked_at IS NULL ORDER BY started_at DESC LIMIT 5`)
      .all(projectA);

    const ids = rows.map(r => r.id);
    assert.ok(!ids.includes(runA.run_id), "acked run A is excluded from banner");
    assert.ok( ids.includes(runB.run_id), "un-acked run B still appears in banner");
  } finally {
    rmSync(projectA, { recursive: true, force: true });
    rmSync(projectB, { recursive: true, force: true });
  }
});

// ─── Test 5: reminder query excludes acked runs ──────────────────────────────
await record("surfaced-run-reminder query excludes acked, returns un-acked", async () => {
  const project = setupProject();
  try {
    const runs = await importDist("orchestrator/runs.js");
    const { db } = await importDist("db/database.js");

    // Finalize each run before starting the next: the project lock is held
    // while a run is open, startRun would throw ProjectLockBusyError otherwise.
    const runA = await runs.startRun({ request_text: "reminder acked run", project_path: project, mode: "single" });
    runs.finalizeRun({ run_id: runA.run_id, status: "surfaced" });  // releases lock
    const runB = await runs.startRun({ request_text: "reminder un-acked run", project_path: project, mode: "single" });
    runs.finalizeRun({ run_id: runB.run_id, status: "surfaced" });

    // Ack run A. Run B remains un-acked.
    runs.ackRun({ run_id: runA.run_id, reason: "Dismissed by operator." });

    // Replicate the reminder query from dispatcher.ts surfaced-run-reminder handler.
    const row = db()
      .prepare(`SELECT id FROM runs WHERE project_path = ? AND status = 'surfaced' AND acked_at IS NULL ORDER BY started_at DESC LIMIT 1`)
      .get(project);

    assert.ok(row, "at least one un-acked surfaced run found");
    assert.equal(row.id, runB.run_id, "reminder returns the un-acked run B");
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

// ─── Summary ─────────────────────────────────────────────────────────────────
console.log();
console.log(`${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
