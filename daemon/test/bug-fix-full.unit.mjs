/**
 * Full regression / acceptance-criteria test suite for the three orchestrator
 * bug fixes (BUG-1 doubled path, BUG-2 stale-artifact missability, BUG-3
 * no TAP parser + classify exit-code cross-check).
 *
 * This file is NOT the TDD-gate command — it covers the broad AC surface and
 * will also legitimately fail on the true-bug assertions before the fix
 * lands. It is added to the package.json `test` script so it runs as part of
 * the regular test suite after the fix.
 *
 * Run manually: node test/bug-fix-full.unit.mjs (requires a fresh `npm run build`)
 *
 * Covered ACs:
 *   BUG-1: AC1-1 through AC1-7 (path normalization)
 *   BUG-2: AC2-1 through AC2-6 (recency-scoped missability)
 *   BUG-3: AC3-1, AC3-2, AC3-3, AC3-5, AC3-6, AC3-7, AC3-8 (node runner + classify)
 */

import { strict as assert } from "node:assert";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DIST = join(__dirname, "..", "dist");
const importDist = (rel) => import(pathToFileURL(join(DIST, rel)).href);

let pass = 0;
let fail = 0;

function it(label, fn) {
  try {
    fn();
    pass++;
    console.log(`✓ ${label}`);
  } catch (err) {
    fail++;
    console.error(`✗ ${label}`);
    console.error(`  ${err.message}`);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// BUG-1: normalizeArtifactRelPath (path normalization)
// ═══════════════════════════════════════════════════════════════════════════

const runsMod = await importDist("orchestrator/runs.js");
const { normalizeArtifactRelPath } = runsMod;

it("BUG-1 — normalizeArtifactRelPath is exported as a function (AC1-1)", () => {
  assert.equal(typeof normalizeArtifactRelPath, "function");
});

const RUN_ID = "run_testBUG1abc_";

it("BUG-1 AC1-1 — redundant prefix stripped: .harness/<runId>/code/winner.diff → code/winner.diff", () => {
  const result = normalizeArtifactRelPath(RUN_ID, `.harness/${RUN_ID}/code/winner.diff`);
  assert.equal(result, "code/winner.diff");
});

it("BUG-1 AC1-2 — no-redundant-prefix input unchanged: code/winner.diff stays code/winner.diff", () => {
  const result = normalizeArtifactRelPath(RUN_ID, "code/winner.diff");
  assert.equal(result, "code/winner.diff");
});

it("BUG-1 AC1-3 — different run_id prefix NOT stripped", () => {
  const otherRunId = "run_OTHER999";
  const input = `.harness/${otherRunId}/x.md`;
  const result = normalizeArtifactRelPath(RUN_ID, input);
  assert.equal(result, input);
});

it("BUG-1 AC1-4 — .harness-notes/ prefix NOT stripped (only exact .harness/<runId>/ match)", () => {
  const input = `.harness-notes/${RUN_ID}/x.md`;
  const result = normalizeArtifactRelPath(RUN_ID, input);
  assert.equal(result, input);
});

it("BUG-1 AC1-5 — double-redundant prefix: only ONE layer stripped (single-strip guarantee)", () => {
  const input = `.harness/${RUN_ID}/.harness/${RUN_ID}/x.md`;
  const result = normalizeArtifactRelPath(RUN_ID, input);
  // Exactly one leading .harness/<runId>/ is stripped; the inner one remains.
  assert.equal(result, `.harness/${RUN_ID}/x.md`);
});

it("BUG-1 AC1-7 — backslash-separator form normalized identically to forward-slash form", () => {
  // Input with Windows-style backslashes in the redundant prefix.
  const inputFwd = `.harness/${RUN_ID}/code/winner.diff`;
  const inputBs = `.harness\\${RUN_ID}\\code\\winner.diff`;
  const resultFwd = normalizeArtifactRelPath(RUN_ID, inputFwd);
  const resultBs = normalizeArtifactRelPath(RUN_ID, inputBs);
  assert.equal(resultFwd, "code/winner.diff");
  // Post-fix the backslash form must produce the same relative leaf as the
  // forward-slash form (separator parity).
  assert.equal(
    resultBs.replaceAll("\\", "/"),
    resultFwd,
    `backslash form should normalize to same path as forward-slash form`,
  );
});

// ═══════════════════════════════════════════════════════════════════════════
// BUG-2: browser-validation-evidence recency scoping
// ═══════════════════════════════════════════════════════════════════════════

const missabilityMod = await importDist("orchestrator/missability.js");
const bvCheck = missabilityMod.CHECK_DEFINITIONS.find((c) => c.id === "browser-validation-evidence");
const CTX = { project_path: ".", constitution_sha_at_start: null };

it("BUG-2 — browser-validation-evidence check exists", () => {
  assert.ok(bvCheck, "browser-validation-evidence must be in CHECK_DEFINITIONS");
});

it("BUG-2 AC2-1 — same stage_id: older errors + newer clean → pass", () => {
  const artifacts = [
    { path: "old.md", kind: "browser_validation_report", text: "severity: errors\n",  stage_id: "s1", created_at: "2024-01-01T10:00:00.000Z" },
    { path: "new.md", kind: "browser_validation_report", text: "severity: clean\n",   stage_id: "s1", created_at: "2024-01-01T11:00:00.000Z" },
  ];
  const r = bvCheck.evaluate(artifacts, CTX);
  assert.equal(r.status, "pass", `expected pass, got ${r.status}: ${r.evidence}`);
});

it("BUG-2 AC2-2 — same stage_id: older clean + newer errors → fail (newer error wins)", () => {
  const artifacts = [
    { path: "old.md", kind: "browser_validation_report", text: "severity: clean\n",  stage_id: "s1", created_at: "2024-01-01T10:00:00.000Z" },
    { path: "new.md", kind: "browser_validation_report", text: "severity: errors\n", stage_id: "s1", created_at: "2024-01-01T11:00:00.000Z" },
  ];
  const r = bvCheck.evaluate(artifacts, CTX);
  assert.equal(r.status, "fail", `expected fail (newer errors wins), got ${r.status}: ${r.evidence}`);
});

it("BUG-2 AC2-3 — different stages: one clean latest + one errors latest → fail (blocking wins)", () => {
  const artifacts = [
    { path: "s1.md", kind: "browser_validation_report", text: "severity: errors\n", stage_id: "s1", created_at: "2024-01-01T10:00:00.000Z" },
    { path: "s2.md", kind: "browser_validation_report", text: "severity: clean\n",  stage_id: "s2", created_at: "2024-01-01T11:00:00.000Z" },
  ];
  const r = bvCheck.evaluate(artifacts, CTX);
  assert.equal(r.status, "fail", `expected fail (stage s1 has errors), got ${r.status}: ${r.evidence}`);
});

it("BUG-2 AC2-4 — single errors report → fail", () => {
  const artifacts = [{ path: "r.md", kind: "browser_validation_report", text: "severity: errors\n", stage_id: "s1", created_at: "2024-01-01T10:00:00.000Z" }];
  const r = bvCheck.evaluate(artifacts, CTX);
  assert.equal(r.status, "fail");
});

it("BUG-2 AC2-4 — single clean report → pass", () => {
  const artifacts = [{ path: "r.md", kind: "browser_validation_report", text: "severity: clean\n", stage_id: "s1", created_at: "2024-01-01T10:00:00.000Z" }];
  const r = bvCheck.evaluate(artifacts, CTX);
  assert.equal(r.status, "pass");
});

it("BUG-2 AC2-4 — zero reports → fail with 'no browser_validation_report' evidence", () => {
  const r = bvCheck.evaluate([], CTX);
  assert.equal(r.status, "fail");
  assert.match(r.evidence, /no browser_validation_report/);
});

it("BUG-2 AC2-5 — sole report with unparseable severity → fail", () => {
  const artifacts = [{ path: "r.md", kind: "browser_validation_report", text: "result: inconclusive\n", stage_id: "s1", created_at: "2024-01-01T10:00:00.000Z" }];
  const r = bvCheck.evaluate(artifacts, CTX);
  assert.equal(r.status, "fail");
});

it("BUG-2 AC2-6 — ArtifactBundle carries stage_id and created_at accessible to evaluate()", () => {
  // Structural check: evaluate() must be able to read stage_id + created_at from bundle.
  // We verify indirectly: if AC2-1 passes (same stage recency scoping), these fields
  // are read. Additionally assert the fields survive the call without stripping.
  const bundles = [
    { path: "r.md", kind: "browser_validation_report", text: "severity: clean\n", stage_id: "sX", created_at: "2024-06-01T00:00:00.000Z" },
  ];
  // Passes if the check can read stage_id / created_at (no TypeError)
  const r = bvCheck.evaluate(bundles, CTX);
  assert.equal(r.status, "pass");
  // Fields are still accessible on the bundle object after the call
  assert.equal(bundles[0].stage_id, "sX");
  assert.equal(bundles[0].created_at, "2024-06-01T00:00:00.000Z");
});

// ═══════════════════════════════════════════════════════════════════════════
// BUG-3: node TAP parser + classify() exit-code cross-check
// ═══════════════════════════════════════════════════════════════════════════

const tddMod = await importDist("orchestrator/tdd-gate.js");
const { parseTestOutcome, TDD_RUNNERS } = tddMod;

it("BUG-3 AC3-8 — 'node' is a member of exported TDD_RUNNERS", () => {
  assert.ok(Array.isArray(TDD_RUNNERS), "TDD_RUNNERS must be an array");
  assert.ok(TDD_RUNNERS.includes("node"), `TDD_RUNNERS should include "node", got: ${JSON.stringify(TDD_RUNNERS)}`);
});

it("BUG-3 AC3-1 — parseTestOutcome('node', 0, '# tests 5\\n# pass 5\\n# fail 0\\n', '') → all_pass (5/0)", () => {
  const r = parseTestOutcome("node", 0, "# tests 5\n# pass 5\n# fail 0\n", "");
  assert.equal(r.actual, "all_pass");
  assert.equal(r.passed, 5);
  assert.equal(r.failed, 0);
});

it("BUG-3 AC3-2 — parseTestOutcome('node', 1, '# tests 5\\n# pass 0\\n# fail 5\\n', '') → all_fail (0/5)", () => {
  // This is the core BUG-3 regression: impossible via parseGeneric today.
  const r = parseTestOutcome("node", 1, "# tests 5\n# pass 0\n# fail 5\n", "");
  assert.equal(r.actual, "all_fail", `expected all_fail, got ${r.actual}`);
  assert.equal(r.passed, 0);
  assert.equal(r.failed, 5);
});

it("BUG-3 AC3-3 — parseTestOutcome('node', 1, '# tests 5\\n# pass 3\\n# fail 2\\n', '') → mixed (3/2)", () => {
  const r = parseTestOutcome("node", 1, "# tests 5\n# pass 3\n# fail 2\n", "");
  assert.equal(r.actual, "mixed");
  assert.equal(r.passed, 3);
  assert.equal(r.failed, 2);
});

it("BUG-3 AC3-5 — parseTestOutcome('vitest', 1, 'Tests  5 passed (5)', '') → mixed (not all_pass)", () => {
  // The classify() exit-code cross-check: nonzero exit with 0 parsed failures → mixed.
  const r = parseTestOutcome("vitest", 1, "Tests  5 passed (5)\n", "");
  assert.equal(r.actual, "mixed", `expected mixed (exitCode=1 despite 0 failures), got ${r.actual}`);
});

it("BUG-3 AC3-6 (no regression) — parseTestOutcome('vitest', 0, 'Tests  5 passed (5)', '') → all_pass", () => {
  const r = parseTestOutcome("vitest", 0, "Tests  5 passed (5)\n", "");
  assert.equal(r.actual, "all_pass");
  assert.equal(r.passed, 5);
  assert.equal(r.failed, 0);
});

it("BUG-3 AC3-7 (no regression) — genuine all_fail returns all_fail regardless of exitCode", () => {
  const r1 = parseTestOutcome("vitest", 1, "Tests  15 failed (15)\n", "");
  assert.equal(r1.actual, "all_fail", `exit=1: expected all_fail, got ${r1.actual}`);

  // Exit 0 with all-failed counts is unusual but classify should still return all_fail
  const r2 = parseTestOutcome("vitest", 0, "Tests  15 failed (15)\n", "");
  assert.equal(r2.actual, "all_fail", `exit=0: expected all_fail, got ${r2.actual}`);
});

it("BUG-3 AC3-7 (no regression) — passed>0 && failed>0 is always mixed", () => {
  const r = parseTestOutcome("vitest", 1, "Tests  3 passed | 2 failed (5)\n", "");
  assert.equal(r.actual, "mixed");
  assert.equal(r.passed, 3);
  assert.equal(r.failed, 2);
});

// ─── Summary ───────────────────────────────────────────────────────────────
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
