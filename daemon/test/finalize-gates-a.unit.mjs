/**
 * finalize-gates-a.unit.mjs
 *
 * Self-contained unit tests for three finalize gates:
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
 *   - Run: node test/finalize-gates-a.unit.mjs  (NO --test flag)
 */

import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import assert from "node:assert/strict";

// Set PP_HOME BEFORE any dist import so the DB is isolated.
const SUITE_DIR = mkdtempSync(join(tmpdir(), "pp-finalize-gates-a-"));
mkdirSync(join(SUITE_DIR, ".pair-programmer"), { recursive: true });
process.env.PP_HOME = SUITE_DIR;
process.env.EIGHTS_SKIP_AUDIT_CHECK = "1";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DIST = join(__dirname, "..", "dist");
const importDist = (relPath) => import(pathToFileURL(join(DIST, relPath)).href);

let passed = 0;
let failed = 0;
async function record(name, fn) {
  try {
    await fn();
    console.log(`✓ ${name}`);
    passed++;
  } catch (err) {
    console.error(`✗ ${name}`);
    console.error(`  ${err.stack ?? err.message}`);
    failed++;
  }
}

/** Create a fresh temp project dir with the minimal scaffolding. */
function makeProject() {
  const dir = mkdtempSync(join(tmpdir(), "pp-fg-proj-"));
  mkdirSync(join(dir, ".harness"), { recursive: true });
  writeFileSync(join(dir, "AGENTS.md"), "# AGENTS\n", "utf8");
  return dir;
}

/** Boot a run + one stage, return { runs, db, run, stage }. */
async function bootstrap(project, { stagekind = "code", profile_snapshot_json = null, taxonomy_mapping_json = null } = {}) {
  const runs = await importDist("orchestrator/runs.js");
  const { db } = await importDist("db/database.js");

  const run = await runs.ensureRun({
    request_text: "finalize-gates test",
    project_path: project,
    mode: "single",
  });

  // Patch snapshot columns directly via SQL (not exposed through ensureRun).
  if (profile_snapshot_json !== null || taxonomy_mapping_json !== null) {
    db().prepare(
      `UPDATE runs SET
         profile_snapshot_json = COALESCE(?, profile_snapshot_json),
         taxonomy_mapping_json  = COALESCE(?, taxonomy_mapping_json)
       WHERE id = ?`
    ).run(profile_snapshot_json, taxonomy_mapping_json, run.run_id);
  }

  const stage = await runs.startStage({
    run_id: run.run_id,
    kind: stagekind,
    gate_type: stagekind,
  });

  return { runs, db, run, stage };
}

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

    // Archive an 'openapi' artifact on the stage.
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
    // 'surfaced' must not be blocked by VG-2.
    const result = runs.finalizeRun({ run_id: run.run_id, status: "surfaced" });
    assert.equal(result.effective_status, "surfaced");
  } finally { rmSync(project, { recursive: true, force: true }); }
});

// ─── VG-3 ──────────────────────────────────────────────────────────────────
console.log("\nVG-3: browser validation gate");

