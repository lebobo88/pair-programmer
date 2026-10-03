/**
 * finalize-gates-a1.unit.mjs
 *
 * Self-contained unit tests for the VG-7, VG-2, and VG-3 finalize gates
 * (first half of the original finalize-gates-a.unit.mjs, split for
 * balanced per-file wall clock -- see AGENTS.md ANTI-STALL TEST RULE).
 * The remaining residual/regression cases for the same three gates live in
 * finalize-gates-a2.unit.mjs. Shared setup/helpers live in
 * test/fixtures/finalize-gates-helpers.mjs.
 *
 *   VG-7: finalizeRun returns structured FinalizeRunOutput; surfaced child
 *         downgrades "complete" to "surfaced".
 *   VG-2: finalizeRun(complete) is blocked when a required artifact kind
 *         has zero run-wide rows; resolves from persisted snapshots only;
 *         malformed/missing snapshots fail-closed.
 *   VG-3: browserValidationFinalize every unexpected 4xx/5xx -> "errors";
 *         per-finding expected_statuses exempts only that finding; severity
 *         ratchet never downgrades; foreign stage_id rejected; errors
 *         report path retained over a later clean call.
 *
 * Anti-stall contract:
 *   - Uses a temp sqlite DB (PP_HOME override), direct dist function calls.
 *   - No MCP server, no daemon socket, no smoke files touched.
 *   - Run: node test/finalize-gates-a1.unit.mjs  (NO --test flag)
 */

import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";

// Set PP_HOME BEFORE any dist import so the DB is isolated.
const SUITE_DIR = mkdtempSync(join(tmpdir(), "pp-finalize-gates-a1-"));
mkdirSync(join(SUITE_DIR, ".pair-programmer"), { recursive: true });
process.env.PP_HOME = SUITE_DIR;
process.env.EIGHTS_SKIP_AUDIT_CHECK = "1";

const { makeRecorder, makeProject, bootstrap, populateMasterPlanSections, bvFinalize } =
  await import("./fixtures/finalize-gates-helpers.mjs");

const { record, counts } = makeRecorder();

// ─── VG-7 ──────────────────────────────────────────────────────────────────
console.log("\nVG-7: structured FinalizeRunOutput");

await record("all-passed -> not downgraded, effective_status=complete", async () => {
  const project = makeProject();
  try {
    const { runs, run } = await bootstrap(project);
    const result = runs.finalizeRun({ run_id: run.run_id, status: "complete" });
    assert.equal(typeof result, "object", "returns object");
    assert.equal(result.effective_status, "complete");
    assert.equal(result.requested_status, "complete");
    assert.equal(result.downgraded, false);
    assert.equal(result.surfaced_stage_count, 0);
  } finally { rmSync(project, { recursive: true, force: true }); }
});

await record("surfaced child stage -> downgraded to surfaced, downgraded=true", async () => {
  const project = makeProject();
  try {
    const { runs, db, run, stage } = await bootstrap(project);
    // Mark stage as surfaced so VG-7 triggers.
    db().prepare(`UPDATE stages SET status = 'surfaced', finished_at = ? WHERE id = ?`)
       .run(new Date().toISOString(), stage.stage_id);

    const result = runs.finalizeRun({ run_id: run.run_id, status: "complete" });
    assert.equal(result.effective_status, "surfaced");
    assert.equal(result.requested_status, "complete");
    assert.equal(result.downgraded, true);
    assert.equal(result.surfaced_stage_count, 1);

    // DB row must store effective_status.
    const row = db().prepare(`SELECT status FROM runs WHERE id = ?`).get(run.run_id);
    assert.equal(row?.status, "surfaced");
  } finally { rmSync(project, { recursive: true, force: true }); }
});

await record("finalizeRun(surfaced) -> no downgrade, effective=surfaced", async () => {
  const project = makeProject();
  try {
    const { runs, run } = await bootstrap(project);
    const result = runs.finalizeRun({ run_id: run.run_id, status: "surfaced" });
    assert.equal(result.effective_status, "surfaced");
    assert.equal(result.requested_status, "surfaced");
    assert.equal(result.downgraded, false);
    assert.equal(result.surfaced_stage_count, 0);
  } finally { rmSync(project, { recursive: true, force: true }); }
});

// ─── VG-2 ──────────────────────────────────────────────────────────────────
console.log("\nVG-2: run-level artifact availability gate");

