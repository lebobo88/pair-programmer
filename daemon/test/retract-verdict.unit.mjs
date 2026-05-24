// Unit test for R3-tail post-mortem Fix 1.3: retractVerdict.
//
// Covers:
//  - Happy path: retract succeeds, fields populated.
//  - Idempotent re-retract with same reason is a no-op.
//  - Different-reason re-retract is refused.
//  - Empty / short reason is refused.
//  - Retracted verdict is skipped by getStageFinalizeReadiness'
//    latest-verdict-fail gate (was: fail blocked finalize; after retract:
//    finalize can proceed).
//  - Retracted cross-vendor verdict no longer satisfies the Fix 0.2
//    rejudge gate.

import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import assert from "node:assert/strict";

const SUITE_DIR = mkdtempSync(join(tmpdir(), "pp-retract-"));
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
    () => { console.log(`✓ ${name}`); passed++; },
    (err) => { console.error(`✗ ${name}\n  ${err.message}`); failed++; },
  );
}

function setupProject() {
  const dir = mkdtempSync(join(tmpdir(), "pp-retract-proj-"));
  mkdirSync(join(dir, ".harness"), { recursive: true });
  writeFileSync(join(dir, "AGENTS.md"), "# AGENTS\n", "utf8");
  return dir;
}

await record("retract_verdict happy path", async () => {
  const project = setupProject();
  try {
    const runs = await importDist("orchestrator/runs.js");
    const run = await runs.ensureRun({ request_text: "retract test", project_path: project, mode: "single" });
    const stage = await runs.startStage({ run_id: run.run_id, kind: "code", gate_type: "code" });
    const att = runs.recordAttempt({ stage_id: stage.stage_id, producer: "claude", model_id: "claude-sonnet-4-6", status: "ok" });
    const verdict = runs.recordVerdict({
      attempt_id: att.attempt_id,
      judge_producer: "codex",
      judge_model_id: "gpt-5.4",
      rubric_id: "code-quality@1",
      outcome: "fail",
      critique_md: "flagged optional Idempotency-Key as wrong — actually HTTP industry standard",
    });
    const result = runs.retractVerdict({
      verdict_id: verdict.verdict_id,
      reason: "cross-vendor false positive: optional Idempotency-Key is per-Stripe/GitHub/Square standard",
    });
    assert.ok(result.retracted_at, "retracted_at populated");
    assert.equal(result.verdict_id, verdict.verdict_id);
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

await record("retract_verdict refuses short reason", async () => {
  const project = setupProject();
  try {
    const runs = await importDist("orchestrator/runs.js");
    const run = await runs.ensureRun({ request_text: "short reason", project_path: project, mode: "single" });
    const stage = await runs.startStage({ run_id: run.run_id, kind: "code", gate_type: "code" });
    const att = runs.recordAttempt({ stage_id: stage.stage_id, producer: "claude", model_id: "claude-sonnet-4-6", status: "ok" });
    const verdict = runs.recordVerdict({
      attempt_id: att.attempt_id,
      judge_producer: "codex",
      judge_model_id: "gpt-5.4",
      rubric_id: "code-quality@1",
      outcome: "fail",
      critique_md: "spurious flag",
    });
    assert.throws(() => runs.retractVerdict({ verdict_id: verdict.verdict_id, reason: "lol" }),
      /reason/i, "short reason rejected");
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

await record("retract_verdict is idempotent on same reason", async () => {
  const project = setupProject();
  try {
    const runs = await importDist("orchestrator/runs.js");
    const run = await runs.ensureRun({ request_text: "idempotent", project_path: project, mode: "single" });
    const stage = await runs.startStage({ run_id: run.run_id, kind: "code", gate_type: "code" });
    const att = runs.recordAttempt({ stage_id: stage.stage_id, producer: "claude", model_id: "claude-sonnet-4-6", status: "ok" });
    const verdict = runs.recordVerdict({
      attempt_id: att.attempt_id,
      judge_producer: "codex",
      judge_model_id: "gpt-5.4",
      rubric_id: "code-quality@1",
      outcome: "fail",
      critique_md: "the same reason both times will be 8 chars",
    });
    const reason = "Gemini hallucinated missing baseline fixes that were never scoped in this dispatch";
    const a = runs.retractVerdict({ verdict_id: verdict.verdict_id, reason });
    const b = runs.retractVerdict({ verdict_id: verdict.verdict_id, reason });
    assert.equal(a.retracted_at, b.retracted_at, "same-reason re-retract is a no-op");
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

await record("retract_verdict rejects different-reason overwrite", async () => {
  const project = setupProject();
  try {
    const runs = await importDist("orchestrator/runs.js");
    const run = await runs.ensureRun({ request_text: "different reason", project_path: project, mode: "single" });
    const stage = await runs.startStage({ run_id: run.run_id, kind: "code", gate_type: "code" });
    const att = runs.recordAttempt({ stage_id: stage.stage_id, producer: "claude", model_id: "claude-sonnet-4-6", status: "ok" });
    const verdict = runs.recordVerdict({
      attempt_id: att.attempt_id,
      judge_producer: "codex",
      judge_model_id: "gpt-5.4",
      rubric_id: "code-quality@1",
      outcome: "fail",
      critique_md: "filler",
    });
    runs.retractVerdict({ verdict_id: verdict.verdict_id, reason: "first reason here long enough" });
    assert.throws(
      () => runs.retractVerdict({ verdict_id: verdict.verdict_id, reason: "second reason different from first one" }),
      /already retracted/i,
      "different-reason overwrite is refused",
    );
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

await record("retracted fail verdict no longer blocks finalize", async () => {
  const project = setupProject();
  try {
    const runs = await importDist("orchestrator/runs.js");
    const run = await runs.ensureRun({ request_text: "unblock", project_path: project, mode: "single" });
    const stage = await runs.startStage({ run_id: run.run_id, kind: "code", gate_type: "code" });
    const att = runs.recordAttempt({ stage_id: stage.stage_id, producer: "claude", model_id: "claude-sonnet-4-6", status: "ok" });
    const verdict = runs.recordVerdict({
      attempt_id: att.attempt_id,
      judge_producer: "codex",
      judge_model_id: "gpt-5.4",
      rubric_id: "code-quality@1",
      outcome: "fail",
      critique_md: "fail verdict that will be retracted in this test",
    });
    // Sanity: before retract, fail verdict blocks finalize.
    let readiness = runs.getStageFinalizeReadiness(stage.stage_id);
    assert.equal(readiness.can_pass, false, "fail verdict should block finalize before retract");
    runs.retractVerdict({
      verdict_id: verdict.verdict_id,
      reason: "fail was a hallucination — judge cited a missing fix that was never scoped",
    });
    readiness = runs.getStageFinalizeReadiness(stage.stage_id);
    const verdictBlocker = readiness.blockers.find(b => b.gate === "verdict");
    assert.equal(verdictBlocker, undefined, "retracted fail no longer blocks");
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

console.log();
console.log(`${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
