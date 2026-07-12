/**
 * zero-verdict-gate.unit.mjs
 *
 * Unit tests for the LV-4 zero-verdict readiness blocker added to
 * getStageFinalizeReadiness (orchestrator/runs.ts).
 *
 * Live finding: an attended stage finalized 'passed'+complete with zero verdict
 * rows. The gate blocks finalize(passed) when a stage has ≥1 attempt but no
 * non-retracted verdict.
 *
 * Tests:
 *   1. Stage with ≥1 attempt and NO verdict → blocked, gate=zero_verdict,
 *      next_action=record_verdict.
 *   2. Stage with attempt + non-retracted pass verdict → NOT blocked by
 *      zero_verdict gate (latestVerdict is set; the fail-verdict gate is
 *      also skipped because outcome='pass').
 *   3. Stage with attempt + only retracted verdict → STILL blocked (retracted
 *      verdicts are excluded from latestVerdict query).
 *   4. Stage with ZERO attempts (validation-only flow) → NOT blocked by
 *      zero_verdict gate.
 *   5. Blocker names the winner_attempt_id when supplied.
 *   6. Blocker falls back to latest attempt_id when winner_attempt_id not given.
 *   7. finalizeStage(passed) throws when zero-verdict gate fires (standard
 *      blocker/downgrade flow, not a crash).
 *
 * Anti-stall contract:
 *   - Uses a temp sqlite DB (PP_HOME override), direct dist function calls.
 *   - No MCP server, no daemon socket, no smoke files touched.
 *   - Run: timeout 90 node --test test/zero-verdict-gate.unit.mjs
 */

import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import assert from "node:assert/strict";
import { describe, it, before } from "node:test";

// Set PP_HOME BEFORE any dist import so the DB is isolated.
const SUITE_DIR = mkdtempSync(join(tmpdir(), "pp-zero-verdict-gate-"));
mkdirSync(join(SUITE_DIR, ".pair-programmer"), { recursive: true });
process.env.PP_HOME = SUITE_DIR;
process.env.EIGHTS_SKIP_AUDIT_CHECK = "1";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DIST = join(__dirname, "..", "dist");
const importDist = (relPath) => import(pathToFileURL(join(DIST, relPath)).href);

// ── Shared lazy-loaded dist modules ──────────────────────────────────────────

let _runs = null;
let _db = null;

async function getRuns() {
  if (!_runs) _runs = await importDist("orchestrator/runs.js");
  return _runs;
}
async function getDb() {
  if (!_db) {
    const m = await importDist("db/database.js");
    _db = m.db;
  }
  return _db;
}

// ── Shared project directory ───────────────────────────────────────────────

const SHARED_PROJECT = mkdtempSync(join(tmpdir(), "pp-zvg-shared-"));
mkdirSync(join(SHARED_PROJECT, ".harness"), { recursive: true });
writeFileSync(join(SHARED_PROJECT, "AGENTS.md"), "# AGENTS\n", "utf8");

// ── SQL helpers ────────────────────────────────────────────────────────────

