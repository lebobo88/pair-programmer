/**
 * Coverage for the `node-test` outcome parser added to tdd-gate.ts.
 *
 * WHY THIS EXISTS: `node --test` is this repo's mandated test runner (AGENTS.md
 * ANTI-STALL TEST RULE), but TDD_RUNNERS had no entry for it, so every red phase
 * fell through to parseGeneric() -- which returns "mixed" for any non-zero exit
 * with the reason "cannot distinguish all_fail from mixed without parser". That
 * made bug-fix-team's TDD gate unable to verify a red phase in this project at
 * all. Discovered while running run_jc1UxeCMvyZR.
 *
 * Self-contained per the ANTI-STALL rule: imports from dist/, no daemon, no MCP
 * peer, no SQLite.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  parseTestOutcome,
  TDD_RUNNERS,
  TDD_OUTCOMES,
} from "../dist/orchestrator/tdd-gate.js";

// The spec reporter (non-TTY default since Node 20) marks counter lines with
// U+2139; the tap reporter uses "#". Both must parse.
const spec = (pass, fail) =>
  `ℹ tests ${pass + fail}\nℹ suites 3\nℹ pass ${pass}\nℹ fail ${fail}\nℹ cancelled 0\nℹ skipped 0\n`;
const tap = (pass, fail) =>
  `# tests ${pass + fail}\n# pass ${pass}\n# fail ${fail}\n`;

describe("tdd-gate: node-test runner registration", () => {
  test("node-test is an allowed runner", () => {
    assert.ok(
      TDD_RUNNERS.includes("node-test"),
      "TDD_RUNNERS must include 'node-test' or manifests cannot declare it",
    );
  });

  test("mixed is an allowed pre-outcome expectation", () => {
    assert.ok(
      TDD_OUTCOMES.includes("mixed"),
      "a bug-fix red phase that appends failing tests to an existing suite is inherently mixed",
    );
  });
});

describe("tdd-gate: parseTestOutcome('node-test', ...)", () => {
  test("spec reporter: mixed counts resolve to 'mixed', not the generic fallback", () => {
    const r = parseTestOutcome("node-test", 1, spec(9, 10), "");
    assert.equal(r.actual, "mixed");
    assert.equal(r.passed, 9);
    assert.equal(r.failed, 10);
  });

  test("tap reporter parses identically", () => {
    const r = parseTestOutcome("node-test", 1, tap(9, 10), "");
    assert.equal(r.actual, "mixed");
    assert.equal(r.passed, 9);
    assert.equal(r.failed, 10);
  });

  test("all green resolves to all_pass with real counts", () => {
    const r = parseTestOutcome("node-test", 0, spec(19, 0), "");
    assert.equal(r.actual, "all_pass");
    assert.equal(r.passed, 19);
    assert.equal(r.failed, 0);
  });

  test("all red resolves to all_fail", () => {
    const r = parseTestOutcome("node-test", 1, spec(0, 5), "");
    assert.equal(r.actual, "all_fail");
    assert.equal(r.failed, 5);
  });

  test("a suite that cannot load is 'error', never 'all_fail'", () => {
    // A red phase that fails because it can't import is worthless; it must not
    // be able to satisfy expected_pre_outcome: all_fail.
    const r = parseTestOutcome("node-test", 1, "Cannot find module '../dist/x.js'", "");
    assert.equal(r.actual, "error");
  });

  test("zero tests executed is 'error', never 'all_pass'", () => {
    const r = parseTestOutcome("node-test", 1, spec(0, 0), "");
    assert.equal(r.actual, "error");
  });

  test("the generic fallback is no longer reached for node-test output", () => {
    // Regression guard: if the dispatch case is dropped, parseGeneric returns a
    // reason mentioning the missing parser. Assert we never see it.
    const r = parseTestOutcome("node-test", 1, spec(9, 10), "");
    assert.ok(
      !(r.reason ?? "").includes("without parser"),
      `expected the node-test parser, got the generic fallback: ${r.reason}`,
    );
  });
});
