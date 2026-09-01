// Unit tests for the TDD-gate test-output parser (parseTestOutcome).
// Covers vitest summary-line shapes, including the all-failed case
// ("Tests  15 failed (15)") that previously fell through and was
// misclassified as 'mixed', breaking TDD pre-fix gates that expect all_fail.

import { strict as assert } from "node:assert";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const tddGateUrl = pathToFileURL(
  join(__dirname, "..", "dist", "orchestrator", "tdd-gate.js"),
).href;
const { parseTestOutcome, normalizeRunnerOutput } = await import(tddGateUrl);

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

// ─── vitest ────────────────────────────────────────────────────────────────

it("vitest: 'Tests  3 passed | 2 failed (5)' → mixed (3/2)", () => {
  const r = parseTestOutcome("vitest", 1, "Tests  3 passed | 2 failed (5)\n", "");
  assert.equal(r.actual, "mixed");
  assert.equal(r.passed, 3);
  assert.equal(r.failed, 2);
});

it("vitest: 'Tests  2 failed | 3 passed (5)' (reverse order) → mixed (3/2)", () => {
  const r = parseTestOutcome("vitest", 1, "Tests  2 failed | 3 passed (5)\n", "");
  assert.equal(r.actual, "mixed");
  assert.equal(r.passed, 3);
  assert.equal(r.failed, 2);
});

it("vitest: 'Tests  5 passed (5)' (no failures) → all_pass (5/0)", () => {
  const r = parseTestOutcome("vitest", 0, "Tests  5 passed (5)\n", "");
  assert.equal(r.actual, "all_pass");
  assert.equal(r.passed, 5);
  assert.equal(r.failed, 0);
});

it("vitest: 'Tests  15 failed (15)' (all-failed, the regression) → all_fail (0/15)", () => {
  // Before the fix this returned 'mixed' because no regex matched the
  // failed-only summary line, so passed/failed stayed null and classify()
  // fell into the non-zero-exit + FAIL-pattern branch.
  const r = parseTestOutcome("vitest", 1, "Tests  15 failed (15)\n", "");
  assert.equal(r.actual, "all_fail");
  assert.equal(r.passed, 0);
  assert.equal(r.failed, 15);
});

it("vitest: full realistic summary block with 'Test Files' line → all_fail (0/15)", () => {
  const out =
    "❯ tests/foo.test.ts (15 tests | 15 failed) 42ms\n" +
    "\n" +
    " Test Files  1 failed (1)\n" +
    "      Tests  15 failed (15)\n" +
    "   Start at  10:00:00\n" +
    "   Duration  120ms\n";
  const r = parseTestOutcome("vitest", 1, out, "");
  assert.equal(r.actual, "all_fail");
  assert.equal(r.passed, 0);
  assert.equal(r.failed, 15);
});

it("vitest: empty output with non-zero exit → error", () => {
  const r = parseTestOutcome("vitest", 1, "", "");
  assert.equal(r.actual, "error");
  assert.equal(r.passed, null);
  assert.equal(r.failed, null);
});

it("vitest: module-not-found stderr → error (no counts)", () => {
  const r = parseTestOutcome(
    "vitest",
    1,
    "",
    "Error: Cannot find module 'tests/foo.test.ts'\n",
  );
  assert.equal(r.actual, "error");
});

// --- ANSI-coloured output (the run_9KKRO08lbJsc regression) -----------------
//
// Test runners colour their summary lines on Windows and under CI regardless of
// FORCE_COLOR (tinyrainbow/picocolors check FORCE_COLOR *presence*, not value,
// so the gate's old `FORCE_COLOR: "0"` actually ENABLED colour). The escape
// bytes land between "Tests" and the count, so every count regex missed and a
// clean 9/9 red phase was recorded as `mixed` -- the contaminated-red bucket the
// gate exists to distinguish. Bytes below are copied verbatim from the gate's own
// archived log: .harness/run_9KKRO08lbJsc/tdd_checks/stage_gEX-TKEaWz.pre.GME09V8n.log

const E = String.fromCharCode(27); // ESC

