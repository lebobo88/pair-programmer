/**
 * finalize-gates-b.unit.mjs
 *
 * Self-contained unit tests for two finalize gates:
 *   VG-4: finalizeRun(complete) blocked when a REQUIRED missability check has
 *         status='fail'; required set is the UNION of profile/team/forum;
 *         advisory (non-required) fails do NOT block; malformed required-source
 *         -> fail-closed; missing check row -> treated as fail.
 *   VG-6: getStageFinalizeReadiness blocked when a non-retracted verdict has
 *         hallucination_suspected=1 and no cross-vendor resolution exists;
 *         a cross_vendor=1 pass on the SAME attempt clears it; a same-vendor
 *         clean verdict does NOT clear it; retracted suspect -> not blocked.
 *
 * Anti-stall contract:
 *   - Uses a temp sqlite DB (PP_HOME override), direct dist function calls.
 *   - No MCP server, no daemon socket, no smoke files touched.
 *   - Run: timeout 90 node --test test/finalize-gates-b.unit.mjs
 *
 * Performance: each test provisions a fresh project so rows don't collide.
 * startRun is ~5-8s/call due to eights-daemon boot + git commands. To stay
 * under 90 seconds we minimise calls to startRun by sharing the DB and
 * inserting run/stage rows directly via SQL for most tests.
 */

import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import assert from "node:assert/strict";
import { describe, it, before } from "node:test";

// Set PP_HOME BEFORE any dist import so the DB is isolated.
const SUITE_DIR = mkdtempSync(join(tmpdir(), "pp-finalize-gates-b-"));
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

// ── Shared project directory (re-used across tests) ───────────────────────────
// All tests share one project dir and one DB to avoid the 5-8s startRun
// overhead per test. Each test creates its own run rows directly via SQL
// except the few that need a fully-initialised run.

const SHARED_PROJECT = mkdtempSync(join(tmpdir(), "pp-fgb-shared-"));
mkdirSync(join(SHARED_PROJECT, ".harness"), { recursive: true });
writeFileSync(join(SHARED_PROJECT, "AGENTS.md"), "# AGENTS\n", "utf8");

