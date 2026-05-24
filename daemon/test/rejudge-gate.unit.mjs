// Unit tests for the R3-tail post-mortem Fix 0.2 cross-vendor re-judge gate.
//
// Covers `getStageFinalizeReadiness` blocker `findings_closure_rejudge`:
// when an engineer attempt's notes_json declares findings_closed (or
// anti_pattern_hits, or status=needs_review) and no cross-vendor verdict
// exists on that attempt, finalize_passed must be refused.
//
// Runs against the compiled dist/. Invoked from `npm test` if wired in.

import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import assert from "node:assert/strict";

// The dist module's DB_PATH is read at module-load. Set env BEFORE any
// dist import so all imports below see the override. One shared DB for the
// whole test file is fine — each test creates its own run/stage so rows
// don't collide.
const SUITE_DIR = mkdtempSync(join(tmpdir(), "pp-rejudge-gate-"));
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

async function setupTempProject() {
  const dir = mkdtempSync(join(tmpdir(), "pp-rejudge-gate-proj-"));
  mkdirSync(join(dir, ".harness"), { recursive: true });
  // Minimal AGENTS.md so ensureRun doesn't try to scaffold one mid-test.
  writeFileSync(join(dir, "AGENTS.md"), "# AGENTS\n", "utf8");
  return dir;
}

async function withProject(project, fn) {
  try {
    return await fn();
  } finally {
    try { rmSync(project, { recursive: true, force: true }); } catch {}
  }
}

async function bootstrapRunAndStage(project) {
  const { ensureRun } = await importDist("orchestrator/runs.js");
  const runs = await importDist("orchestrator/runs.js");
  const run = await runs.ensureRun({
    request_text: "rejudge gate fixture",
    project_path: project,
    mode: "single",
  });
  const stage = await runs.startStage({
    run_id: run.run_id,
    kind: "code",
    gate_type: "code",
  });
  return { run, stage };
}

await record("blocker fires when findings_closed claimed without cross-vendor verdict", async () => {
  const project = await setupTempProject();
  await withProject(project, async () => {
      const runs = await importDist("orchestrator/runs.js");
      const { run, stage } = await bootstrapRunAndStage(project);
      const att = runs.recordAttempt({
        stage_id: stage.stage_id,
        producer: "claude",
        model_id: "claude-sonnet-4-6",
        status: "ok",
        notes: {
          findings_closed: [
            { id: "C1", file: "apps/x.ts", lines: "10-20", claim: "fixed" },
          ],
        },
      });
      assert.ok(att.attempt_id, "attempt recorded");

      const readiness = runs.getStageFinalizeReadiness(stage.stage_id);
      assert.equal(readiness.can_pass, false, "finalize blocked");
      const blocker = readiness.blockers.find(b => b.gate === "findings_closure_rejudge");
      assert.ok(blocker, "rejudge blocker present");
      assert.equal(blocker.next_action, "dispatch_cross_vendor_rejudge");
      assert.equal(blocker.attempt_id, att.attempt_id);
      assert.deepEqual(blocker.finding_ids, ["C1"]);
  });
});

await record("blocker fires on anti_pattern_hits even without findings_closed", async () => {
  const project = await setupTempProject();
  await withProject(project, async () => {
      const runs = await importDist("orchestrator/runs.js");
      const { stage } = await bootstrapRunAndStage(project);
      const att = runs.recordAttempt({
        stage_id: stage.stage_id,
        producer: "claude",
        model_id: "claude-sonnet-4-6",
        status: "needs_review",
        notes: {
          anti_pattern_hits: [
            { file: "apps/x.ts", line: 42, pattern: "void idempotencyKey" },
          ],
        },
      });
      const readiness = runs.getStageFinalizeReadiness(stage.stage_id);
      assert.equal(readiness.can_pass, false);
      const blocker = readiness.blockers.find(b => b.gate === "findings_closure_rejudge");
      assert.ok(blocker, "anti-pattern hit triggers gate");
  });
});

await record("blocker clears once a cross-vendor verdict exists on the attempt", async () => {
  const project = await setupTempProject();
  await withProject(project, async () => {
      const runs = await importDist("orchestrator/runs.js");
      const { stage } = await bootstrapRunAndStage(project);
      const att = runs.recordAttempt({
        stage_id: stage.stage_id,
        producer: "claude",
        model_id: "claude-sonnet-4-6",
        status: "ok",
        notes: {
          findings_closed: [
            { id: "H1", file: "x.ts", lines: "1-5", claim: "fixed" },
          ],
        },
      });
      // Cross-vendor verdict from a DIFFERENT vendor than the generator
      // (claude). Codex pass meets the bar.
      runs.recordVerdict({
        attempt_id: att.attempt_id,
        judge_producer: "codex",
        judge_model_id: "gpt-5.4",
        rubric_id: "code-quality@1",
        outcome: "pass",
        critique_md: "independent cross-vendor read of the diff confirms the claim",
      });
      const readiness = runs.getStageFinalizeReadiness(stage.stage_id);
      const blocker = readiness.blockers.find(b => b.gate === "findings_closure_rejudge");
      assert.equal(blocker, undefined, "cross-vendor verdict clears the gate");
  });
});

await record("legacy attempts without notes_json don't trigger the gate", async () => {
  const project = await setupTempProject();
  await withProject(project, async () => {
      const runs = await importDist("orchestrator/runs.js");
      const { stage } = await bootstrapRunAndStage(project);
      runs.recordAttempt({
        stage_id: stage.stage_id,
        producer: "codex",
        model_id: "gpt-5.4",
        status: "ok",
        // No `notes` — Path B/C non-engineer attempts have no self-claim
        // surface to reconcile. Gate doesn't fire on these.
      });
      const readiness = runs.getStageFinalizeReadiness(stage.stage_id);
      const blocker = readiness.blockers.find(b => b.gate === "findings_closure_rejudge");
      assert.equal(blocker, undefined, "no notes ⇒ no gate");
  });
});

console.log();
console.log(`${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