it("vitest: ANSI-coloured all-failed summary (the regression) -> all_fail (0/9)", () => {
  const line = `${E}[2m      Tests ${E}[22m ${E}[1m${E}[31m9 failed${E}[39m${E}[22m${E}[90m (9)${E}[39m`;
  const r = parseTestOutcome("vitest", 1, line + "\n", "");
  assert.equal(r.actual, "all_fail");
  assert.equal(r.passed, 0);
  assert.equal(r.failed, 9);
});

it("vitest: ANSI-coloured mixed summary -> mixed (3/2)", () => {
  const line = `${E}[2m      Tests ${E}[22m ${E}[1m${E}[32m3 passed${E}[39m${E}[22m | ${E}[1m${E}[31m2 failed${E}[39m${E}[22m (5)`;
  const r = parseTestOutcome("vitest", 1, line + "\n", "");
  assert.equal(r.actual, "mixed");
  assert.equal(r.passed, 3);
  assert.equal(r.failed, 2);
});

it("vitest: \\r progress rewrite reads the FINAL frame, not the first", () => {
  // String.match returns the first hit, so an un-collapsed progress frame would
  // be read as the final count.
  const r = parseTestOutcome("vitest", 1, "Tests  1 failed (1)\rTests  9 failed (9)\n", "");
  assert.equal(r.actual, "all_fail");
  assert.equal(r.failed, 9);
});

it("normalizeRunnerOutput: preserves CRLF line endings", () => {
  assert.equal(normalizeRunnerOutput("foo\r\nbar\r\n"), "foo\r\nbar\r\n");
  assert.equal(normalizeRunnerOutput("a\rb\r\n"), "b\r\n");
});

// --- jest: all-failed summary omits the passed segment ---------------------

it("jest: 'Tests: 9 failed, 9 total' (no passed segment) -> all_fail (0/9)", () => {
  const r = parseTestOutcome("jest", 1, "Tests:       9 failed, 9 total\n", "");
  assert.equal(r.actual, "all_fail");
  assert.equal(r.passed, 0);
  assert.equal(r.failed, 9);
});

it("jest: 'Tests: 1 failed, 4 passed, 5 total' -> mixed (4/1)", () => {
  const r = parseTestOutcome("jest", 1, "Tests:       1 failed, 4 passed, 5 total\n", "");
  assert.equal(r.actual, "mixed");
  assert.equal(r.passed, 4);
  assert.equal(r.failed, 1);
});

it("jest: 'Tests: 5 passed, 5 total' -> all_pass (5/0)", () => {
  const r = parseTestOutcome("jest", 0, "Tests:       5 passed, 5 total\n", "");
  assert.equal(r.actual, "all_pass");
  assert.equal(r.passed, 5);
  assert.equal(r.failed, 0);
});

// --- pytest: all-failed summary omits the passed segment -------------------

it("pytest: '=== 9 failed in 0.12s ===' (no passed segment) -> all_fail (0/9)", () => {
  const r = parseTestOutcome("pytest", 1, "=========== 9 failed in 0.12s ===========\n", "");
  assert.equal(r.actual, "all_fail");
  assert.equal(r.passed, 0);
  assert.equal(r.failed, 9);
});

it("pytest: '=== 4 passed in 0.10s ===' -> all_pass (4/0)", () => {
  const r = parseTestOutcome("pytest", 0, "=========== 4 passed in 0.10s ===========\n", "");
  assert.equal(r.actual, "all_pass");
  assert.equal(r.passed, 4);
  assert.equal(r.failed, 0);
});

it("pytest: '=== 1 failed, 4 passed in 0.12s ===' -> mixed (4/1)", () => {
  const r = parseTestOutcome("pytest", 1, "===== 1 failed, 4 passed in 0.12s =====\n", "");
  assert.equal(r.actual, "mixed");
  assert.equal(r.passed, 4);
  assert.equal(r.failed, 1);
});

it("pytest: collection/fixture errors surface as 'error', NOT folded into failed", () => {
  // pytest exits 1 for these, so without the explicit check they would read as a
  // valid red phase. A red phase that cannot load is not a valid red phase.
  const r = parseTestOutcome("pytest", 1, "===== 1 failed, 2 errors in 0.10s =====\n", "");
  assert.equal(r.actual, "error");
});

