/**
 * finalize-gates-a2.unit.mjs
 *
 * Self-contained unit tests for the residual/regression cases of the VG-2
 * and VG-3 finalize gates, plus the browser-unavailable degrade-open gate
 * (second half of the original finalize-gates-a.unit.mjs, split for
 * balanced per-file wall clock -- see AGENTS.md ANTI-STALL TEST RULE).
 * The primary VG-7/VG-2/VG-3 happy-path and first-line regression cases
 * live in finalize-gates-a1.unit.mjs. Shared setup/helpers live in
 * test/fixtures/finalize-gates-helpers.mjs.
 *
 *   PP-BV-ISO: browserValidationFinalize degrade-open "unavailable" outcome
 *              never counts as errors and never blocks finalize(passed);
 *              the severity ratchet still never downgrades from errors.
 *   VG-2 residual #3: strict-shape fail-closed validation of
 *              taxonomy_mapping_json / profile_snapshot_json (wrong types,
 *              empty/whitespace treated as absent).
 *   VG-3 residual #6: report-path ratchet across every severity transition
 *              (clean/warnings), not just clean/errors.
 *   VG-3 residual: non-object notes_json (corruption) must not silently
 *              drop a persisted errors severity.
 *
 * Anti-stall contract:
 *   - Uses a temp sqlite DB (PP_HOME override), direct dist function calls.
 *   - No MCP server, no daemon socket, no smoke files touched.
 *   - Run: node test/finalize-gates-a2.unit.mjs  (NO --test flag)
 */

import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";

// Set PP_HOME BEFORE any dist import so the DB is isolated.
const SUITE_DIR = mkdtempSync(join(tmpdir(), "pp-finalize-gates-a2-"));
mkdirSync(join(SUITE_DIR, ".pair-programmer"), { recursive: true });
process.env.PP_HOME = SUITE_DIR;
process.env.EIGHTS_SKIP_AUDIT_CHECK = "1";

const { makeRecorder, makeProject, bootstrap, populateMasterPlanSections, bvFinalize } =
  await import("./fixtures/finalize-gates-helpers.mjs");

const { record, counts } = makeRecorder();

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
    await populateMasterPlanSections(project, run.run_id, ["9. UX/UI/content design"]);
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

    const r1 = await bvFinalize({
      run_id: run.run_id, stage_id: stage.stage_id,
      findings: [{ route: "/", step: "load", status: "pass", console_errors: [], network_errors: [] }],
    });
    assert.equal(r1.effective_severity, "clean");

    const r2 = await bvFinalize({
      run_id: run.run_id, stage_id: stage.stage_id,
      findings: [{ route: "/api", step: "check", status: "warn", console_errors: [], network_errors: [] }],
    });
    assert.equal(r2.severity, "warnings");
    assert.equal(r2.effective_severity, "warnings");
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
    db().prepare(`UPDATE stages SET notes_json = '[]' WHERE id = ?`).run(stage.stage_id);

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
const { passed, failed } = counts();
console.log(`${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
