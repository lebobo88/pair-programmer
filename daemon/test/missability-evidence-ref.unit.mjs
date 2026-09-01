// Unit test for R3-tail post-mortem Fix 1.2: missability accepts evidence_ref
// and falls back through project_path → .harness/<run_id>/ → evidence_ref.

import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import assert from "node:assert/strict";

const SUITE_DIR = mkdtempSync(join(tmpdir(), "pp-missability-evref-"));
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
  const dir = mkdtempSync(join(tmpdir(), "pp-evref-proj-"));
  mkdirSync(join(dir, ".harness"), { recursive: true });
  writeFileSync(join(dir, "AGENTS.md"), "# AGENTS\n", "utf8");
  return dir;
}

await record("evidence_ref resolves to a project-tree file when patch path is empty", async () => {
  const project = setupProject();
  try {
    const runs = await importDist("orchestrator/runs.js");
    const miss = await importDist("orchestrator/missability.js");
    const run = await runs.ensureRun({
      request_text: "evref test",
      project_path: project,
      mode: "single",
    });
    const stage = await runs.startStage({
      run_id: run.run_id,
      kind: "spec",
      gate_type: "spec",
    });

    // Write the substantive intent to docs/decisions/DR-test.md in the project tree.
    mkdirSync(join(project, "docs", "decisions"), { recursive: true });
    writeFileSync(
      join(project, "docs", "decisions", "DR-test.md"),
      "## NFRs\nSLO p99 latency: 200ms\nThroughput: 1000 rps\n",
      "utf8",
    );

    // Archive an artifact with a patch path that does NOT exist in the project,
    // but with evidence_ref pointing at the DR.
    await runs.archiveArtifact({
      run_id: run.run_id,
      stage_id: stage.stage_id,
      kind: "spec",
      relative_path: "spec/patch.md",
      bytes: "(patch contents — not the source of truth)",
      evidence_ref: "docs/decisions/DR-test.md",
    });

    // Run missability with a check that scans for "latency". Before the fix,
    // this would silently fail because the patch under .harness doesn't
    // contain the keyword. After the fix, evidence_ref's content matches.
    const result = miss.runMissabilityChecks({
      run_id: run.run_id,
      required_check_ids: ["nfrs-declared"],
    });
    const nfrCheck = result.results.find(r => r.check_id === "nfrs-declared");
    assert.equal(nfrCheck?.status, "pass",
      `nfrs-declared should pass via evidence_ref; got ${nfrCheck?.status} (${nfrCheck?.evidence})`);
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

await record("run-archive fallback resolves to .harness/<run_id>/ when project tree is empty", async () => {
  const project = setupProject();
  try {
    const runs = await importDist("orchestrator/runs.js");
    const miss = await importDist("orchestrator/missability.js");
    const run = await runs.ensureRun({
      request_text: "harness-archive test",
      project_path: project,
      mode: "single",
    });
    const stage = await runs.startStage({
      run_id: run.run_id,
      kind: "spec",
      gate_type: "spec",
    });

    // archiveArtifact writes to <project>/.harness/<run_id>/<relative_path>
    // and stores `relative_path` in artifacts.path. The fallback cascade
    // (resolveCandidates step 2) joins project + .harness + run_id + relative.
    // The file already lives there as a side-effect of archiveArtifact.
    await runs.archiveArtifact({
      run_id: run.run_id,
      stage_id: stage.stage_id,
      kind: "spec",
      relative_path: "spec/nfrs.md",
      bytes: "## NFRs\nSLO p99 latency: 200ms\nAvailability: 99.9%\n",
      // NO evidence_ref — relies on the .harness fallback step 2 working.
    });

    const result = miss.runMissabilityChecks({
      run_id: run.run_id,
      required_check_ids: ["nfrs-declared"],
    });
    const nfrCheck = result.results.find(r => r.check_id === "nfrs-declared");
    assert.equal(nfrCheck?.status, "pass",
      `nfrs-declared should pass via .harness fallback; got ${nfrCheck?.status}`);
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

await record("PP-BV-ISO: browser_validation_report severity=unavailable -> evidence gap (fail)", async () => {
  const project = setupProject();
  try {
    const runs = await importDist("orchestrator/missability.js");
    const r = await importDist("orchestrator/runs.js");
    const m = runs; // missability module
    const run = await r.ensureRun({ request_text: "bv-unavailable", project_path: project, mode: "single" });
    const stage = await r.startStage({ run_id: run.run_id, kind: "browser_validation", gate_type: "contract" });

    // A degrade-open report: the browser could not run. The check MUST surface
    // this as a gap (NOT a pass) so the run is downgraded to "surfaced".
    await r.archiveArtifact({
      run_id: run.run_id,
      stage_id: stage.stage_id,
      kind: "browser_validation_report",
      relative_path: "browser-validation/report-unavailable.md",
      bytes: "# Browser validation report\n\nseverity: unavailable\nengine: playwright\nengine_status: unavailable\nevidence_gap: true\nreason: playwright unavailable\n",
    });

    const result = m.runMissabilityChecks({
      run_id: run.run_id,
      required_check_ids: ["browser-validation-evidence"],
    });
    const bv = result.results.find(x => x.check_id === "browser-validation-evidence");
    assert.equal(bv?.status, "fail",
      `unavailable BV must surface as a gap; got ${bv?.status} (${bv?.evidence})`);
    assert.match(bv.evidence, /unavailable/, "evidence should name the unavailable gap");
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

// ─── severity: not_applicable (justified) ──────────────────────────────────
//
// Regression guards for the "no honest value to write" gap: bug-fix-team lists
// browser-validation-evidence in missability_required unconditionally, while
// its profiles_compatible includes non-ui-cli / sdk / data-product / embedded.
// not_applicable is the honest state — but it must carry a justification or it
// is a rubber stamp any run can self-issue.

/** Archive one browser_validation_report and run the BV missability check. */
async function bvCheck(label, reportBody) {
  const project = setupProject();
  try {
    const m = await importDist("orchestrator/missability.js");
    const r = await importDist("orchestrator/runs.js");
    const run = await r.ensureRun({ request_text: label, project_path: project, mode: "single" });
    const stage = await r.startStage({ run_id: run.run_id, kind: "browser_validation", gate_type: "contract" });
    await r.archiveArtifact({
      run_id: run.run_id,
      stage_id: stage.stage_id,
      kind: "browser_validation_report",
      relative_path: `browser-validation/report-${Math.random().toString(36).slice(2)}.md`,
      bytes: reportBody,
    });
    const result = m.runMissabilityChecks({
      run_id: run.run_id,
      required_check_ids: ["browser-validation-evidence"],
    });
    return result.results.find(x => x.check_id === "browser-validation-evidence");
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
}

await record("severity=not_applicable with a reason: line -> pass", async () => {
  const bv = await bvCheck(
    "bv-na-reason",
    "# Browser validation report\n\nseverity: not_applicable\nreason: this is a non-ui-cli project; there is no web surface to exercise\n",
  );
  assert.equal(bv?.status, "pass", `justified not_applicable must pass; got ${bv?.status} (${bv?.evidence})`);
  assert.match(bv.evidence, /not_applicable/);
});

await record("severity=not_applicable with a '## Why this stage does not apply' section -> pass", async () => {
  const bv = await bvCheck(
    "bv-na-section",
    "# Browser validation report\n\nseverity: not_applicable\n\n## Why this stage does not apply\n\nThe deliverable is an npm SDK. No HTTP server or DOM is produced by the build.\n",
  );
  assert.equal(bv?.status, "pass", `justified not_applicable must pass; got ${bv?.status} (${bv?.evidence})`);
});

await record("bare severity=not_applicable (no justification) -> FAIL (no rubber stamp)", async () => {
  const bv = await bvCheck("bv-na-bare", "# Browser validation report\n\nseverity: not_applicable\n");
  assert.equal(bv?.status, "fail", `bare not_applicable must NOT pass; got ${bv?.status} (${bv?.evidence})`);
  assert.match(bv.evidence, /no justification/i);
});

await record("severity=not_applicable with an EMPTY reason: line -> FAIL", async () => {
  const bv = await bvCheck("bv-na-empty", "# Browser validation report\n\nseverity: not_applicable\nreason:   \n");
  assert.equal(bv?.status, "fail", `empty reason must NOT pass; got ${bv?.status} (${bv?.evidence})`);
});

await record("severity=not_applicable with an EMPTY justification section -> FAIL", async () => {
  const bv = await bvCheck(
    "bv-na-empty-section",
    "# Browser validation report\n\nseverity: not_applicable\n\n## Why this stage does not apply\n\n## Next\n\nnothing\n",
  );
  assert.equal(bv?.status, "fail", `empty justification section must NOT pass; got ${bv?.status} (${bv?.evidence})`);
});

await record("severity=errors still fails even with a reason: line", async () => {
  const bv = await bvCheck(
    "bv-errors-reason",
    "# Browser validation report\n\nseverity: errors\nreason: we would rather not fix this\n",
  );
  assert.equal(bv?.status, "fail", "errors must remain a hard fail regardless of justification");
  assert.match(bv.evidence, /errors/);
});

await record("severity=unavailable still fails even with a reason: line", async () => {
  const bv = await bvCheck(
    "bv-unavail-reason",
    "# Browser validation report\n\nseverity: unavailable\nreason: playwright missing\n",
  );
  assert.equal(bv?.status, "fail", "unavailable must remain a gap regardless of justification");
  assert.match(bv.evidence, /unavailable/);
});

console.log();
console.log(`${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