// ─── skipped / todo accounting (regression: clean red phase read as "mixed") ──
//
// A red phase carrying a skipped or todo test is still a CLEAN red: a skipped
// test is neither a pass nor a failure. Reading it as "mixed" is the exact
// false negative the TDD gate exists to prevent, so each runner that can emit
// a skip count is pinned here.

it("vitest: 'Tests  9 failed | 1 skipped (10)' -> all_fail (0/9)", () => {
  // Regression: the old positional regexes all missed this shape -- onlyFailed's
  // (?!\s*\|) lookahead rejected the trailing pipe -- leaving both counts null,
  // so classify() saw the FAIL header lines and returned "mixed".
  const out = "\n Test Files  2 failed (2)\n      Tests  9 failed | 1 skipped (10)\n";
  const r = parseTestOutcome("vitest", 1, out, "");
  assert.equal(r.actual, "all_fail");
  assert.equal(r.passed, 0);
  assert.equal(r.failed, 9);
});

it("vitest: 'Tests  3 passed | 2 failed | 1 skipped (6)' -> mixed (3/2)", () => {
  const r = parseTestOutcome("vitest", 1, "Tests  3 passed | 2 failed | 1 skipped (6)\n", "");
  assert.equal(r.actual, "mixed");
  assert.equal(r.passed, 3);
  assert.equal(r.failed, 2);
});

it("vitest: 'Tests  5 passed | 1 todo (6)' -> all_pass (5/0)", () => {
  // todo must not be folded into failed, or a green phase reads as mixed.
  const r = parseTestOutcome("vitest", 0, "Tests  5 passed | 1 todo (6)\n", "");
  assert.equal(r.actual, "all_pass");
  assert.equal(r.passed, 5);
  assert.equal(r.failed, 0);
});

it("vitest: 'Test Files' line never hijacks the Tests summary", () => {
  // "Test Files  2 failed (2)" must not be read as the count source: it reports
  // FILES, not tests. Both lines present, differing counts -- the Tests line wins.
  const out = " Test Files  2 failed (2)\n      Tests  9 failed (9)\n";
  const r = parseTestOutcome("vitest", 1, out, "");
  assert.equal(r.actual, "all_fail");
  assert.equal(r.failed, 9);
});

it("vitest: a non-summary line starting 'Tests 9 ...' is not selected", () => {
  // The selector requires passed|failed after the count, so prose or a test name
  // beginning "Tests 9" cannot be mistaken for the summary line.
  const out = "Tests 9 through 12 are quarantined\n      Tests  4 passed (4)\n";
  const r = parseTestOutcome("vitest", 0, out, "");
  assert.equal(r.actual, "all_pass");
  assert.equal(r.passed, 4);
});

// ─── unittest ──────────────────────────────────────────────────────────────

it("unittest: 'FAILED (failures=9, skipped=1)' of 10 ran -> all_fail (0/9)", () => {
  // Regression: passed was derived as (ran - failed), counting the skipped test
  // as a pass -> 1 passed / 9 failed -> "mixed" on a clean red phase.
  const out = "Ran 10 tests in 0.01s\n\nFAILED (failures=9, skipped=1)\n";
  const r = parseTestOutcome("unittest", 1, out, "");
  assert.equal(r.actual, "all_fail");
  assert.equal(r.passed, 0);
  assert.equal(r.failed, 9);
});

it("unittest: errors are folded into failed alongside failures", () => {
  const out = "Ran 10 tests in 0.01s\n\nFAILED (failures=7, errors=3)\n";
  const r = parseTestOutcome("unittest", 1, out, "");
  assert.equal(r.actual, "all_fail");
  assert.equal(r.failed, 10);
});

it("unittest: 'OK (skipped=2)' of 10 ran -> all_pass (8/0)", () => {
  const out = "Ran 10 tests in 0.01s\n\nOK (skipped=2)\n";
  const r = parseTestOutcome("unittest", 0, out, "");
  assert.equal(r.actual, "all_pass");
  assert.equal(r.passed, 8);
  assert.equal(r.failed, 0);
});

it("unittest: genuine mixed still reads as mixed", () => {
  const out = "Ran 10 tests in 0.01s\n\nFAILED (failures=3)\n";
  const r = parseTestOutcome("unittest", 1, out, "");
  assert.equal(r.actual, "mixed");
  assert.equal(r.passed, 7);
  assert.equal(r.failed, 3);
});
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
