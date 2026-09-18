/**
 * plan-first-gate.unit.mjs
 *
 * X1b: structural plan-first finalize gate. A `code` stage in a run whose
 * recorded taxonomy mapping scope is 'standard' or 'major' must not finalize
 * 'passed' unless an EARLIER stage in the same run, with a kind in
 * PLAN_FIRST_STAGE_KINDS, has already finalized 'passed'.
 *
 * Anti-stall contract:
 *   - Uses a temp sqlite DB (PP_HOME override), direct dist function calls.
 *   - No MCP server, no daemon socket, no *.smoke.mjs files touched.
 *   - Run: timeout 90 node --test test/plan-first-gate.unit.mjs
 */

import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import YAML from "yaml";

// Set PP_HOME BEFORE any dist import so the DB is isolated.
const SUITE_DIR = mkdtempSync(join(tmpdir(), "pp-plan-first-gate-"));
mkdirSync(join(SUITE_DIR, ".pair-programmer"), { recursive: true });
process.env.PP_HOME = SUITE_DIR;
process.env.EIGHTS_SKIP_AUDIT_CHECK = "1";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DIST = join(__dirname, "..", "dist");
const REPO_ROOT = join(__dirname, "..", "..");
const importDist = (relPath) => import(pathToFileURL(join(DIST, relPath)).href);

let _runs = null;
let _db = null;
let _planFirstGate = null;

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
async function getPlanFirstGate() {
  if (!_planFirstGate) _planFirstGate = await importDist("orchestrator/plan-first-gate.js");
  return _planFirstGate;
}
let _bestOfN = null;
async function getBestOfN() {
  if (!_bestOfN) _bestOfN = await importDist("orchestrator/best-of-n.js");
  return _bestOfN;
}
let _forums = null;
async function getForums() {
  if (!_forums) _forums = await importDist("orchestrator/forums.js");
  return _forums;
}

// ── Shared project directory ───────────────────────────────────────────────
const SHARED_PROJECT = mkdtempSync(join(tmpdir(), "pp-pfg-shared-"));
mkdirSync(join(SHARED_PROJECT, ".harness"), { recursive: true });
writeFileSync(join(SHARED_PROJECT, "AGENTS.md"), "# AGENTS\n", "utf8");

// ── SQL helpers ────────────────────────────────────────────────────────────