await record("required kind zero run-wide artifacts -> blocks complete", async () => {
  const project = makeProject();
  try {
    const taxonomyJson = JSON.stringify({
      scope: "standard", signals: [],
      sections: [{ id: "4.4", title: "Test", rationale: "r", required_artifacts: ["openapi"] }],
      missability_required: [],
    });
    const { runs, run } = await bootstrap(project, { taxonomy_mapping_json: taxonomyJson });
    let threw = false;
    try {
      runs.finalizeRun({ run_id: run.run_id, status: "complete" });
    } catch (err) {
      threw = true;
      assert.match(err.message, /PP-VG-2/, "message must cite PP-VG-2");
      assert.match(err.message, /openapi/, "message must cite the kind");
      assert.equal(err.name, "ArtifactAvailabilityGateViolation");
    }
    assert.ok(threw, "must have thrown");
  } finally { rmSync(project, { recursive: true, force: true }); }
});

await record("required kind present in a different stage of the run -> NOT blocked", async () => {
  const project = makeProject();
  try {
    const taxonomyJson = JSON.stringify({
      scope: "standard", signals: [],
      sections: [{ id: "4.4", title: "Test", rationale: "r", required_artifacts: ["openapi"] }],
      missability_required: [],
    });
    const { runs, run, stage } = await bootstrap(project, { taxonomy_mapping_json: taxonomyJson });
    await populateMasterPlanSections(project, run.run_id, ["9. UX/UI/content design"]);

    await runs.archiveArtifact({
      run_id: run.run_id,
      stage_id: stage.stage_id,
      kind: "openapi",
      relative_path: "openapi.yaml",
      bytes: "openapi: '3.0'",
    });

    const result = runs.finalizeRun({ run_id: run.run_id, status: "complete" });
    assert.equal(result.effective_status, "complete");
  } finally { rmSync(project, { recursive: true, force: true }); }
});

await record("RUN-LEVEL artifact (stage_id omitted) satisfies the required kind -> NOT blocked", async () => {
  const project = makeProject();
  try {
    const profileJson = JSON.stringify({ name: "non-ui-cli", description: "t", required_artifacts: ["runbook"] });
    const { runs, run } = await bootstrap(project, { profile_snapshot_json: profileJson });

    await runs.archiveArtifact({
      run_id: run.run_id,
      kind: "runbook",
      relative_path: "runbook.md",
      bytes: "# Runbook\n\nOperate the thing.\n",
    });

    const result = runs.finalizeRun({ run_id: run.run_id, status: "complete" });
    assert.equal(result.effective_status, "complete", "a run-level artifact must satisfy PP-VG-2");
  } finally { rmSync(project, { recursive: true, force: true }); }
});

await record("PP-VG-2 still blocks when the required kind is archived under a DIFFERENT kind", async () => {
  const project = makeProject();
  try {
    const profileJson = JSON.stringify({ name: "non-ui-cli", description: "t", required_artifacts: ["runbook"] });
    const { runs, run } = await bootstrap(project, { profile_snapshot_json: profileJson });

    await runs.archiveArtifact({
      run_id: run.run_id,
      kind: "postmortem",
      relative_path: "postmortem.md",
      bytes: "# Postmortem\n\nNot a runbook.\n",
    });

    let threw = false;
    try {
      runs.finalizeRun({ run_id: run.run_id, status: "complete" });
    } catch (err) {
      threw = true;
      assert.match(err.message, /PP-VG-2/);
      assert.match(err.message, /runbook/);
    }
    assert.ok(threw, "a different kind must not satisfy the requirement");
  } finally { rmSync(project, { recursive: true, force: true }); }
});

await record("required kind from profile_snapshot_json, zero artifacts -> blocks", async () => {
  const project = makeProject();
  try {
    const profileJson = JSON.stringify({ name: "api-platform", description: "t", required_artifacts: ["sbom"] });
    const { runs, run } = await bootstrap(project, { profile_snapshot_json: profileJson });
    let threw = false;
    try {
      runs.finalizeRun({ run_id: run.run_id, status: "complete" });
    } catch (err) {
      threw = true;
      assert.match(err.message, /PP-VG-2/);
      assert.match(err.message, /sbom/);
    }
    assert.ok(threw, "must have thrown");
  } finally { rmSync(project, { recursive: true, force: true }); }
});

await record("malformed taxonomy_mapping_json -> blocked (fail-closed)", async () => {
  const project = makeProject();
  try {
    const { runs, run } = await bootstrap(project, { taxonomy_mapping_json: "NOT_VALID_JSON{{" });
    let threw = false;
    try {
      runs.finalizeRun({ run_id: run.run_id, status: "complete" });
    } catch (err) {
      threw = true;
      assert.match(err.message, /PP-VG-2/);
      assert.match(err.message, /taxonomy_mapping_json/);
    }
    assert.ok(threw, "must have thrown");
  } finally { rmSync(project, { recursive: true, force: true }); }
});

