/**
 * TDD pre-fix repro: 3 assertions, one per bug.
 * Expected pre-fix outcome : all_fail (all 3 assertions fail against current broken code).
 * Expected post-fix outcome: all_pass (all 3 assertions pass after fixes land).
 *
 * Output format: TAP-style lines ("ok N - desc" / "not ok N - desc") followed by
 * a TAP summary block ("# tests N / # pass N / # fail N") so the platform's
 * TDD gate classifies the run correctly regardless of test_runner="other".
 *
 * Do NOT add non-repro assertions here — keep it to exactly 3, one per bug,
 * each of which is a clean all_fail → all_pass transition.
 * Broader regression coverage lives in test/bug-fix-full.unit.mjs.
 */

import { strict as assert } from "node:assert";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DIST = join(__dirname, "..", "dist");
const importDist = (rel) => import(pathToFileURL(join(DIST, rel)).href);

let testNum = 0;
let failed = 0;

async function tapTest(desc, fn) {
  testNum++;
  try {
    await fn();
    console.log(`ok ${testNum} - ${desc}`);
  } catch (e) {
    failed++;
    console.log(`not ok ${testNum} - ${desc}`);
    console.error(`  # ${e.message}`);
  }
}

// ─── BUG-1: archiveArtifact doubled-path repro ────────────────────────────
// Repro: runs.js must export normalizeArtifactRelPath() that strips the
// leading redundant ".harness/<runId>/" prefix from relative_path.
// Pre-fix : not exported → typeof check fails.
// Post-fix: exported and strips the prefix correctly (AC1-1).
await tapTest(
  "BUG-1: runs.js exports normalizeArtifactRelPath and strips the redundant .harness/<runId>/ prefix (AC1-1)",
  async () => {
    const mod = await importDist("orchestrator/runs.js");
    assert.equal(
      typeof mod.normalizeArtifactRelPath,
      "function",
      "normalizeArtifactRelPath must be exported from runs.js (BUG-1 fix absent)",
    );
    const runId = "run_TESTBUG1xyz";
    const redundant = `.harness/${runId}/code/winner.diff`;
    const result = mod.normalizeArtifactRelPath(runId, redundant);
    assert.equal(
      result,
      "code/winner.diff",
      `normalizeArtifactRelPath("${runId}", "${redundant}") should return "code/winner.diff" but got "${result}"`,
    );
  },
);

// ─── BUG-2: stale-artifact missability repro ──────────────────────────────
// Repro (AC2-1): two browser_validation_report artifacts under the SAME
// stage_id, older with severity: errors, newer with severity: clean.
// Pre-fix : evaluate() picks the error report (flat find, no recency) → "fail".
// Post-fix: evaluate() picks only the latest per stage_id (clean) → "pass".
await tapTest(
  "BUG-2: browser-validation-evidence uses latest-per-stage-id recency (older errors + newer clean = pass, AC2-1)",
  async () => {
    const mod = await importDist("orchestrator/missability.js");
    const check = mod.CHECK_DEFINITIONS.find((c) => c.id === "browser-validation-evidence");
    assert.ok(check, "browser-validation-evidence check must exist in CHECK_DEFINITIONS");

    const artifacts = [
      {
        path: "stage-A-old.md",
        kind: "browser_validation_report",
        text: "severity: errors\n",
        stage_id: "stage-AAAAA",
        created_at: "2024-01-01T10:00:00.000Z",
      },
      {
        path: "stage-A-new.md",
        kind: "browser_validation_report",
        text: "severity: clean\n",
        stage_id: "stage-AAAAA",
        created_at: "2024-01-01T11:00:00.000Z",
      },
    ];
    const result = check.evaluate(artifacts, { project_path: ".", constitution_sha_at_start: null });
    assert.equal(
      result.status,
      "pass",
      `BUG-2: expected "pass" (newest report for stage-AAAAA is clean) but got "${result.status}" (evidence: ${result.evidence})`,
    );
  },
);

// ─── BUG-3: classify() exit-code cross-check repro ────────────────────────
// Repro (AC3-5): a vitest run that parses as "5 passed / 0 failed" but
// exits with code 1 (crash after tests completed) must be classified as
// "mixed", not "all_pass".
// Pre-fix : classify() returns all_pass when f===0 && p>0 regardless of exitCode.
// Post-fix: classify() cross-checks exitCode; nonzero → "mixed".
await tapTest(
  "BUG-3: parseTestOutcome returns mixed (not all_pass) when exitCode=1 despite parsed zero failures (AC3-5)",
  async () => {
    const mod = await importDist("orchestrator/tdd-gate.js");
    const result = mod.parseTestOutcome("vitest", 1, "Tests  5 passed (5)\n", "");
    assert.equal(
      result.actual,
      "mixed",
      `BUG-3: expected "mixed" (exitCode=1 despite 0 failures parsed) but got "${result.actual}"`,
    );
  },
);

// ─── TAP summary ─────────────────────────────────────────────────────────
console.log(`\n# tests ${testNum}\n# pass ${testNum - failed}\n# fail ${failed}`);
process.exit(failed > 0 ? 1 : 0);
