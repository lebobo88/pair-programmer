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
const { parseTestOutcome } = await import(tddGateUrl);

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

// TODO: jest and pytest have analogous "all-failed summary line omits the
// passed segment" gaps (jest regex on line 241 requires '… passed, N total';
// pytest regex on line 270 requires a comma after 'failed'). Not fixed here
// — scoped to vitest per the surfaced run. Add cases when those parsers are
// patched.

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