async function insertRun(overrides = {}) {
  const db = await getDb();
  const id = `run_pfg_${Math.random().toString(36).slice(2, 12)}`;
  const now = new Date().toISOString();
  db().prepare(
    `INSERT INTO runs(id, project_path, request_text, mode, team, forum, status,
        profile_snapshot_json, taxonomy_mapping_json, started_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    overrides.project_path ?? SHARED_PROJECT,
    "plan-first-gate test",
    "single",
    overrides.team ?? null,
    overrides.forum ?? null,
    "running",
    overrides.profile_snapshot_json ?? null,
    overrides.taxonomy_mapping_json ?? null,
    now,
  );
  return id;
}

let _lastStartedAtMs = 0;
/**
 * started_at is monotonically increasing across calls (even within the same
 * ms) and is a genuine `new Date(ms).toISOString()` value -- same shape as
 * every other timestamp this fixture (and the daemon's `now()`) produces --
 * so it lexically compares correctly against finished_at values built via
 * plain `new Date().toISOString()` calls elsewhere in this file. An earlier
 * version of this helper faked distinct timestamps by appending extra digits
 * before the trailing 'Z' (e.g. ".123000005Z"); that format sorts
 * inconsistently against plain 3-digit-fraction ISO strings (their 'Z'
 * terminator sorts before a digit), which is exactly the kind of format
 * mismatch the plan-first gate's ordering rule depends on NOT existing --
 * see plan-first-gate.ts's tie-break doc comment.
 */
function nextStartedAt() {
  let ms = Date.now();
  if (ms <= _lastStartedAtMs) ms = _lastStartedAtMs + 1;
  _lastStartedAtMs = ms;
  return new Date(ms).toISOString();
}

async function insertStage(run_id, kind = "code", overrides = {}) {
  const db = await getDb();
  const id = `stage_pfg_${Math.random().toString(36).slice(2, 12)}`;
  const started_at = overrides.started_at ?? nextStartedAt();
  db().prepare(
    `INSERT INTO stages(id, run_id, kind, gate_type, status, notes_json, winner_attempt_id, started_at, finished_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id, run_id, kind, kind,
    overrides.status ?? "running",
    overrides.notes_json ?? null,
    overrides.winner_attempt_id ?? null,
    started_at,
    overrides.finished_at ?? null,
  );
  return id;
}

async function insertAttempt(stage_id, overrides = {}) {
  const db = await getDb();
  const id = `attempt_pfg_${Math.random().toString(36).slice(2, 12)}`;
  const now = new Date().toISOString();
  db().prepare(
    `INSERT INTO attempts(id, stage_id, producer, model_id, status, notes_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id, stage_id,
    overrides.producer ?? "claude",
    overrides.model_id ?? "claude-sonnet-5",
    overrides.status ?? "ok",
    overrides.notes_json ?? null,
    now,
  );
  return id;
}

async function insertVerdict(attempt_id, { outcome = "pass" } = {}) {
  const db = await getDb();
  const id = `verdict_pfg_${Math.random().toString(36).slice(2, 12)}`;
  const ts = new Date().toISOString();
  db().prepare(
    `INSERT INTO verdicts(id, attempt_id, judge_producer, judge_model_id, outcome,
       cross_vendor, hallucination_suspected, retracted_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(id, attempt_id, "codex", "gpt-5.6-terra", outcome, 1, 0, null, ts);
  return id;
}

async function insertCodeArtifact(run_id, stage_id, kind = "code") {
  const db = await getDb();
  const id = `art_pfg_${Math.random().toString(36).slice(2, 12)}`;
  db().prepare(
    `INSERT INTO artifacts(id, run_id, stage_id, kind, path, sha256, bytes, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(id, run_id, stage_id, kind, `${kind}.patch`, "abc123", 10, new Date().toISOString());
  return id;
}

/** Full happy-path scaffold: winner + pass verdict + smoke pass, so only the plan-first gate can block. */
async function setupPassableCodeStage(run_id, stage_id) {
  const db = await getDb();
  await insertCodeArtifact(run_id, stage_id, "code");
  const attempt_id = await insertAttempt(stage_id, { notes_json: JSON.stringify({ candidate_index: 0 }) });
  await insertVerdict(attempt_id, { outcome: "pass" });
  db().prepare(`UPDATE stages SET notes_json = ? WHERE id = ?`).run(
    JSON.stringify({ smoke_results: { "0": { status: "pass", reason: null, recorded_at: new Date().toISOString() } } }),
    stage_id,
  );
  return attempt_id;
}

function taxonomyMapping(scope) {
  return JSON.stringify({
    scope, signals: [],
    sections: [], missability_required: [],
  });
}

// ─── 1. standard + prior passed spec -> allowed ───────────────────────────
describe("X1b plan-first gate", () => {

  it("1. standard scope + prior passed spec stage -> allowed", async () => {
    const runs = await getRuns();
    const run_id = await insertRun({ taxonomy_mapping_json: taxonomyMapping("standard") });
    // Explicit, fixed timestamps with a multi-second margin -- a live
    // finished_at read compared against insertStage's default
    // nextStartedAt() could land equal on a coarse clock, which the gate
    // treats as blocked (see test 14a/14b), flipping this "allowed" case.
    const specFinished = new Date(Date.UTC(2024, 0, 1, 0, 0, 0, 0)).toISOString();
    const codeStarted = new Date(Date.UTC(2024, 0, 1, 0, 0, 5, 0)).toISOString();
    await insertStage(run_id, "spec", { status: "passed", finished_at: specFinished });
    const code_id = await insertStage(run_id, "code", { started_at: codeStarted });
    const attempt_id = await setupPassableCodeStage(run_id, code_id);

    const readiness = runs.getStageFinalizeReadiness(code_id, attempt_id);
    const blocker = readiness.blockers.find(b => b.gate === "plan_first");
    assert.equal(blocker, undefined, "prior passed spec must clear the plan-first gate");
    assert.equal(readiness.can_pass, true);
  });

  it("2. standard scope + no planning stage -> blocked, next_action literal, finalizeStage throws PlanFirstGateViolation", async () => {
    const runs = await getRuns();
    const run_id = await insertRun({ taxonomy_mapping_json: taxonomyMapping("standard") });
    const code_id = await insertStage(run_id, "code");
    const attempt_id = await setupPassableCodeStage(run_id, code_id);

    const readiness = runs.getStageFinalizeReadiness(code_id, attempt_id);
    assert.equal(readiness.can_pass, false);
    const blocker = readiness.blockers.find(b => b.gate === "plan_first");
    assert.ok(blocker, "plan_first blocker must be present");
    assert.equal(blocker.next_action, "pass_planning_stage");
    assert.equal(readiness.next_action, "pass_planning_stage",
      "plan_first must surface as the readiness-level next_action (first blocker)");

    let threw = false;
    try {
      await runs.finalizeStage({ stage_id: code_id, winner_attempt_id: attempt_id, status: "passed" });
    } catch (err) {
      threw = true;
      assert.equal(err.name, "PlanFirstGateViolation",
        `expected PlanFirstGateViolation, got ${err.name}: ${err.message}`);
    }
    assert.ok(threw, "finalizeStage(passed) must throw PlanFirstGateViolation");
  });

  it("3. major scope + prior spec stage surfaced (not passed) -> blocked", async () => {
    const runs = await getRuns();
    const run_id = await insertRun({ taxonomy_mapping_json: taxonomyMapping("major") });
    await insertStage(run_id, "spec", { status: "surfaced", finished_at: new Date().toISOString() });
    const code_id = await insertStage(run_id, "code");
    const attempt_id = await setupPassableCodeStage(run_id, code_id);

    const readiness = runs.getStageFinalizeReadiness(code_id, attempt_id);
    assert.equal(readiness.can_pass, false);
    const blocker = readiness.blockers.find(b => b.gate === "plan_first");
    assert.ok(blocker, "a surfaced (not passed) spec stage must not clear the gate");
  });

  it("4. spec stage started AFTER the code stage -> blocked", async () => {
    const runs = await getRuns();
    const run_id = await insertRun({ taxonomy_mapping_json: taxonomyMapping("standard") });
    // Explicit, fixed timestamps (seconds apart, not derived from a live
    // clock read) -- a live `new Date().toISOString()` finished_at raced
    // against nextStartedAt()'s monotonic-but-can-run-ahead-of-wall-clock
    // counter on a coarse (~15.6ms) Windows clock, which could land the
    // spec's finished_at at or before the code stage's started_at even
    // though the spec was genuinely inserted afterward. Fixed values with a
    // multi-second margin remove the race entirely.
    const codeStarted = new Date(Date.UTC(2024, 0, 1, 0, 0, 0, 0)).toISOString();
    const specStarted = new Date(Date.UTC(2024, 0, 1, 0, 0, 5, 0)).toISOString();
    const specFinished = new Date(Date.UTC(2024, 0, 1, 0, 0, 10, 0)).toISOString();
    const code_id = await insertStage(run_id, "code", { started_at: codeStarted });
    // spec started after code -- must not count.
    await insertStage(run_id, "spec", { status: "passed", started_at: specStarted, finished_at: specFinished });
    const attempt_id = await setupPassableCodeStage(run_id, code_id);

    const readiness = runs.getStageFinalizeReadiness(code_id, attempt_id);
    assert.equal(readiness.can_pass, false);
    const blocker = readiness.blockers.find(b => b.gate === "plan_first");
    assert.ok(blocker, "a spec stage started after the code stage must not clear the gate");
  });

  it("5. trivial scope -> allowed (gate does not apply)", async () => {
    const runs = await getRuns();
    const run_id = await insertRun({ taxonomy_mapping_json: taxonomyMapping("trivial") });
    const code_id = await insertStage(run_id, "code");
    const attempt_id = await setupPassableCodeStage(run_id, code_id);

    const readiness = runs.getStageFinalizeReadiness(code_id, attempt_id);
    const blocker = readiness.blockers.find(b => b.gate === "plan_first");
    assert.equal(blocker, undefined, "trivial scope must not trigger the plan-first gate");
    assert.equal(readiness.can_pass, true);
  });

  it("6. no taxonomy mapping recorded -> allowed (Hydra-driven attended runs never record one)", async () => {
    const runs = await getRuns();
    const run_id = await insertRun(); // no taxonomy_mapping_json
    const code_id = await insertStage(run_id, "code");
    const attempt_id = await setupPassableCodeStage(run_id, code_id);

    const readiness = runs.getStageFinalizeReadiness(code_id, attempt_id);
    const blocker = readiness.blockers.find(b => b.gate === "plan_first");
    assert.equal(blocker, undefined, "no mapping must not trigger the plan-first gate");
    assert.equal(readiness.can_pass, true);
  });

  it("7. malformed mapping JSON -> allowed (fail-open, not fail-closed)", async () => {
    const runs = await getRuns();
    const db = await getDb();
    const run_id = await insertRun();
    db().prepare(`UPDATE runs SET taxonomy_mapping_json = '{BROKEN' WHERE id = ?`).run(run_id);
    const code_id = await insertStage(run_id, "code");
    const attempt_id = await setupPassableCodeStage(run_id, code_id);

    const readiness = runs.getStageFinalizeReadiness(code_id, attempt_id);
    const blocker = readiness.blockers.find(b => b.gate === "plan_first");
    assert.equal(blocker, undefined, "malformed mapping JSON must not trigger the plan-first gate");
    assert.equal(readiness.can_pass, true);
  });

  it("8. finalizeStage with status='surfaced' -> always allowed even with no planning stage", async () => {
    const runs = await getRuns();
    const run_id = await insertRun({ taxonomy_mapping_json: taxonomyMapping("major") });
    const code_id = await insertStage(run_id, "code");

    // No winner/verdict/smoke scaffolding needed -- surfaced bypasses all gates.
    await runs.finalizeStage({ stage_id: code_id, status: "surfaced" });
    const db = await getDb();
    const row = db().prepare(`SELECT status FROM stages WHERE id = ?`).get(code_id);
    assert.equal(row.status, "surfaced");
  });

  it("9. non-code stage kinds are unaffected by the plan-first gate", async () => {
    const runs = await getRuns();
    const run_id = await insertRun({ taxonomy_mapping_json: taxonomyMapping("major") });
    const spec_id = await insertStage(run_id, "spec");
    // No earlier planning stage exists at all -- but 'spec' itself is not gated.
    const readiness = runs.getStageFinalizeReadiness(spec_id);
    const blocker = readiness.blockers.find(b => b.gate === "plan_first");
    assert.equal(blocker, undefined, "non-code stage kinds must not trigger the plan-first gate");
  });

  it("10a. standard + prior passed repro (bug-fix shape) -> allowed", async () => {
    const runs = await getRuns();
    const run_id = await insertRun({ taxonomy_mapping_json: taxonomyMapping("standard") });
    // Explicit, fixed timestamps -- see test 1's comment for why a live
    // finished_at raced against the default nextStartedAt() is unsafe here.
    const reproFinished = new Date(Date.UTC(2024, 0, 1, 0, 0, 0, 0)).toISOString();
    const codeStarted = new Date(Date.UTC(2024, 0, 1, 0, 0, 5, 0)).toISOString();
    await insertStage(run_id, "repro", { status: "passed", finished_at: reproFinished });
    const code_id = await insertStage(run_id, "code", { started_at: codeStarted });
    const attempt_id = await setupPassableCodeStage(run_id, code_id);

    const readiness = runs.getStageFinalizeReadiness(code_id, attempt_id);
    const blocker = readiness.blockers.find(b => b.gate === "plan_first");
    assert.equal(blocker, undefined, "prior passed repro (bug-fix-team shape) must clear the gate");
  });

  it("10b. standard + prior passed invariants (refactor shape) -> allowed", async () => {
    const runs = await getRuns();
    const run_id = await insertRun({ taxonomy_mapping_json: taxonomyMapping("standard") });
    // Explicit, fixed timestamps -- see test 1's comment for why a live
    // finished_at raced against the default nextStartedAt() is unsafe here.
    const invariantsFinished = new Date(Date.UTC(2024, 0, 1, 0, 0, 0, 0)).toISOString();
    const codeStarted = new Date(Date.UTC(2024, 0, 1, 0, 0, 5, 0)).toISOString();
    await insertStage(run_id, "invariants", { status: "passed", finished_at: invariantsFinished });
    const code_id = await insertStage(run_id, "code", { started_at: codeStarted });
    const attempt_id = await setupPassableCodeStage(run_id, code_id);

    const readiness = runs.getStageFinalizeReadiness(code_id, attempt_id);
    const blocker = readiness.blockers.find(b => b.gate === "plan_first");
    assert.equal(blocker, undefined, "prior passed invariants (refactor-team shape) must clear the gate");
  });

  it("11. every team yaml with a 'code' stage lists a PLAN_FIRST_STAGE_KINDS stage before its first code stage", async () => {
    const { PLAN_FIRST_STAGE_KINDS } = await getPlanFirstGate();
    const planFirstSet = new Set(PLAN_FIRST_STAGE_KINDS);
    const teamsDir = join(REPO_ROOT, ".claude", "teams");
    const files = readdirSync(teamsDir).filter(f => f.endsWith(".yaml"));
    assert.ok(files.length > 0, "expected at least one team yaml");

    const offenders = [];
    for (const f of files) {
      const doc = YAML.parse(readFileSyncSafe(join(teamsDir, f)));
      const stages = doc?.stages ?? [];
      const kinds = stages.map(s => s.kind);
      const codeIdx = kinds.indexOf("code");
      if (codeIdx === -1) continue; // no code stage in this team, not applicable
      const priorKinds = kinds.slice(0, codeIdx);
      const hasPlanningStage = priorKinds.some(k => planFirstSet.has(k));
      if (!hasPlanningStage) offenders.push({ file: f, priorKinds });
    }
    assert.deepEqual(offenders, [],
      `teams with a code stage but no PLAN_FIRST_STAGE_KINDS predecessor: ${JSON.stringify(offenders)}`);
  });

  it("13. spec started before code but PASSED after code started -> blocked (P1a)", async () => {
    const runs = await getRuns();
    const run_id = await insertRun({ taxonomy_mapping_json: taxonomyMapping("standard") });
    // spec opens first...
    const spec_id = await insertStage(run_id, "spec", { status: "running" });
    // ...code opens while spec is still open...
    const code_id = await insertStage(run_id, "code");
    const attempt_id = await setupPassableCodeStage(run_id, code_id);
    // ...then spec passes AFTER code already started. finished_at is after
    // code's started_at, so it must not clear the gate even though spec
    // STARTED first.
    const db = await getDb();
    const codeRow = db().prepare(`SELECT started_at FROM stages WHERE id = ?`).get(code_id);
    const lateFinish = new Date(new Date(codeRow.started_at.replace(/\d{6}Z$/, "Z")).getTime() + 5000).toISOString();
    db().prepare(`UPDATE stages SET status = 'passed', finished_at = ? WHERE id = ?`).run(lateFinish, spec_id);

    const readiness = runs.getStageFinalizeReadiness(code_id, attempt_id);
    assert.equal(readiness.can_pass, false);
    const blocker = readiness.blockers.find(b => b.gate === "plan_first");
    assert.ok(blocker, "a planning stage that passed AFTER the code stage started must not clear the gate (P1a)");
  });

  it("14a. spec finished_at exactly equal to code started_at, spec inserted first -> blocked (strict comparison, no rowid tie-break)", async () => {
    // Regression for the unsound rowid tie-break: rowid records stage
    // INSERTion (start), not completion. Insertion order proves nothing
    // about which event -- spec's finish or code's start -- happened first
    // at millisecond resolution, so an exact-millisecond tie must BLOCK
    // regardless of which row was inserted first.
    const runs = await getRuns();
    const run_id = await insertRun({ taxonomy_mapping_json: taxonomyMapping("standard") });
    const tie = new Date().toISOString();
    // spec inserted first (lower rowid) -- must not matter anymore.
    const spec_id = await insertStage(run_id, "spec", { status: "passed", started_at: tie, finished_at: tie });
    const code_id = await insertStage(run_id, "code", { started_at: tie });
    const attempt_id = await setupPassableCodeStage(run_id, code_id);

    const readiness = runs.getStageFinalizeReadiness(code_id, attempt_id);
    assert.equal(readiness.can_pass, false);
    const blocker = readiness.blockers.find(b => b.gate === "plan_first");
    assert.ok(blocker,
      "spec finished_at == code started_at must BLOCK even when spec was inserted first (no rowid tie-break)");
  });

  it("14b. equal timestamps with CODE inserted first -> blocked (strict comparison)", async () => {
    const runs = await getRuns();
    const run_id = await insertRun({ taxonomy_mapping_json: taxonomyMapping("standard") });
    const tie = new Date().toISOString();
    // code inserted first (lower rowid) this time.
    const code_id = await insertStage(run_id, "code", { started_at: tie });
    const spec_id = await insertStage(run_id, "spec", { status: "passed", started_at: tie, finished_at: tie });
    const attempt_id = await setupPassableCodeStage(run_id, code_id);

    const readiness = runs.getStageFinalizeReadiness(code_id, attempt_id);
    assert.equal(readiness.can_pass, false);
    const blocker = readiness.blockers.find(b => b.gate === "plan_first");
    assert.ok(blocker, "spec finished_at == code started_at must not clear the gate");
  });

  it("15. identical started_at for spec and code, spec passed strictly before code start, spec inserted first -> allowed", async () => {
    const runs = await getRuns();
    const run_id = await insertRun({ taxonomy_mapping_json: taxonomyMapping("standard") });
    const sharedStart = new Date().toISOString();
    const earlierFinish = new Date(new Date(sharedStart).getTime() - 5000).toISOString();
    const spec_id = await insertStage(run_id, "spec", {
      status: "passed", started_at: sharedStart, finished_at: earlierFinish,
    });
    const code_id = await insertStage(run_id, "code", { started_at: sharedStart });
    const attempt_id = await setupPassableCodeStage(run_id, code_id);

    const readiness = runs.getStageFinalizeReadiness(code_id, attempt_id);
    const blocker = readiness.blockers.find(b => b.gate === "plan_first");
    assert.equal(blocker, undefined,
      "spec finished strictly before code's started_at must clear the gate regardless of matching started_at");
    assert.equal(readiness.can_pass, true);
  });

  it("16a. spec passed, then re-finalized to surfaced -> blocked", async () => {
    const runs = await getRuns();
    const run_id = await insertRun({ taxonomy_mapping_json: taxonomyMapping("standard") });
    // Explicit, fixed timestamps -- see test 1's comment for why a live
    // finished_at raced against the default nextStartedAt() is unsafe here.
    const specFinished = new Date(Date.UTC(2024, 0, 1, 0, 0, 0, 0)).toISOString();
    const codeStarted = new Date(Date.UTC(2024, 0, 1, 0, 0, 5, 0)).toISOString();
    const spec_id = await insertStage(run_id, "spec", { status: "passed", finished_at: specFinished });
    const code_id = await insertStage(run_id, "code", { started_at: codeStarted });
    const attempt_id = await setupPassableCodeStage(run_id, code_id);

    // Sanity: currently allowed.
    let readiness = runs.getStageFinalizeReadiness(code_id, attempt_id);
    assert.equal(readiness.blockers.find(b => b.gate === "plan_first"), undefined);

    // Re-finalize (re-opened) the planning stage to 'surfaced'.
    const db = await getDb();
    db().prepare(`UPDATE stages SET status = 'surfaced' WHERE id = ?`).run(spec_id);

    readiness = runs.getStageFinalizeReadiness(code_id, attempt_id);
    assert.equal(readiness.can_pass, false);
    const blocker = readiness.blockers.find(b => b.gate === "plan_first");
    assert.ok(blocker, "a planning stage re-finalized away from 'passed' must no longer clear the gate");
  });

  it("16b. spec re-finalized passed with a finished_at LATER than code started_at -> blocked", async () => {
    const runs = await getRuns();
    const run_id = await insertRun({ taxonomy_mapping_json: taxonomyMapping("standard") });
    // Explicit, fixed timestamps -- see test 1's comment for why a live
    // finished_at raced against the default nextStartedAt() is unsafe here.
    const specFinished = new Date(Date.UTC(2024, 0, 1, 0, 0, 0, 0)).toISOString();
    const codeStarted = new Date(Date.UTC(2024, 0, 1, 0, 0, 5, 0)).toISOString();
    const spec_id = await insertStage(run_id, "spec", { status: "passed", finished_at: specFinished });
    const code_id = await insertStage(run_id, "code", { started_at: codeStarted });
    const attempt_id = await setupPassableCodeStage(run_id, code_id);

    let readiness = runs.getStageFinalizeReadiness(code_id, attempt_id);
    assert.equal(readiness.blockers.find(b => b.gate === "plan_first"), undefined);

    const db = await getDb();
    const codeRow = db().prepare(`SELECT started_at FROM stages WHERE id = ?`).get(code_id);
    const laterFinish = new Date(new Date(codeRow.started_at.replace(/\d{6}Z$/, "Z")).getTime() + 60000).toISOString();
    db().prepare(`UPDATE stages SET status = 'passed', finished_at = ? WHERE id = ?`).run(laterFinish, spec_id);

    readiness = runs.getStageFinalizeReadiness(code_id, attempt_id);
    assert.equal(readiness.can_pass, false);
    const blocker = readiness.blockers.find(b => b.gate === "plan_first");
    assert.ok(blocker, "a re-finalized-passed planning stage with a later finished_at must not clear the gate");
  });

  it("17. record mapping trivial, open a stage, then record standard -> rejected; gate still reads trivial (allowed)", async () => {
    const runs = await getRuns();
    const run_id = await insertRun();
    await runs.recordTaxonomyMapping({
      run_id, scope: "trivial", signals: [], sections: [], missability_required: [],
    });
    const code_id = await insertStage(run_id, "code");
    const attempt_id = await setupPassableCodeStage(run_id, code_id);

    let threw = false;
    try {
      await runs.recordTaxonomyMapping({
        run_id, scope: "standard", signals: ["x"], sections: [], missability_required: [],
      });
    } catch (err) {
      threw = true;
      assert.equal(err.name, "TaxonomyMappingFrozenError",
        `expected TaxonomyMappingFrozenError, got ${err.name}: ${err.message}`);
    }
    assert.ok(threw, "recording a different scope after stages exist must be rejected");

    // Gate still reads the original 'trivial' scope -> gate does not apply.
    const readiness = runs.getStageFinalizeReadiness(code_id, attempt_id);
    const blocker = readiness.blockers.find(b => b.gate === "plan_first");
    assert.equal(blocker, undefined, "rejected re-record must not have mutated the recorded scope");
    assert.equal(readiness.can_pass, true);
  });

  it("18. no mapping, open a stage, then record major -> rejected", async () => {
    const runs = await getRuns();
    const run_id = await insertRun(); // no taxonomy_mapping_json
    const code_id = await insertStage(run_id, "code");
    await setupPassableCodeStage(run_id, code_id);

    let threw = false;
    try {
      await runs.recordTaxonomyMapping({
        run_id, scope: "major", signals: [], sections: [], missability_required: [],
      });
    } catch (err) {
      threw = true;
      assert.equal(err.name, "TaxonomyMappingFrozenError",
        `expected TaxonomyMappingFrozenError, got ${err.name}: ${err.message}`);
    }
    assert.ok(threw, "establishing a first mapping after stages exist must be rejected");
  });

  it("19. mapping standard, open a stage, re-record standard with different signals -> allowed", async () => {
    const runs = await getRuns();
    const run_id = await insertRun();
    await runs.recordTaxonomyMapping({
      run_id, scope: "standard", signals: ["a"], sections: [], missability_required: [],
    });
    const code_id = await insertStage(run_id, "code");
    await setupPassableCodeStage(run_id, code_id);

    // Idempotent re-record of the SAME scope, different other fields, must succeed.
    const result = await runs.recordTaxonomyMapping({
      run_id, scope: "standard", signals: ["a", "b"], sections: [], missability_required: ["ownership_docs"],
    });
    assert.deepEqual(result, { ok: true });

    const db = await getDb();
    const row = db().prepare(`SELECT taxonomy_mapping_json FROM runs WHERE id = ?`).get(run_id);
    const parsed = JSON.parse(row.taxonomy_mapping_json);
    assert.deepEqual(parsed.signals, ["a", "b"], "other fields must update on same-scope re-record");
    assert.deepEqual(parsed.missability_required, ["ownership_docs"]);
  });

  it("20. best-of run (mode='best_of', standard scope) with only a code stage opened via startBestOfStage -> finalize passed succeeds (operator-decided exemption)", async () => {
    const runs = await getRuns();
    const bestOfN = await getBestOfN();
    const db = await getDb();

    // Best-of candidates use `git worktree add` (not a plain recursive copy)
    // when the project is a real git repo. A plain-directory project would
    // hit a Windows cpSync self-subdirectory error here, since the candidate
    // dirs live under <project>/.harness/<run_id>/code/candidate-N -- a git
    // repo avoids that path entirely.
    const project = mkdtempSync(join(tmpdir(), "pp-pfg-bestof-"));
    mkdirSync(join(project, ".harness"), { recursive: true });
    writeFileSync(join(project, "AGENTS.md"), "# AGENTS\n", "utf8");
    execFileSync("git", ["init", "-q"], { cwd: project, windowsHide: true });
    execFileSync("git", ["-c", "user.email=test@pp", "-c", "user.name=pp-test", "add", "-A"], { cwd: project, windowsHide: true });
    execFileSync("git", ["-c", "user.email=test@pp", "-c", "user.name=pp-test", "commit", "-q", "-m", "init"], { cwd: project, windowsHide: true });

    const started = await runs.startRun({
      request_text: "best-of exemption test", project_path: project, mode: "best_of", n: 2,
    });
    const run_id = started.run_id;

    // Best-of runs DO record a taxonomy mapping (best-of.md step 3) — record
    // 'standard' so this test actually exercises the exemption rather than
    // relying on scope being absent.
    await runs.recordTaxonomyMapping({
      run_id, scope: "standard", signals: [], sections: [], missability_required: [],
    });

    const prevEnv = process.env.PP_ALLOW_BEST_OF_WITHOUT_JUDGE;
    process.env.PP_ALLOW_BEST_OF_WITHOUT_JUDGE = "1"; // isolate from real vendor CLIs in CI
    let stage_id, candidates;
    try {
      const opened = await bestOfN.startBestOfStage({ run_id, kind: "code", gate_type: "code_style", n: 2 });
      stage_id = opened.stage_id;
      candidates = opened.candidates;
    } finally {
      if (prevEnv === undefined) delete process.env.PP_ALLOW_BEST_OF_WITHOUT_JUDGE;
      else process.env.PP_ALLOW_BEST_OF_WITHOUT_JUDGE = prevEnv;
    }

    // startBestOfStage opens the stage as 'open' with started_at set; move it
    // to 'running' state semantics are irrelevant here -- what matters is
    // that ONLY this code stage exists in the run (no planning predecessor).
    const attempt_id = await insertAttempt(stage_id, { notes_json: JSON.stringify({ candidate_index: candidates[0].candidate_index }) });
    await insertVerdict(attempt_id, { outcome: "pass" });
    // Merge smoke_results into the existing notes_json (which already carries
    // the best_of.candidate_paths block) rather than overwriting it.
    const row = db().prepare(`SELECT notes_json FROM stages WHERE id = ?`).get(stage_id);
    const notes = JSON.parse(row.notes_json);
    notes.smoke_results = { [String(candidates[0].candidate_index)]: { status: "pass", reason: null, recorded_at: new Date().toISOString() } };
    db().prepare(`UPDATE stages SET notes_json = ? WHERE id = ?`).run(JSON.stringify(notes), stage_id);

    const readiness = runs.getStageFinalizeReadiness(stage_id, attempt_id);
    const blocker = readiness.blockers.find(b => b.gate === "plan_first");
    assert.equal(blocker, undefined, "best_of-mode run must be exempt from the plan-first gate");
    assert.equal(readiness.can_pass, true);

    await runs.finalizeStage({ stage_id, winner_attempt_id: attempt_id, status: "passed" });
    const stageRow = db().prepare(`SELECT status FROM stages WHERE id = ?`).get(stage_id);
    assert.equal(stageRow.status, "passed", "finalizeStage(passed) must succeed for a best_of-mode run with only a code stage");
  });

  it("21. single run (mode='single') at standard scope via the public lifecycle: spec finalized passed, code started strictly later -> code passes", async () => {
    const runs = await getRuns();
    const started = await runs.startRun({ request_text: "public-lifecycle ordering test", project_path: SHARED_PROJECT, mode: "single" });
    const run_id = started.run_id;
    await runs.recordTaxonomyMapping({ run_id, scope: "standard", signals: [], sections: [], missability_required: [] });

    const spec_id = runs.startStage({ run_id, kind: "spec", gate_type: "spec" }).stage_id;
    const specAttempt = await insertAttempt(spec_id);
    await insertVerdict(specAttempt, { outcome: "pass" });
    await runs.finalizeStage({ stage_id: spec_id, winner_attempt_id: specAttempt, status: "passed" });

    // Ensure the next stage's started_at is a genuinely later millisecond
    // before opening it, per the task's instruction.
    const specFinishedRow = (await getDb())().prepare(`SELECT finished_at FROM stages WHERE id = ?`).get(spec_id);
    const specMs = new Date(specFinishedRow.finished_at).getTime();
    while (Date.now() <= specMs) { /* busy-wait a tick */ }

    const code_id = runs.startStage({ run_id, kind: "code", gate_type: "code_style" }).stage_id;
    const attempt_id = await setupPassableCodeStage(run_id, code_id);

    const readiness = runs.getStageFinalizeReadiness(code_id, attempt_id);
    const blocker = readiness.blockers.find(b => b.gate === "plan_first");
    assert.equal(blocker, undefined, "spec finalized strictly before code's started_at (public lifecycle) must clear the gate");
    assert.equal(readiness.can_pass, true);

    await runs.finalizeStage({ stage_id: code_id, winner_attempt_id: attempt_id, status: "passed" });
    const db = await getDb();
    const row = db().prepare(`SELECT status FROM stages WHERE id = ?`).get(code_id);
    assert.equal(row.status, "passed");
  });

  it("22. equal-millisecond timestamps (no insertion-order tie-break) -> blocked regardless of which row was inserted first", async () => {
    const runs = await getRuns();
    const run_id = await insertRun({ taxonomy_mapping_json: taxonomyMapping("standard") });
    const tie = new Date().toISOString();
    const spec_id = await insertStage(run_id, "spec", { status: "passed", started_at: tie, finished_at: tie });
    const code_id = await insertStage(run_id, "code", { started_at: tie });
    const attempt_id = await setupPassableCodeStage(run_id, code_id);

    const readiness = runs.getStageFinalizeReadiness(code_id, attempt_id);
    assert.equal(readiness.can_pass, false);
    const blocker = readiness.blockers.find(b => b.gate === "plan_first");
    assert.ok(blocker, "exact-millisecond tie must BLOCK -- there is no rowid tie-break to resolve it");
  });

  it("23. a passed planning stage with finished_at NULL does not count -> blocked", async () => {
    const runs = await getRuns();
    const db = await getDb();
    const run_id = await insertRun({ taxonomy_mapping_json: taxonomyMapping("standard") });
    const spec_id = await insertStage(run_id, "spec", { status: "running" });
    // Force status='passed' while leaving finished_at NULL -- simulates a
    // caller mutating status directly without going through finalizeStage.
    db().prepare(`UPDATE stages SET status = 'passed' WHERE id = ?`).run(spec_id);
    const specRow = db().prepare(`SELECT finished_at FROM stages WHERE id = ?`).get(spec_id);
    assert.equal(specRow.finished_at, null, "fixture precondition: finished_at must be NULL");

    const code_id = await insertStage(run_id, "code");
    const attempt_id = await setupPassableCodeStage(run_id, code_id);

    const readiness = runs.getStageFinalizeReadiness(code_id, attempt_id);
    assert.equal(readiness.can_pass, false);
    const blocker = readiness.blockers.find(b => b.gate === "plan_first");
    assert.ok(blocker, "a passed planning stage with finished_at NULL must never count");
  });

  it("24. a passed spec stage in a DIFFERENT run of the same project_path does not count -> blocked", async () => {
    const runs = await getRuns();
    const other_run_id = await insertRun({ project_path: SHARED_PROJECT, taxonomy_mapping_json: taxonomyMapping("standard") });
    await insertStage(other_run_id, "spec", { status: "passed", finished_at: new Date().toISOString() });

    // A distinct run, same project_path, with no planning stage of its own.
    const run_id = await insertRun({ project_path: SHARED_PROJECT, taxonomy_mapping_json: taxonomyMapping("standard") });
    const code_id = await insertStage(run_id, "code");
    const attempt_id = await setupPassableCodeStage(run_id, code_id);

    const readiness = runs.getStageFinalizeReadiness(code_id, attempt_id);
    assert.equal(readiness.can_pass, false);
    const blocker = readiness.blockers.find(b => b.gate === "plan_first");
    assert.ok(blocker, "a passed planning stage in a different run must not clear this run's gate, even for the same project_path");
  });

  it("25. no review forum defines a 'code'-kind stage, so the plan-first gate structurally never engages in review mode", async () => {
    // Audit finding: /pp:review (mode='review') stages come from forums.ts,
    // none of which lists kind='code' (governance forums produce docs/specs/
    // designs, not application code). getStageFinalizeReadiness's plan-first
    // block is gated on `stageRow.kind === "code"`, so review-mode stages are
    // structurally never in scope -- this is a property of the forum
    // definitions, not a special-case in the gate itself. Regression-guard
    // this so a future forum can't silently reintroduce a code stage without
    // an explicit decision about plan-first exemption/compliance.
    const runs = await getRuns();
    const { FORUMS } = await getForums();
    const offenders = [];
    for (const forum of FORUMS) {
      for (const stage of forum.stages) {
        if (stage.kind === "code") offenders.push({ forum: forum.id, kind: stage.kind });
      }
    }
    assert.deepEqual(offenders, [],
      `review forums must not define a 'code'-kind stage without an explicit plan-first decision: ${JSON.stringify(offenders)}`);

    // Belt-and-suspenders: even if a review-mode run's taxonomy mapping
    // resolves to 'standard'/'major', a non-code stage kind never enters the
    // plan_first branch of getStageFinalizeReadiness at all.
    const run_id = await insertRun({ taxonomy_mapping_json: taxonomyMapping("major") });
    const docs_id = await insertStage(run_id, "problem_statement");
    const readiness = runs.getStageFinalizeReadiness(docs_id);
    const blocker = readiness.blockers.find(b => b.gate === "plan_first");
    assert.equal(blocker, undefined, "non-'code' stage kinds (all review-forum kinds) are never in scope for the plan-first gate");
  });

  it("12. get_stage_finalize_readiness (the exported function the MCP handler calls) reports the plan_first blocker", async () => {
    // harness-server.ts's get_stage_finalize_readiness tool handler is a thin
    // pass-through: `(args) => getStageFinalizeReadiness(p.stage_id, p.winner_attempt_id)`.
    // No MCP-layer logic exists to duplicate the gate in, so calling the
    // exported function it invokes proves the MCP layer needs no change.
    const runs = await getRuns();
    const run_id = await insertRun({ taxonomy_mapping_json: taxonomyMapping("major") });
    const code_id = await insertStage(run_id, "code");
    const attempt_id = await setupPassableCodeStage(run_id, code_id);

    const readiness = runs.getStageFinalizeReadiness(code_id, attempt_id);
    assert.equal(readiness.can_pass, false);
    const blocker = readiness.blockers.find(b => b.gate === "plan_first");
    assert.ok(blocker, "MCP-layer-equivalent call must surface the plan_first blocker");
  });

});

function readFileSyncSafe(p) {
  return readFileSync(p, "utf8");
}