/** Insert a bare run row directly (no file I/O, no git, no eights). */
async function insertRun(overrides = {}) {
  const db = await getDb();
  const id = `run_fgb_${Math.random().toString(36).slice(2, 12)}`;
  const now = new Date().toISOString();
  db().prepare(
    `INSERT INTO runs(id, project_path, request_text, mode, team, forum, status,
        profile_snapshot_json, taxonomy_mapping_json, started_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    SHARED_PROJECT,
    "finalize-gates-b test",
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

/** Insert a bare stage row directly. */
async function insertStage(run_id, kind = "code") {
  const db = await getDb();
  const id = `stage_fgb_${Math.random().toString(36).slice(2, 12)}`;
  const now = new Date().toISOString();
  db().prepare(
    `INSERT INTO stages(id, run_id, kind, gate_type, status, started_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(id, run_id, kind, kind, "running", now);
  return id;
}

/** Insert a missability_checks row. */
async function insertMissabilityCheck(run_id, check_id, status, offsetMs = 0) {
  const db = await getDb();
  const id = `mc_fgb_${Math.random().toString(36).slice(2, 10)}`;
  const ts = new Date(Date.now() + offsetMs).toISOString();
  db().prepare(
    `INSERT INTO missability_checks(id, run_id, check_id, status, evidence_path, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(id, run_id, check_id, status, null, ts);
  return id;
}

/** Insert a verdict row directly (hallucination_suspected is not exposed by recordVerdict). */
async function insertVerdict(attempt_id, { cross_vendor = 0, hallucination_suspected = 0, outcome = "pass", judge_producer = "claude", judge_model_id = "claude-sonnet-4-6", retracted = false, offsetMs = 0 } = {}) {
  const db = await getDb();
  const id = `verdict_fgb_${Math.random().toString(36).slice(2, 10)}`;
  const ts = new Date(Date.now() + offsetMs).toISOString();
  const retractedAt = retracted ? ts : null;
  db().prepare(
    `INSERT INTO verdicts(id, attempt_id, judge_producer, judge_model_id, outcome,
       cross_vendor, hallucination_suspected, retracted_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(id, attempt_id, judge_producer, judge_model_id, outcome, cross_vendor ? 1 : 0, hallucination_suspected ? 1 : 0, retractedAt, ts);
  return id;
}

/** Insert an attempt row directly. */
async function insertAttempt(stage_id, { producer = "claude", model_id = "claude-sonnet-4-6", status = "ok" } = {}) {
  const db = await getDb();
  const id = `attempt_fgb_${Math.random().toString(36).slice(2, 10)}`;
  const now = new Date().toISOString();
  db().prepare(
    `INSERT INTO attempts(id, stage_id, producer, model_id, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(id, stage_id, producer, model_id, status, now);
  return id;
}

// ─── VG-4 ──────────────────────────────────────────────────────────────────
describe("VG-4: missability gate", () => {

  it("required check (from profile) with status=fail -> blocks finalizeRun(complete)", async () => {
    const runs = await getRuns();
    const run_id = await insertRun({
      profile_snapshot_json: JSON.stringify({
        name: "web-ui",
        description: "test",
        required_missability_checks: ["nfrs-declared"],
      }),
    });
    await insertMissabilityCheck(run_id, "nfrs-declared", "fail");

    let threw = false;
    try {
      runs.finalizeRun({ run_id, status: "complete" });
    } catch (err) {
      threw = true;
      assert.equal(err.name, "MissabilityGateViolation", `expected MissabilityGateViolation, got ${err.name}: ${err.message}`);
      assert.match(err.message, /PP-VG-4/);
      assert.match(err.message, /nfrs-declared/);
      assert.ok(Array.isArray(err.failed_required_check_ids));
      assert.ok(err.failed_required_check_ids.includes("nfrs-declared"));
    }
    assert.ok(threw, "must have thrown");
  });

  it("advisory (non-required) check with status=fail -> does NOT block", async () => {
    const runs = await getRuns();
    // No required_missability_checks in profile — decision-logging is advisory.
    const run_id = await insertRun({
      profile_snapshot_json: JSON.stringify({ name: "web-ui", description: "test" }),
    });
    await insertMissabilityCheck(run_id, "decision-logging", "fail");

    const result = runs.finalizeRun({ run_id, status: "complete" });
    assert.equal(result.effective_status, "complete", "advisory fail must not block");
  });

  it("required check with status=pass -> does NOT block", async () => {
    const runs = await getRuns();
    const run_id = await insertRun({
      profile_snapshot_json: JSON.stringify({
        name: "web-ui",
        description: "test",
        required_missability_checks: ["nfrs-declared"],
      }),
    });
    await insertMissabilityCheck(run_id, "nfrs-declared", "pass");

    const result = runs.finalizeRun({ run_id, status: "complete" });
    assert.equal(result.effective_status, "complete", "passing required check must not block");
  });

  it("required check (from team.missability_required) with status=fail -> blocks", async () => {
    const runs = await getRuns();
    // feature-team has missability_required: ["nfrs-declared", "decision-logging",
    //   "test-data-management", "browser-validation-evidence"]
    const run_id = await insertRun({ team: "feature-team" });
    await insertMissabilityCheck(run_id, "nfrs-declared", "fail");
    // Leave others without rows (treated as fail-closed = fail).

    let threw = false;
    try {
      runs.finalizeRun({ run_id, status: "complete" });
    } catch (err) {
      threw = true;
      assert.equal(err.name, "MissabilityGateViolation");
      assert.match(err.message, /PP-VG-4/);
      // nfrs-declared is required by feature-team and has status=fail
      assert.ok(err.failed_required_check_ids.includes("nfrs-declared"),
        `nfrs-declared must be in failed list; got: ${JSON.stringify(err.failed_required_check_ids)}`);
    }
    assert.ok(threw);
  });

  it("required check (from forum.required_missability_checks) with status=fail -> blocks", async () => {
    const runs = await getRuns();
    // 'framing' forum requires: ["decision-logging"]
    const run_id = await insertRun({ forum: "framing" });
    await insertMissabilityCheck(run_id, "decision-logging", "fail");

    let threw = false;
    try {
      runs.finalizeRun({ run_id, status: "complete" });
    } catch (err) {
      threw = true;
      assert.equal(err.name, "MissabilityGateViolation");
      assert.match(err.message, /PP-VG-4/);
      assert.ok(err.failed_required_check_ids.includes("decision-logging"));
    }
    assert.ok(threw);
  });

  it("union: required from profile AND team AND forum — all passing -> not blocked", async () => {
    const runs = await getRuns();
    // profile: nfrs-declared
    // feature-team: nfrs-declared, decision-logging, test-data-management, browser-validation-evidence
    // framing forum: decision-logging
    // union: nfrs-declared, decision-logging, test-data-management, browser-validation-evidence
    const run_id = await insertRun({
      profile_snapshot_json: JSON.stringify({
        name: "web-ui",
        description: "test",
        required_missability_checks: ["nfrs-declared"],
      }),
      team: "feature-team",
      forum: "framing",
    });
    // Pass all required checks.
    await insertMissabilityCheck(run_id, "nfrs-declared", "pass");
    await insertMissabilityCheck(run_id, "decision-logging", "pass");
    await insertMissabilityCheck(run_id, "test-data-management", "pass");
    await insertMissabilityCheck(run_id, "browser-validation-evidence", "pass");

    const result = runs.finalizeRun({ run_id, status: "complete" });
    assert.equal(result.effective_status, "complete", "all required checks passing must not block");
  });

  it("union: team-required check fails -> blocks even if profile check passes", async () => {
    const runs = await getRuns();
    // profile: nfrs-declared (pass), feature-team adds: decision-logging (fail)
    const run_id = await insertRun({
      profile_snapshot_json: JSON.stringify({
        name: "web-ui",
        description: "test",
        required_missability_checks: ["nfrs-declared"],
      }),
      team: "feature-team",
    });
    await insertMissabilityCheck(run_id, "nfrs-declared", "pass");
    await insertMissabilityCheck(run_id, "decision-logging", "fail");
    // test-data-management, browser-validation-evidence have no rows -> fail-closed

    let threw = false;
    try {
      runs.finalizeRun({ run_id, status: "complete" });
    } catch (err) {
      threw = true;
      assert.equal(err.name, "MissabilityGateViolation");
      assert.ok(err.failed_required_check_ids.includes("decision-logging"),
        "decision-logging must be in failed list");
    }
    assert.ok(threw);
  });

  it("malformed profile_snapshot_json -> fail-closed (VG-2 or VG-4 both block)", async () => {
    const runs = await getRuns();
    const db = await getDb();
    const run_id = await insertRun();
    db().prepare(`UPDATE runs SET profile_snapshot_json = '{broken' WHERE id = ?`).run(run_id);

    let threw = false;
    try {
      runs.finalizeRun({ run_id, status: "complete" });
    } catch (err) {
      threw = true;
      // VG-2 runs before VG-4 and also fail-closes on malformed profile_snapshot_json.
      // Either gate throwing is correct — both indicate fail-closed.
      const isExpected =
        err.name === "MissabilityGateViolation" ||
        err.name === "ArtifactAvailabilityGateViolation";
      assert.ok(isExpected, `expected VG-4 or VG-2 violation, got ${err.name}: ${err.message}`);
      assert.match(err.message, /profile_snapshot_json/);
    }
    assert.ok(threw, "malformed profile must throw a gate violation");
  });

  it("profile required_missability_checks not an array -> fail-closed (MissabilityGateViolation)", async () => {
    const runs = await getRuns();
    const run_id = await insertRun({
      profile_snapshot_json: JSON.stringify({
        name: "web-ui",
        description: "test",
        required_missability_checks: "nfrs-declared", // string, not array
      }),
    });

    let threw = false;
    try {
      runs.finalizeRun({ run_id, status: "complete" });
    } catch (err) {
      threw = true;
      assert.equal(err.name, "MissabilityGateViolation");
      assert.match(err.message, /PP-VG-4/);
    }
    assert.ok(threw);
  });

  it("unknown forum name -> fail-closed (MissabilityGateViolation)", async () => {
    const runs = await getRuns();
    const run_id = await insertRun({ forum: "no-such-forum" });

    let threw = false;
    try {
      runs.finalizeRun({ run_id, status: "complete" });
    } catch (err) {
      threw = true;
      assert.equal(err.name, "MissabilityGateViolation");
      assert.match(err.message, /PP-VG-4/);
      assert.match(err.message, /no-such-forum/);
    }
    assert.ok(threw);
  });

  it("finalizeRun(surfaced) with failing required check -> NOT blocked", async () => {
    const runs = await getRuns();
    const run_id = await insertRun({
      profile_snapshot_json: JSON.stringify({
        name: "web-ui",
        description: "test",
        required_missability_checks: ["nfrs-declared"],
      }),
    });
    await insertMissabilityCheck(run_id, "nfrs-declared", "fail");

    const result = runs.finalizeRun({ run_id, status: "surfaced" });
    assert.equal(result.effective_status, "surfaced", "surfaced must bypass VG-4");
  });

  it("latest row wins: fail then pass -> last row is pass -> NOT blocked", async () => {
    const runs = await getRuns();
    const run_id = await insertRun({
      profile_snapshot_json: JSON.stringify({
        name: "web-ui",
        description: "test",
        required_missability_checks: ["nfrs-declared"],
      }),
    });
    // Older fail row, then later pass row.
    await insertMissabilityCheck(run_id, "nfrs-declared", "fail", 0);
    await insertMissabilityCheck(run_id, "nfrs-declared", "pass", 1000);

    const result = runs.finalizeRun({ run_id, status: "complete" });
    assert.equal(result.effective_status, "complete", "latest pass row must clear the required check");
  });

});

// ─── VG-6 ──────────────────────────────────────────────────────────────────
describe("VG-6: hallucination gate", () => {

  it("suspect verdict (hallucination_suspected=1) with no cross-vendor resolution -> blocks", async () => {
    const runs = await getRuns();
    const run_id = await insertRun();
    const stage_id = await insertStage(run_id);
    const attempt_id = await insertAttempt(stage_id);

    await insertVerdict(attempt_id, { hallucination_suspected: 1, cross_vendor: 0 });

    const readiness = runs.getStageFinalizeReadiness(stage_id);
    assert.equal(readiness.can_pass, false, "hallucination blocker must prevent finalize_passed");
    const blocker = readiness.blockers.find(b => b.gate === "hallucination");
    assert.ok(blocker, "hallucination blocker must be present");
    assert.equal(blocker.next_action, "dispatch_cross_vendor_rejudge");
    assert.equal(blocker.attempt_id, attempt_id);
  });

  it("suspect cleared by a cross_vendor=1 pass on the SAME attempt -> not blocked", async () => {
    const runs = await getRuns();
    const run_id = await insertRun();
    const stage_id = await insertStage(run_id);
    const attempt_id = await insertAttempt(stage_id);

    // Suspect first.
    await insertVerdict(attempt_id, { hallucination_suspected: 1, cross_vendor: 0, offsetMs: 0 });
    // Cross-vendor non-fail verdict AFTER suspect.
    await insertVerdict(attempt_id, {
      hallucination_suspected: 0, cross_vendor: 1, outcome: "pass",
      judge_producer: "codex", judge_model_id: "gpt-5.4", offsetMs: 500,
    });

    const readiness = runs.getStageFinalizeReadiness(stage_id);
    const blocker = readiness.blockers.find(b => b.gate === "hallucination");
    assert.equal(blocker, undefined, "cross-vendor pass must clear hallucination blocker");
  });

  it("suspect followed by a clean SAME-vendor verdict only -> STILL blocked", async () => {
    const runs = await getRuns();
    const run_id = await insertRun();
    const stage_id = await insertStage(run_id);
    const attempt_id = await insertAttempt(stage_id);

    // Suspect first.
    await insertVerdict(attempt_id, { hallucination_suspected: 1, cross_vendor: 0, offsetMs: 0 });
    // Same-vendor clean verdict (cross_vendor=0) does NOT clear.
    await insertVerdict(attempt_id, {
      hallucination_suspected: 0, cross_vendor: 0, outcome: "pass",
      judge_producer: "claude", judge_model_id: "claude-opus-4-7", offsetMs: 500,
    });

    const readiness = runs.getStageFinalizeReadiness(stage_id);
    assert.equal(readiness.can_pass, false, "same-vendor clean verdict must NOT clear hallucination");
    const blocker = readiness.blockers.find(b => b.gate === "hallucination");
    assert.ok(blocker, "hallucination blocker must still be present after same-vendor clean");
  });

  it("retracted suspect verdict -> not blocked", async () => {
    const runs = await getRuns();
    const run_id = await insertRun();
    const stage_id = await insertStage(run_id);
    const attempt_id = await insertAttempt(stage_id);

    // Suspect verdict that is retracted.
    await insertVerdict(attempt_id, { hallucination_suspected: 1, cross_vendor: 0, retracted: true });

    const readiness = runs.getStageFinalizeReadiness(stage_id);
    const blocker = readiness.blockers.find(b => b.gate === "hallucination");
    assert.equal(blocker, undefined, "retracted suspect must not block finalize");
  });

  it("cross_vendor=1 but outcome=fail does NOT clear the suspect", async () => {
    const runs = await getRuns();
    const run_id = await insertRun();
    const stage_id = await insertStage(run_id);
    const attempt_id = await insertAttempt(stage_id);

    await insertVerdict(attempt_id, { hallucination_suspected: 1, cross_vendor: 0, offsetMs: 0 });
    // Cross-vendor verdict but outcome=fail.
    await insertVerdict(attempt_id, {
      hallucination_suspected: 0, cross_vendor: 1, outcome: "fail",
      judge_producer: "codex", judge_model_id: "gpt-5.4", offsetMs: 500,
    });

    const readiness = runs.getStageFinalizeReadiness(stage_id);
    assert.equal(readiness.can_pass, false, "cross-vendor fail must NOT clear hallucination");
    const blocker = readiness.blockers.find(b => b.gate === "hallucination");
    assert.ok(blocker, "hallucination blocker must still be present after cross-vendor fail");
  });

  it("no suspect verdicts at all -> not blocked by hallucination gate", async () => {
    const runs = await getRuns();
    const run_id = await insertRun();
    const stage_id = await insertStage(run_id);
    const attempt_id = await insertAttempt(stage_id);

    // Normal pass verdict, no hallucination_suspected.
    await insertVerdict(attempt_id, { hallucination_suspected: 0, cross_vendor: 0, outcome: "pass" });

    const readiness = runs.getStageFinalizeReadiness(stage_id);
    const blocker = readiness.blockers.find(b => b.gate === "hallucination");
    assert.equal(blocker, undefined, "no suspect verdicts must not trigger hallucination gate");
  });

  // Edge case #4: cross-vendor pass at the SAME created_at (same ms) as the suspect
  // but with a later rowid -> must clear (rowid tiebreak, not created_at).
  it("VG-6 edge #4: cross-vendor pass at same-ms as suspect (later rowid) -> cleared", async () => {
    const runs = await getRuns();
    const db = await getDb();
    const run_id = await insertRun();
    const stage_id = await insertStage(run_id);
    const attempt_id = await insertAttempt(stage_id);

    // Insert both verdicts with the SAME created_at to force an ms tie.
    const samets = new Date().toISOString();

    const suspectId = `verdict_sm1_${Math.random().toString(36).slice(2, 10)}`;
    db().prepare(
      `INSERT INTO verdicts(id, attempt_id, judge_producer, judge_model_id, outcome,
         cross_vendor, hallucination_suspected, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(suspectId, attempt_id, "claude", "claude-sonnet-4-6", "pass", 0, 1, samets);

    // Cross-vendor pass inserted AFTER (later rowid) at the same timestamp.
    const cvId = `verdict_sm2_${Math.random().toString(36).slice(2, 10)}`;
    db().prepare(
      `INSERT INTO verdicts(id, attempt_id, judge_producer, judge_model_id, outcome,
         cross_vendor, hallucination_suspected, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(cvId, attempt_id, "codex", "gpt-5.4", "pass", 1, 0, samets);

    const readiness = runs.getStageFinalizeReadiness(stage_id);
    const blocker = readiness.blockers.find(b => b.gate === "hallucination");
    assert.equal(blocker, undefined,
      "cross-vendor pass with later rowid at same ms must clear the suspect (rowid tiebreak)");
  });

});

// ─── VG-4 edge cases (issues #1, #2, #3) ──────────────────────────────────
describe("VG-4 edge cases", () => {

  // Issue #1a: team='ad-hoc' with NO ad-hoc.yaml anywhere -> sentinel exemption,
  // treated as no-team-source, NOT blocked.
  it("#1a: team='ad-hoc' with no ad-hoc.yaml -> NOT blocked (sentinel, no team source)", async () => {
    const runs = await getRuns();
    // Confirm no ad-hoc.yaml exists in the shared project before running.
    const adHocPath = join(SHARED_PROJECT, ".claude", "teams", "ad-hoc.yaml");
    try { rmSync(adHocPath); } catch { /* ok if absent */ }

    const run_id = await insertRun({ team: "ad-hoc" });
    const result = runs.finalizeRun({ run_id, status: "complete" });
    assert.equal(result.effective_status, "complete",
      "ad-hoc with no yaml must be treated as no-team-source and not block");
  });

  // Issue #1b: team='ad-hoc' WITH a real ad-hoc.yaml that declares a required check
  // currently failing -> resolve-first: real team is honored, gate BLOCKS.
  it("#1b: team='ad-hoc' WITH resolvable ad-hoc.yaml + failing required check -> BLOCKED", async () => {
    const runs = await getRuns();
    const db = await getDb();

    // Write a minimal ad-hoc.yaml into the shared project's .claude/teams/.
    const teamsDir = join(SHARED_PROJECT, ".claude", "teams");
    mkdirSync(teamsDir, { recursive: true });
    const adHocPath = join(teamsDir, "ad-hoc.yaml");
    writeFileSync(adHocPath,
      `name: ad-hoc\ndescription: test ad-hoc team\nmissability_required:\n  - nfrs-declared\n`,
      "utf8");

    try {
      const run_id = await insertRun({ team: "ad-hoc" });
      // nfrs-declared required by the real ad-hoc team, but no row persisted -> fail-closed.
      let threw = false;
      try {
        runs.finalizeRun({ run_id, status: "complete" });
      } catch (err) {
        threw = true;
        assert.equal(err.name, "MissabilityGateViolation",
          `real ad-hoc team must be honored; got ${err.name}: ${err.message}`);
        assert.ok(err.failed_required_check_ids.includes("nfrs-declared"),
          "nfrs-declared from real ad-hoc.yaml must appear in failed list");
      }
      assert.ok(threw, "real ad-hoc team with failing required check must block");
    } finally {
      // Remove the ad-hoc.yaml so subsequent tests aren't polluted.
      try { rmSync(adHocPath); } catch { /* ignore */ }
    }
  });

  // Issue #1c: a NON-sentinel team name that doesn't resolve must still fail closed.
  it("#1c: unknown non-sentinel team that doesn't resolve -> fail closed", async () => {
    const runs = await getRuns();
    const db = await getDb();
    const run_id = await insertRun();
    db().prepare(`UPDATE runs SET team = 'no-such-team-xyz' WHERE id = ?`).run(run_id);

    let threw = false;
    try {
      runs.finalizeRun({ run_id, status: "complete" });
    } catch (err) {
      threw = true;
      assert.equal(err.name, "MissabilityGateViolation");
      assert.match(err.message, /PP-VG-4/);
      assert.match(err.message, /no-such-team-xyz/);
    }
    assert.ok(threw, "unknown real team must fail closed");
  });

  // Issue #3: blank "" team -> fail closed.
  it("#3: blank team='' -> fail closed (MissabilityGateViolation)", async () => {
    const runs = await getRuns();
    const db = await getDb();
    const run_id = await insertRun();
    db().prepare(`UPDATE runs SET team = '' WHERE id = ?`).run(run_id);

    let threw = false;
    try {
      runs.finalizeRun({ run_id, status: "complete" });
    } catch (err) {
      threw = true;
      assert.equal(err.name, "MissabilityGateViolation");
      assert.match(err.message, /PP-VG-4/);
      assert.match(err.message, /blank team/);
    }
    assert.ok(threw, "blank team must fail closed");
  });

  // Issue #3: blank "" forum -> fail closed.
  it("#3: blank forum='' -> fail closed (MissabilityGateViolation)", async () => {
    const runs = await getRuns();
    const db = await getDb();
    const run_id = await insertRun();
    db().prepare(`UPDATE runs SET forum = '' WHERE id = ?`).run(run_id);

    let threw = false;
    try {
      runs.finalizeRun({ run_id, status: "complete" });
    } catch (err) {
      threw = true;
      assert.equal(err.name, "MissabilityGateViolation");
      assert.match(err.message, /PP-VG-4/);
      assert.match(err.message, /blank forum/);
    }
    assert.ok(threw, "blank forum must fail closed");
  });

  // Issue #2: same created_at for two rows; later-inserted (higher rowid) is 'fail'.
  // The rowid tiebreak must pick the later-inserted row, so result is 'fail' -> blocked.
  it("#2: same-ms rows for one check — later rowid is 'fail' -> blocked (rowid tiebreak)", async () => {
    const runs = await getRuns();
    const db = await getDb();
    const run_id = await insertRun({
      profile_snapshot_json: JSON.stringify({
        name: "web-ui",
        description: "test",
        required_missability_checks: ["nfrs-declared"],
      }),
    });

    // Insert pass first, fail second — both with the SAME created_at (same ms).
    const samets = new Date().toISOString();
    const id1 = `mc_tie1_${Math.random().toString(36).slice(2, 10)}`;
    const id2 = `mc_tie2_${Math.random().toString(36).slice(2, 10)}`;
    db().prepare(
      `INSERT INTO missability_checks(id, run_id, check_id, status, evidence_path, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(id1, run_id, "nfrs-declared", "pass", null, samets);
    // Later rowid, same timestamp → the "last inserted" row is 'fail'.
    db().prepare(
      `INSERT INTO missability_checks(id, run_id, check_id, status, evidence_path, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(id2, run_id, "nfrs-declared", "fail", null, samets);

    let threw = false;
    try {
      runs.finalizeRun({ run_id, status: "complete" });
    } catch (err) {
      threw = true;
      assert.equal(err.name, "MissabilityGateViolation",
        `expected MissabilityGateViolation, got ${err.name}: ${err.message}`);
      assert.ok(err.failed_required_check_ids.includes("nfrs-declared"),
        "rowid tiebreak must pick the later-inserted 'fail' row");
    }
    assert.ok(threw, "same-ms tie broken by rowid: later-inserted fail must block");
  });

});
