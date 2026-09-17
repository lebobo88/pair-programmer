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

let _stageCounter = 0;
/** started_at is monotonically increasing across calls (even within the same ms). */
function nextStartedAt() {
  _stageCounter += 1;
  const base = Date.now();
  return new Date(base).toISOString().replace("Z", `${String(_stageCounter).padStart(6, "0")}Z`);
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
    await insertStage(run_id, "spec", { status: "passed", finished_at: new Date().toISOString() });
    const code_id = await insertStage(run_id, "code");
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
    const code_id = await insertStage(run_id, "code");
    // spec started after code -- must not count.
    await insertStage(run_id, "spec", { status: "passed", finished_at: new Date().toISOString() });
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
    await insertStage(run_id, "repro", { status: "passed", finished_at: new Date().toISOString() });
    const code_id = await insertStage(run_id, "code");
    const attempt_id = await setupPassableCodeStage(run_id, code_id);

    const readiness = runs.getStageFinalizeReadiness(code_id, attempt_id);
    const blocker = readiness.blockers.find(b => b.gate === "plan_first");
    assert.equal(blocker, undefined, "prior passed repro (bug-fix-team shape) must clear the gate");
  });

  it("10b. standard + prior passed invariants (refactor shape) -> allowed", async () => {
    const runs = await getRuns();
    const run_id = await insertRun({ taxonomy_mapping_json: taxonomyMapping("standard") });
    await insertStage(run_id, "invariants", { status: "passed", finished_at: new Date().toISOString() });
    const code_id = await insertStage(run_id, "code");
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