await record("malformed profile_snapshot_json -> blocked (fail-closed)", async () => {
  const project = makeProject();
  try {
    const { runs, run } = await bootstrap(project, { profile_snapshot_json: "{broken json" });
    let threw = false;
    try {
      runs.finalizeRun({ run_id: run.run_id, status: "complete" });
    } catch (err) {
      threw = true;
      assert.match(err.message, /PP-VG-2/);
      assert.match(err.message, /profile_snapshot_json/);
    }
    assert.ok(threw, "must have thrown");
  } finally { rmSync(project, { recursive: true, force: true }); }
});

await record("null snapshots (no required kinds) -> NOT blocked", async () => {
  const project = makeProject();
  try {
    const { runs, run } = await bootstrap(project);
    const result = runs.finalizeRun({ run_id: run.run_id, status: "complete" });
    assert.equal(result.effective_status, "complete");
  } finally { rmSync(project, { recursive: true, force: true }); }
});

await record("finalizeRun(surfaced) bypasses the artifact gate entirely", async () => {
  const project = makeProject();
  try {
    const taxonomyJson = JSON.stringify({
      scope: "standard", signals: [],
      sections: [{ id: "4.4", title: "T", rationale: "r", required_artifacts: ["openapi"] }],
      missability_required: [],
    });
    const { runs, run } = await bootstrap(project, { taxonomy_mapping_json: taxonomyJson });
    const result = runs.finalizeRun({ run_id: run.run_id, status: "surfaced" });
    assert.equal(result.effective_status, "surfaced");
  } finally { rmSync(project, { recursive: true, force: true }); }
});

// ─── VG-3 ──────────────────────────────────────────────────────────────────
console.log("\nVG-3: browser validation gate");

await record("unexpected 4xx -> severity=errors (fail-closed)", async () => {
  const project = makeProject();
  try {
    const { run, stage } = await bootstrap(project);
    const result = await bvFinalize({
      run_id: run.run_id, stage_id: stage.stage_id,
      findings: [{
        route: "/api/data", step: "load", status: "pass",
        console_errors: [],
        network_errors: [{ url: "http://x/api/data", status: 403 }],
      }],
    });
    assert.equal(result.severity, "errors");
    assert.equal(result.effective_severity, "errors");
  } finally { rmSync(project, { recursive: true, force: true }); }
});

await record("unexpected 5xx -> severity=errors", async () => {
  const project = makeProject();
  try {
    const { run, stage } = await bootstrap(project);
    const result = await bvFinalize({
      run_id: run.run_id, stage_id: stage.stage_id,
      findings: [{
        route: "/api/fail", step: "load", status: "pass",
        console_errors: [],
        network_errors: [{ url: "http://x/api/fail", status: 500 }],
      }],
    });
    assert.equal(result.severity, "errors");
    assert.equal(result.effective_severity, "errors");
  } finally { rmSync(project, { recursive: true, force: true }); }
});

await record("per-finding expected_statuses 401 -> not blocked", async () => {
  const project = makeProject();
  try {
    const { run, stage } = await bootstrap(project);
    const result = await bvFinalize({
      run_id: run.run_id, stage_id: stage.stage_id,
      findings: [{
        route: "/api/login", step: "auth", status: "pass",
        console_errors: [],
        network_errors: [{ url: "http://x/api/login", status: 401 }],
        expected_statuses: [401],
      }],
    });
    assert.equal(result.severity, "clean");
    assert.equal(result.effective_severity, "clean");
  } finally { rmSync(project, { recursive: true, force: true }); }
});

await record("per-finding expected 401 does NOT suppress 500 on another finding", async () => {
  const project = makeProject();
  try {
    const { run, stage } = await bootstrap(project);
    const result = await bvFinalize({
      run_id: run.run_id, stage_id: stage.stage_id,
      findings: [
        {
          route: "/api/login", step: "auth", status: "pass",
          console_errors: [],
          network_errors: [{ url: "http://x/login", status: 401 }],
          expected_statuses: [401],
        },
        {
          route: "/api/data", step: "fetch", status: "pass",
          console_errors: [],
          network_errors: [{ url: "http://x/data", status: 500 }],
        },
      ],
    });
    assert.equal(result.severity, "errors", "500 on second finding -> errors");
    assert.equal(result.effective_severity, "errors");
  } finally { rmSync(project, { recursive: true, force: true }); }
});