/** Insert a bare run row directly (no file I/O, no git, no eights). */
async function insertRun() {
  const db = await getDb();
  const id = `run_zvg_${Math.random().toString(36).slice(2, 12)}`;
  const now = new Date().toISOString();
  db().prepare(
    `INSERT INTO runs(id, project_path, request_text, mode, status, started_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(id, SHARED_PROJECT, "zero-verdict-gate test", "single", "running", now);
  return id;
}

/** Insert a bare stage row directly. */
async function insertStage(run_id, kind = "code") {
  const db = await getDb();
  const id = `stage_zvg_${Math.random().toString(36).slice(2, 12)}`;
  const now = new Date().toISOString();
  db().prepare(
    `INSERT INTO stages(id, run_id, kind, gate_type, status, started_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(id, run_id, kind, kind, "open", now);
  return id;
}

/** Insert an attempt row directly. */
async function insertAttempt(stage_id, { offsetMs = 0 } = {}) {
  const db = await getDb();
  const id = `attempt_zvg_${Math.random().toString(36).slice(2, 12)}`;
  const ts = new Date(Date.now() + offsetMs).toISOString();
  db().prepare(
    `INSERT INTO attempts(id, stage_id, producer, model_id, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(id, stage_id, "claude", "claude-sonnet-4-6", "ok", ts);
  return id;
}

/** Insert a verdict row directly. */
async function insertVerdict(attempt_id, { outcome = "pass", retracted = false, offsetMs = 0 } = {}) {
  const db = await getDb();
  const id = `verdict_zvg_${Math.random().toString(36).slice(2, 12)}`;
  const ts = new Date(Date.now() + offsetMs).toISOString();
  const retractedAt = retracted ? ts : null;
  db().prepare(
    `INSERT INTO verdicts(id, attempt_id, judge_producer, judge_model_id, outcome,
       cross_vendor, hallucination_suspected, retracted_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(id, attempt_id, "codex", "gpt-5.4", outcome, 1, 0, retractedAt, ts);
  return id;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("LV-4 zero-verdict gate: getStageFinalizeReadiness", () => {

  it("stage with ≥1 attempt and NO verdict → blocked (gate=zero_verdict, next_action=record_verdict)", async () => {
    const runs = await getRuns();
    const run_id = await insertRun();
    const stage_id = await insertStage(run_id);
    await insertAttempt(stage_id);

    const readiness = runs.getStageFinalizeReadiness(stage_id);

    assert.equal(readiness.can_pass, false,
      "zero-verdict gate must prevent finalize_passed");
    const blocker = readiness.blockers.find(b => b.gate === "zero_verdict");
    assert.ok(blocker,
      `zero_verdict blocker must be present; blockers=${JSON.stringify(readiness.blockers.map(b => b.gate))}`);
    assert.equal(blocker.next_action, "record_verdict",
      "next_action must be record_verdict");
    assert.ok(typeof blocker.attempt_id === "string" && blocker.attempt_id.length > 0,
      "blocker must carry an attempt_id");
  });

  it("stage with attempt + non-retracted pass verdict → NOT blocked by zero_verdict gate", async () => {
    const runs = await getRuns();
    const run_id = await insertRun();
    const stage_id = await insertStage(run_id);
    const attempt_id = await insertAttempt(stage_id);
    await insertVerdict(attempt_id, { outcome: "pass" });

    const readiness = runs.getStageFinalizeReadiness(stage_id);

    const blocker = readiness.blockers.find(b => b.gate === "zero_verdict");
    assert.equal(blocker, undefined,
      "non-retracted pass verdict must clear the zero_verdict gate");
  });

  it("stage with attempt + ONLY retracted verdict → STILL blocked (retracted excluded from query)", async () => {
    const runs = await getRuns();
    const run_id = await insertRun();
    const stage_id = await insertStage(run_id);
    const attempt_id = await insertAttempt(stage_id);
    // Retracted verdict — must be excluded from latestVerdict query.
    await insertVerdict(attempt_id, { outcome: "pass", retracted: true });

    const readiness = runs.getStageFinalizeReadiness(stage_id);

    assert.equal(readiness.can_pass, false,
      "retracted verdict must not satisfy the zero_verdict gate");
    const blocker = readiness.blockers.find(b => b.gate === "zero_verdict");
    assert.ok(blocker,
      "zero_verdict blocker must still fire when the only verdict is retracted");
    assert.equal(blocker.next_action, "record_verdict");
  });

  it("stage with ZERO attempts (validation-only flow) → NOT blocked by zero_verdict gate", async () => {
    const runs = await getRuns();
    const run_id = await insertRun();
    const stage_id = await insertStage(run_id);
    // No attempts inserted.

    const readiness = runs.getStageFinalizeReadiness(stage_id);

    const blocker = readiness.blockers.find(b => b.gate === "zero_verdict");
    assert.equal(blocker, undefined,
      "stages with zero attempts must not be blocked by zero_verdict gate");
  });

  it("blocker names the supplied winner_attempt_id when given", async () => {
    const runs = await getRuns();
    const run_id = await insertRun();
    const stage_id = await insertStage(run_id);
    const attempt_id = await insertAttempt(stage_id);
    // No verdict.

    const readiness = runs.getStageFinalizeReadiness(stage_id, attempt_id);

    const blocker = readiness.blockers.find(b => b.gate === "zero_verdict");
    assert.ok(blocker, "zero_verdict blocker must be present");
    assert.equal(blocker.attempt_id, attempt_id,
      "blocker.attempt_id must match the supplied winner_attempt_id");
    assert.ok(blocker.message.includes(attempt_id),
      "blocker message must name the attempt_id");
  });

  it("blocker falls back to latest attempt_id when winner_attempt_id not given", async () => {
    const runs = await getRuns();
    const run_id = await insertRun();
    const stage_id = await insertStage(run_id);
    const attempt_id_a = await insertAttempt(stage_id, { offsetMs: 0 });
    const attempt_id_b = await insertAttempt(stage_id, { offsetMs: 10 });
    // No verdict.

    const readiness = runs.getStageFinalizeReadiness(stage_id);  // no winner given

    const blocker = readiness.blockers.find(b => b.gate === "zero_verdict");
    assert.ok(blocker, "zero_verdict blocker must be present");
    // The latest attempt (by created_at DESC) should be attempt_id_b.
    assert.equal(blocker.attempt_id, attempt_id_b,
      `blocker.attempt_id must be the latest attempt; expected=${attempt_id_b}, got=${blocker.attempt_id}`);
    void attempt_id_a; // suppress unused warning
  });

});

describe("LV-4 zero-verdict gate: finalizeStage integration", () => {

  it("finalizeStage(passed) throws when zero-verdict gate fires (not a crash, standard Error)", async () => {
    const runs = await getRuns();
    const run_id = await insertRun();
    const stage_id = await insertStage(run_id);
    const attempt_id = await insertAttempt(stage_id);
    // No verdict — gate must fire.

    let threw = false;
    try {
      await runs.finalizeStage({
        stage_id,
        status: "passed",
        winner_attempt_id: attempt_id,
      });
    } catch (err) {
      threw = true;
      // Must be an Error (not a crash / unhandled rejection).
      assert.ok(err instanceof Error,
        `finalizeStage must throw an Error, got ${typeof err}`);
      assert.ok(err.message.includes("zero_verdict") || err.message.includes("LV-4") || err.message.includes("non-retracted verdict"),
        `error message must describe the LV-4 condition; got: ${err.message}`);
    }
    assert.ok(threw, "finalizeStage(passed) must throw when zero-verdict gate fires");
  });

  it("finalizeStage(surfaced) bypasses zero-verdict gate (surfaced is always allowed)", async () => {
    const runs = await getRuns();
    const run_id = await insertRun();
    const stage_id = await insertStage(run_id);
    const attempt_id = await insertAttempt(stage_id);
    // No verdict — gate would fire on 'passed', but 'surfaced' must bypass.

    // Must not throw.
    await runs.finalizeStage({
      stage_id,
      status: "surfaced",
      winner_attempt_id: attempt_id,
    });

    // Verify the stage was written with surfaced status.
    const db = await getDb();
    const row = db().prepare(`SELECT status FROM stages WHERE id = ?`).get(stage_id);
    assert.equal(row?.status, "surfaced",
      "surfaced must bypass the zero-verdict gate and write the stage row");
  });

});
