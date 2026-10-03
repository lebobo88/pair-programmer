// Shared setup/helpers for finalize-gates-a1.unit.mjs and
// finalize-gates-a2.unit.mjs (split from a single 975-line
// finalize-gates-a.unit.mjs so the two halves run in roughly equal wall
// clock -- see AGENTS.md ANTI-STALL TEST RULE).
//
// Deliberately named *.mjs, NOT *.unit.mjs: daemon/scripts/run-tests.mjs and
// npm test's `test/*.unit.mjs` glob both pick up files by that suffix alone,
// and this module holds no assertions of its own -- it must not be invoked
// directly by `node --test`.
//
// IMPORTANT: this module must never import anything from dist/ at
// module-evaluation time. Each entry file sets its own isolated PP_HOME
// (mirroring the original finalize-gates-a.unit.mjs's direct-PP_HOME
// approach) BEFORE its first call into importDist()/bootstrap()/etc., and
// that ordering only holds if this module stays side-effect-free at import
// time.

import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import assert from "node:assert/strict";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DIST = join(__dirname, "..", "..", "dist");

export const importDist = (relPath) => import(pathToFileURL(join(DIST, relPath)).href);

/** Fresh pass/fail recorder -- one instance per entry file. */
export function makeRecorder() {
  let passed = 0;
  let failed = 0;
  async function record(name, fn) {
    try {
      await fn();
      console.log(`\u2713 ${name}`);
      passed++;
    } catch (err) {
      console.error(`\u2717 ${name}`);
      console.error(`  ${err.stack ?? err.message}`);
      failed++;
    }
  }
  return { record, counts: () => ({ passed, failed }) };
}

/** Create a fresh temp project dir with the minimal scaffolding. */
export function makeProject() {
  const dir = mkdtempSync(join(tmpdir(), "pp-fg-proj-"));
  mkdirSync(join(dir, ".harness"), { recursive: true });
  writeFileSync(join(dir, "AGENTS.md"), "# AGENTS\n", "utf8");
  return dir;
}

/** Boot a run + one stage, return { runs, db, run, stage }. */
export async function bootstrap(project, { stagekind = "code", profile_snapshot_json = null, taxonomy_mapping_json = null } = {}) {
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

/**
 * Populate the PROJECT_MASTER.md sections that PP-VG-1 holds responsible for a
 * given taxonomy mapping.
 *
 * Why this helper exists: PP-VG-1 (master-plan coverage) runs BEFORE PP-VG-2
 * (artifact availability) inside finalizeRun. Every taxonomy section in
 * taxonomy.ts carries a `master_plan_section`, so any fixture that declares a
 * taxonomy mapping and then expects finalize(complete) to SUCCEED will trip
 * VG-1 first and never reach the VG-2 assertion it means to test. Two fixtures
 * below used taxonomy section 4.4, whose responsible section is
 * '9. UX/UI/content design', and failed with CompletionChecklistGateViolation
 * instead of exercising VG-2 at all.
 *
 * Populating the section (rather than dropping the taxonomy mapping) keeps the
 * VG-2 path genuinely exercised: the run still declares required_artifacts, the
 * gate still resolves them from the snapshot, and the finalize call still runs.
 */
export async function populateMasterPlanSections(project, runId, sections) {
  const { applyMasterPlanPatch, masterPlanStatus } = await importDist("orchestrator/master-plan.js");
  for (const section of sections) {
    const r = applyMasterPlanPatch({
      run_id: runId,
      project_path: project,
      section,
      kind: "update",
      content_md: `Populated by finalize-gates-a fixture so PP-VG-1 is satisfied and PP-VG-2 is reachable.`,
    });
    assert.notEqual(r.status, "rejected_unknown_section", `section '${section}' must resolve: ${r.reason ?? ""}`);
  }
  // Fail loudly if the population did not take — otherwise a silent VG-1
  // failure would look like a VG-2 failure again.
  const status = masterPlanStatus(project);
  for (const section of sections) {
    const row = status.sections.find(s => s.section === section);
    assert.ok(row?.populated, `master-plan section '${section}' must be populated for this fixture`);
  }
}

/** Thin wrapper around browserValidationFinalize. */
export async function bvFinalize({ run_id, stage_id, findings = [], engine = "playwright", engine_status, unavailable_reason } = {}) {
  const bv = await importDist("orchestrator/browser-validation.js");
  return bv.browserValidationFinalize({ run_id, stage_id, engine, findings, engine_status, unavailable_reason });
}