await record("ratchet: errors-then-clean -> effective_severity=errors, errors report retained", async () => {
  const project = makeProject();
  try {
    const { run, stage } = await bootstrap(project);

    const r1 = await bvFinalize({
      run_id: run.run_id, stage_id: stage.stage_id,
      findings: [{
        route: "/api", step: "load", status: "pass",
        console_errors: [],
        network_errors: [{ url: "http://x/api", status: 500 }],
      }],
    });
    assert.equal(r1.severity, "errors");
    assert.equal(r1.effective_severity, "errors");
    const errorsReport = r1.report_path;

    const r2 = await bvFinalize({
      run_id: run.run_id, stage_id: stage.stage_id,
      findings: [{ route: "/api", step: "load", status: "pass", console_errors: [], network_errors: [] }],
    });
    assert.equal(r2.severity, "clean", "this-call severity is clean");
    assert.equal(r2.effective_severity, "errors", "ratchet must NOT downgrade");
    assert.equal(r2.effective_report_path, errorsReport, "errors report path must be retained");
    assert.notEqual(r2.report_path, errorsReport, "new report path is timestamped differently");
  } finally { rmSync(project, { recursive: true, force: true }); }
});

await record("ratchet: clean-then-errors -> effective_severity=errors, new report retained", async () => {
  const project = makeProject();
  try {
    const { run, stage } = await bootstrap(project);

    const r1 = await bvFinalize({
      run_id: run.run_id, stage_id: stage.stage_id,
      findings: [{ route: "/", step: "load", status: "pass", console_errors: [], network_errors: [] }],
    });
    assert.equal(r1.effective_severity, "clean");

    const r2 = await bvFinalize({
      run_id: run.run_id, stage_id: stage.stage_id,
      findings: [{ route: "/api", step: "fetch", status: "fail", console_errors: ["TypeError: x"], network_errors: [] }],
    });
    assert.equal(r2.severity, "errors");
    assert.equal(r2.effective_severity, "errors");
    assert.equal(r2.effective_report_path, r2.report_path, "errors report is the current one");
  } finally { rmSync(project, { recursive: true, force: true }); }
});

await record("foreign stage_id (different run) -> rejected before persist", async () => {
  const projectC = makeProject();
  const projectD = makeProject();
  try {
    const { run: runC } = await bootstrap(projectC);
    const { stage: stageD } = await bootstrap(projectD);

    let threw = false;
    try {
      await bvFinalize({
        run_id: runC.run_id,
        stage_id: stageD.stage_id,
        findings: [],
      });
    } catch (err) {
      threw = true;
      assert.match(err.message, /PP-VG-3/, "message must cite PP-VG-3");
      assert.match(err.message, /does not belong to run/);
    }
    assert.ok(threw, "must have thrown");
  } finally {
    rmSync(projectC, { recursive: true, force: true });
    rmSync(projectD, { recursive: true, force: true });
  }
});

await record("getStageFinalizeReadiness emits browser_validation blocker when severity=errors", async () => {
  const project = makeProject();
  try {
    const { runs, run, stage } = await bootstrap(project);

    await bvFinalize({
      run_id: run.run_id, stage_id: stage.stage_id,
      findings: [{
        route: "/x", step: "load", status: "fail",
        console_errors: ["crash"], network_errors: [],
      }],
    });

    const readiness = runs.getStageFinalizeReadiness(stage.stage_id);
    assert.equal(readiness.can_pass, false);
    const blocker = readiness.blockers.find(b => b.gate === "browser_validation");
    assert.ok(blocker, "browser_validation blocker must be present");
    assert.equal(blocker.severity, "errors");
    assert.equal(blocker.next_action, "surface_stage");
  } finally { rmSync(project, { recursive: true, force: true }); }
});

await record("getStageFinalizeReadiness does NOT block when severity=clean", async () => {
  const project = makeProject();
  try {
    const { runs, run, stage } = await bootstrap(project);

    await bvFinalize({
      run_id: run.run_id, stage_id: stage.stage_id,
      findings: [{ route: "/", step: "load", status: "pass", console_errors: [], network_errors: [] }],
    });

    const readiness = runs.getStageFinalizeReadiness(stage.stage_id);
    const blocker = readiness.blockers.find(b => b.gate === "browser_validation");
    assert.equal(blocker, undefined, "clean BV must not block");
  } finally { rmSync(project, { recursive: true, force: true }); }
});

// ─── Summary ────────────────────────────────────────────────────────────────
console.log();
const { passed, failed } = counts();
console.log(`${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