/** Thin wrapper around browserValidationFinalize. */
async function bvFinalize({ run_id, stage_id, findings = [], engine = "playwright", engine_status, unavailable_reason } = {}) {
  const bv = await importDist("orchestrator/browser-validation.js");
  return bv.browserValidationFinalize({ run_id, stage_id, engine, findings, engine_status, unavailable_reason });
}

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
          // 500 NOT in expected_statuses for this finding
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

    // Call 1: errors (500)
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

    // Call 2: clean
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

    // Call 1: clean
    const r1 = await bvFinalize({
      run_id: run.run_id, stage_id: stage.stage_id,
      findings: [{ route: "/", step: "load", status: "pass", console_errors: [], network_errors: [] }],
    });
    assert.equal(r1.effective_severity, "clean");

    // Call 2: errors
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
  // Two completely isolated projects, each with their own run + stage.
  const projectC = makeProject();
  const projectD = makeProject();
  try {
    const { run: runC } = await bootstrap(projectC);
    // We need stageD to belong to runD (a different run). Because ensureRun
    // returns the same run for a given project, we use two distinct projects.
    const { stage: stageD } = await bootstrap(projectD);

    let threw = false;
    try {
      await bvFinalize({
        run_id: runC.run_id,
        stage_id: stageD.stage_id, // stageD belongs to runD, not runC
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

    // Persist errors severity.
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

// ─── PP-BV-ISO: degrade-open "unavailable" outcome ──────────────────────────
console.log("\nPP-BV-ISO: browser-unavailable degrade-open gate");

await record("engine_status=unavailable -> severity=unavailable (NOT errors)", async () => {
  const project = makeProject();
  try {
    const { run, stage } = await bootstrap(project);
    const result = await bvFinalize({
      run_id: run.run_id, stage_id: stage.stage_id,
      engine_status: "unavailable",
      unavailable_reason: "playwright unavailable: Executable doesn't exist",
      findings: [],
    });
    assert.equal(result.severity, "unavailable");
    assert.equal(result.effective_severity, "unavailable");
  } finally { rmSync(project, { recursive: true, force: true }); }
});

await record("unavailable does NOT block finalize(passed) — code commits", async () => {
  const project = makeProject();
  try {
    const { runs, run, stage } = await bootstrap(project);
    await bvFinalize({
      run_id: run.run_id, stage_id: stage.stage_id,
      engine_status: "unavailable", unavailable_reason: "live-Chrome conflict", findings: [],
    });
    const readiness = runs.getStageFinalizeReadiness(stage.stage_id);
    const blocker = readiness.blockers.find(b => b.gate === "browser_validation");
    assert.equal(blocker, undefined, "unavailable BV must NOT raise a browser_validation blocker");
  } finally { rmSync(project, { recursive: true, force: true }); }
});

await record("ratchet: errors-then-unavailable -> effective stays errors (never downgrades)", async () => {
  const project = makeProject();
  try {
    const { run, stage } = await bootstrap(project);
    const r1 = await bvFinalize({
      run_id: run.run_id, stage_id: stage.stage_id,
      findings: [{ route: "/x", step: "load", status: "fail", console_errors: ["crash"], network_errors: [] }],
    });
    assert.equal(r1.effective_severity, "errors");
    const r2 = await bvFinalize({
      run_id: run.run_id, stage_id: stage.stage_id,
      engine_status: "unavailable", unavailable_reason: "later flake", findings: [],
    });
    assert.equal(r2.severity, "unavailable", "this-call severity is unavailable");
    assert.equal(r2.effective_severity, "errors", "errors ratchet must NOT be downgraded by a later unavailable run");
  } finally { rmSync(project, { recursive: true, force: true }); }
});

await record("ratchet: unavailable-then-clean -> effective upgrades to clean (real evidence wins)", async () => {
  const project = makeProject();
  try {
    const { run, stage } = await bootstrap(project);
    const r1 = await bvFinalize({
      run_id: run.run_id, stage_id: stage.stage_id,
      engine_status: "unavailable", unavailable_reason: "first try no browser", findings: [],
    });
    assert.equal(r1.effective_severity, "unavailable");
    const r2 = await bvFinalize({
      run_id: run.run_id, stage_id: stage.stage_id,
      findings: [{ route: "/", step: "load", status: "pass", console_errors: [], network_errors: [] }],
    });
    assert.equal(r2.severity, "clean");
    assert.equal(r2.effective_severity, "clean", "a genuine clean run upgrades out of the evidence gap");
  } finally { rmSync(project, { recursive: true, force: true }); }
});

// ─── VG-2 strict shape (residual #3) ────────────────────────────────────────
console.log("\nVG-2 residual #3: strict shape fail-closed");

await record("#3: taxonomy empty object {} -> blocked (missing sections)", async () => {
  const project = makeProject();
  try {
    const { runs, run } = await bootstrap(project, { taxonomy_mapping_json: "{}" });
    let threw = false;
    try { runs.finalizeRun({ run_id: run.run_id, status: "complete" }); }
    catch (err) { threw = true; assert.match(err.message, /PP-VG-2/); assert.match(err.message, /sections/); }
    assert.ok(threw, "must throw on empty object");
  } finally { rmSync(project, { recursive: true, force: true }); }
});

await record("#3: taxonomy sections=null -> blocked", async () => {
  const project = makeProject();
  try {
    const { runs, run } = await bootstrap(project, { taxonomy_mapping_json: JSON.stringify({ sections: null }) });
    let threw = false;
    try { runs.finalizeRun({ run_id: run.run_id, status: "complete" }); }
    catch (err) { threw = true; assert.match(err.message, /PP-VG-2/); }
    assert.ok(threw);
  } finally { rmSync(project, { recursive: true, force: true }); }
});

await record("#3: taxonomy top-level is an array -> blocked", async () => {
  const project = makeProject();
  try {
    const { runs, run } = await bootstrap(project, { taxonomy_mapping_json: "[]" });
    let threw = false;
    try { runs.finalizeRun({ run_id: run.run_id, status: "complete" }); }
    catch (err) { threw = true; assert.match(err.message, /PP-VG-2/); }
    assert.ok(threw);
  } finally { rmSync(project, { recursive: true, force: true }); }
});

await record("#3: taxonomy top-level is a primitive (string) -> blocked", async () => {
  const project = makeProject();
  try {
    const { runs, run } = await bootstrap(project, { taxonomy_mapping_json: '"hello"' });
    let threw = false;
    try { runs.finalizeRun({ run_id: run.run_id, status: "complete" }); }
    catch (err) { threw = true; assert.match(err.message, /PP-VG-2/); }
    assert.ok(threw);
  } finally { rmSync(project, { recursive: true, force: true }); }
});

await record("#3: section entry is not an object (string in sections array) -> blocked", async () => {
  const project = makeProject();
  try {
    const { runs, run } = await bootstrap(project, {
      taxonomy_mapping_json: JSON.stringify({ sections: ["not-an-object"] }),
    });
    let threw = false;
    try { runs.finalizeRun({ run_id: run.run_id, status: "complete" }); }
    catch (err) { threw = true; assert.match(err.message, /PP-VG-2/); }
    assert.ok(threw);
  } finally { rmSync(project, { recursive: true, force: true }); }
});

await record("#3: section.required_artifacts is not an array (string) -> blocked", async () => {
  const project = makeProject();
  try {
    const { runs, run } = await bootstrap(project, {
      taxonomy_mapping_json: JSON.stringify({
        sections: [{ id: "4.4", required_artifacts: "openapi" }],
      }),
    });
    let threw = false;
    try { runs.finalizeRun({ run_id: run.run_id, status: "complete" }); }
    catch (err) { threw = true; assert.match(err.message, /PP-VG-2/); assert.match(err.message, /required_artifacts/); }
    assert.ok(threw);
  } finally { rmSync(project, { recursive: true, force: true }); }
});

await record("#3: section.required_artifacts entry is not a string (number) -> blocked", async () => {
  const project = makeProject();
  try {
    const { runs, run } = await bootstrap(project, {
      taxonomy_mapping_json: JSON.stringify({
        sections: [{ id: "4.4", required_artifacts: [42] }],
      }),
    });
    let threw = false;
    try { runs.finalizeRun({ run_id: run.run_id, status: "complete" }); }
    catch (err) { threw = true; assert.match(err.message, /PP-VG-2/); }
    assert.ok(threw);
  } finally { rmSync(project, { recursive: true, force: true }); }
});

await record("#3: profile_snapshot top-level is an array -> blocked", async () => {
  const project = makeProject();
  try {
    const { runs, run } = await bootstrap(project, { profile_snapshot_json: "[1,2,3]" });
    let threw = false;
    try { runs.finalizeRun({ run_id: run.run_id, status: "complete" }); }
    catch (err) { threw = true; assert.match(err.message, /PP-VG-2/); assert.match(err.message, /profile_snapshot_json/); }
    assert.ok(threw);
  } finally { rmSync(project, { recursive: true, force: true }); }
});

await record("#3: profile required_artifacts not an array (object) -> blocked", async () => {
  const project = makeProject();
  try {
    const { runs, run } = await bootstrap(project, {
      profile_snapshot_json: JSON.stringify({ name: "api-platform", required_artifacts: { kind: "sbom" } }),
    });
    let threw = false;
    try { runs.finalizeRun({ run_id: run.run_id, status: "complete" }); }
    catch (err) { threw = true; assert.match(err.message, /PP-VG-2/); assert.match(err.message, /required_artifacts/); }
    assert.ok(threw);
  } finally { rmSync(project, { recursive: true, force: true }); }
});

await record("#3: NULL taxonomy snapshot -> NOT blocked (legitimate absent)", async () => {
  const project = makeProject();
  try {
    // No taxonomy_mapping_json set — NULL in DB. Must not block.
    const { runs, run } = await bootstrap(project);
    const result = runs.finalizeRun({ run_id: run.run_id, status: "complete" });
    assert.equal(result.effective_status, "complete");
  } finally { rmSync(project, { recursive: true, force: true }); }
});

await record("#3: valid taxonomy with sections array but no required_artifacts -> NOT blocked", async () => {
  const project = makeProject();
  try {
    const { runs, run } = await bootstrap(project, {
      taxonomy_mapping_json: JSON.stringify({
        scope: "standard", signals: [],
        sections: [{ id: "4.4", title: "T", rationale: "r" }],
        missability_required: [],
      }),
    });
    // No required_artifacts declared -> no kinds needed -> not blocked.
    const result = runs.finalizeRun({ run_id: run.run_id, status: "complete" });
    assert.equal(result.effective_status, "complete");
  } finally { rmSync(project, { recursive: true, force: true }); }
});

// ─── VG-3 report ratchet for all severities (residual #6) ───────────────────
console.log("\nVG-3 residual #6: report ratchet for all severity transitions");

await record("#6: clean -> warnings -> effective_report_path is warnings report", async () => {
  const project = makeProject();
  try {
    const { run, stage } = await bootstrap(project);

    // Call 1: clean
    const r1 = await bvFinalize({
      run_id: run.run_id, stage_id: stage.stage_id,
      findings: [{ route: "/", step: "load", status: "pass", console_errors: [], network_errors: [] }],
    });
    assert.equal(r1.effective_severity, "clean");

    // Call 2: warnings (warn status)
    const r2 = await bvFinalize({
      run_id: run.run_id, stage_id: stage.stage_id,
      findings: [{ route: "/api", step: "check", status: "warn", console_errors: [], network_errors: [] }],
    });
    assert.equal(r2.severity, "warnings");
    assert.equal(r2.effective_severity, "warnings");
    // effective_report_path must be the warnings report (rank 1 >= rank 0 of clean)
    assert.equal(r2.effective_report_path, r2.report_path,
      "warnings call should promote effective_report_path to its own report");
  } finally { rmSync(project, { recursive: true, force: true }); }
});

await record("#6: clean -> warnings -> clean -> effective_report_path stays warnings", async () => {
  const project = makeProject();
  try {
    const { run, stage } = await bootstrap(project);

    await bvFinalize({
      run_id: run.run_id, stage_id: stage.stage_id,
      findings: [{ route: "/", step: "load", status: "pass", console_errors: [], network_errors: [] }],
    });
    const r2 = await bvFinalize({
      run_id: run.run_id, stage_id: stage.stage_id,
      findings: [{ route: "/api", step: "check", status: "warn", console_errors: [], network_errors: [] }],
    });
    const warningsReport = r2.report_path;

    // Call 3: clean — must NOT replace the warnings report
    const r3 = await bvFinalize({
      run_id: run.run_id, stage_id: stage.stage_id,
      findings: [{ route: "/", step: "load", status: "pass", console_errors: [], network_errors: [] }],
    });
    assert.equal(r3.severity, "clean");
    assert.equal(r3.effective_severity, "warnings", "ratchet must not downgrade");
    assert.equal(r3.effective_report_path, warningsReport,
      "effective_report_path must stay at warnings report after a clean call");
  } finally { rmSync(project, { recursive: true, force: true }); }
});

await record("#6: warnings -> warnings -> newer warnings report retained", async () => {
  const project = makeProject();
  try {
    const { run, stage } = await bootstrap(project);

    const r1 = await bvFinalize({
      run_id: run.run_id, stage_id: stage.stage_id,
      findings: [{ route: "/api", step: "check", status: "warn", console_errors: [], network_errors: [] }],
    });
    const firstWarn = r1.report_path;

    // Call 2: also warnings — same rank, so promote to newer report
    const r2 = await bvFinalize({
      run_id: run.run_id, stage_id: stage.stage_id,
      findings: [{ route: "/api2", step: "check2", status: "warn", console_errors: [], network_errors: [] }],
    });
    assert.equal(r2.severity, "warnings");
    assert.equal(r2.effective_severity, "warnings");
    assert.equal(r2.effective_report_path, r2.report_path,
      "second warnings call promotes to its own (newer) report");
    assert.notEqual(r2.effective_report_path, firstWarn,
      "newer warnings report replaces older warnings report");
  } finally { rmSync(project, { recursive: true, force: true }); }
});

// ─── #3 empty/whitespace snapshot consistency ────────────────────────────────
console.log("\n#3 residual: empty/whitespace snapshot treated as absent");

await record("#3: taxonomy_mapping_json='' (empty string) -> NOT blocked (absent)", async () => {
  const project = makeProject();
  try {
    const { runs, db, run } = await bootstrap(project);
    // Write empty string directly — bootstrap sets null, override it.
    db().prepare(`UPDATE runs SET taxonomy_mapping_json = '' WHERE id = ?`).run(run.run_id);
    const result = runs.finalizeRun({ run_id: run.run_id, status: "complete" });
    assert.equal(result.effective_status, "complete", "empty string must be treated as absent");
  } finally { rmSync(project, { recursive: true, force: true }); }
});

await record("#3: taxonomy_mapping_json='   ' (whitespace) -> NOT blocked (absent)", async () => {
  const project = makeProject();
  try {
    const { runs, db, run } = await bootstrap(project);
    db().prepare(`UPDATE runs SET taxonomy_mapping_json = '   ' WHERE id = ?`).run(run.run_id);
    const result = runs.finalizeRun({ run_id: run.run_id, status: "complete" });
    assert.equal(result.effective_status, "complete", "whitespace must be treated as absent");
  } finally { rmSync(project, { recursive: true, force: true }); }
});

await record("#3: profile_snapshot_json='' (empty string) -> NOT blocked (absent)", async () => {
  const project = makeProject();
  try {
    const { runs, db, run } = await bootstrap(project);
    db().prepare(`UPDATE runs SET profile_snapshot_json = '' WHERE id = ?`).run(run.run_id);
    const result = runs.finalizeRun({ run_id: run.run_id, status: "complete" });
    assert.equal(result.effective_status, "complete", "empty string must be treated as absent");
  } finally { rmSync(project, { recursive: true, force: true }); }
});

await record("#3: profile_snapshot_json='  ' (whitespace) -> NOT blocked (absent)", async () => {
  const project = makeProject();
  try {
    const { runs, db, run } = await bootstrap(project);
    db().prepare(`UPDATE runs SET profile_snapshot_json = '  ' WHERE id = ?`).run(run.run_id);
    const result = runs.finalizeRun({ run_id: run.run_id, status: "complete" });
    assert.equal(result.effective_status, "complete", "whitespace must be treated as absent");
  } finally { rmSync(project, { recursive: true, force: true }); }
});

// ─── VG-3 non-object notes_json guard ────────────────────────────────────────
console.log("\nVG-3 residual: non-object notes_json must not drop error severity");

await record("VG-3: array notes_json '[]' + errors call -> effective_severity=errors preserved", async () => {
  const project = makeProject();
  try {
    const { runs, db, run, stage } = await bootstrap(project);
    // Corrupt the stage's notes_json to be an array (valid JSON, wrong type).
    db().prepare(`UPDATE stages SET notes_json = '[]' WHERE id = ?`).run(stage.stage_id);

    // Call with errors findings — error severity must be persisted despite bad existing notes.
    const result = await bvFinalize({
      run_id: run.run_id, stage_id: stage.stage_id,
      findings: [{
        route: "/api", step: "load", status: "pass",
        console_errors: [],
        network_errors: [{ url: "http://x/api", status: 500 }],
      }],
    });
    assert.equal(result.severity, "errors");
    assert.equal(result.effective_severity, "errors",
      "errors severity must survive when existing notes_json is a non-object");

    // Verify the written notes_json is now a proper object with the severity.
    const row = db().prepare(`SELECT notes_json FROM stages WHERE id = ?`).get(stage.stage_id);
    const notes = JSON.parse(row.notes_json);
    assert.equal(typeof notes, "object");
    assert.ok(!Array.isArray(notes));
    assert.equal(notes.browser_validation_severity, "errors");
  } finally { rmSync(project, { recursive: true, force: true }); }
});

await record("VG-3: string notes_json '\"x\"' + errors call -> effective_severity=errors preserved", async () => {
  const project = makeProject();
  try {
    const { runs, db, run, stage } = await bootstrap(project);
    db().prepare(`UPDATE stages SET notes_json = '"x"' WHERE id = ?`).run(stage.stage_id);

    const result = await bvFinalize({
      run_id: run.run_id, stage_id: stage.stage_id,
      findings: [{ route: "/", step: "load", status: "fail", console_errors: ["boom"], network_errors: [] }],
    });
    assert.equal(result.effective_severity, "errors");
  } finally { rmSync(project, { recursive: true, force: true }); }
});

await record("VG-3: array notes_json '[]' + clean call -> prevSeverity=errors -> effective=errors", async () => {
  // Non-object notes is treated as unknown/errors for prevSeverity.
  // Even a clean new call must result in effective_severity=errors (fail-closed).
  const project = makeProject();
  try {
    const { runs, db, run, stage } = await bootstrap(project);
    db().prepare(`UPDATE stages SET notes_json = '[]' WHERE id = ?`).run(stage.stage_id);

    const result = await bvFinalize({
      run_id: run.run_id, stage_id: stage.stage_id,
      findings: [{ route: "/", step: "load", status: "pass", console_errors: [], network_errors: [] }],
    });
    assert.equal(result.severity, "clean", "this-call severity is clean");
    assert.equal(result.effective_severity, "errors",
      "non-object existing notes forces prevSeverity=errors so effective stays errors");
  } finally { rmSync(project, { recursive: true, force: true }); }
});

await record("VG-3: getStageFinalizeReadiness blocks on array notes_json '[]'", async () => {
  const project = makeProject();
  try {
    const { runs, db, run, stage } = await bootstrap(project);
    // Write array notes_json directly (simulates corruption after prior writes).
    db().prepare(`UPDATE stages SET notes_json = '[]' WHERE id = ?`).run(stage.stage_id);

    const readiness = runs.getStageFinalizeReadiness(stage.stage_id);
    assert.equal(readiness.can_pass, false,
      "non-object notes_json must block finalize(passed)");
    const blocker = readiness.blockers.find(b => b.gate === "browser_validation");
    assert.ok(blocker, "browser_validation blocker must fire on non-object notes");
  } finally { rmSync(project, { recursive: true, force: true }); }
});

// ─── Summary ────────────────────────────────────────────────────────────────
console.log();
console.log(`${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
