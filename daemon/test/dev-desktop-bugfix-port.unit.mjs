// Regression suite for three orchestrator fixes ported by hand from the stale
// origin/dev-desktop branch (fix 8e716ce, tests adapted from df551cf's
// bug-fix-full.unit.mjs):
//
//   BUG-1  archiveArtifact doubled ".harness/<run_id>/" when the caller's
//          relative_path already carried it  -> normalizeArtifactRelPath (runs.ts)
//   BUG-2  a superseded browser_validation_report still decided the
//          browser-validation-evidence check  -> latest report per stage_id
//          (missability.ts)
//   BUG-3b classify() read a nonzero exit with zero reported failures as
//          all_pass                            -> "mixed" (tdd-gate.ts)
//
// The df551cf "node" runner cases (AC3-1..3, AC3-8) are intentionally not
// ported: main already ships the "node-test" runner + parseNodeTest, and a
// duplicate "node" alias was not added. A node-test variant of the BUG-3b case
// is included instead.
//
// Every assertion calls the real exported function from dist/. DB-backed cases
// use a temp ledger set up via test/fixtures/isolated-env.mjs before the first
// dist/ import, never the live ~/.pair-programmer/state.db.

import { describe, test, after } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { setIsolatedProcessEnv } from "./fixtures/isolated-env.mjs";

const ledger = setIsolatedProcessEnv({ prefix: "pp-devdesktop-port-" });
mkdirSync(join(ledger.ppHome, ".pair-programmer"), { recursive: true });
process.env.EIGHTS_SKIP_AUDIT_CHECK = "1";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DIST = join(__dirname, "..", "dist");
const importDist = (rel) => import(pathToFileURL(join(DIST, rel)).href);

const runs = await importDist("orchestrator/runs.js");
const miss = await importDist("orchestrator/missability.js");
const tdd = await importDist("orchestrator/tdd-gate.js");

const projects = [];
function makeProject() {
  const dir = mkdtempSync(join(tmpdir(), "pp-devdesktop-proj-"));
  mkdirSync(join(dir, ".harness"), { recursive: true });
  writeFileSync(join(dir, "AGENTS.md"), "# AGENTS\n", "utf8");
  projects.push(dir);
  return dir;
}

after(() => {
  for (const p of projects) rmSync(p, { recursive: true, force: true });
});

// ─── BUG-1: normalizeArtifactRelPath ─────────────────────────────────────────

describe("BUG-1 normalizeArtifactRelPath", () => {
  const { normalizeArtifactRelPath } = runs;
  const RUN_ID = "run_testBUG1abc_";

  test("is exported as a function", () => {
    assert.equal(typeof normalizeArtifactRelPath, "function");
  });

  test("AC1-1 redundant prefix stripped: .harness/<runId>/code/winner.diff -> code/winner.diff", () => {
    assert.equal(normalizeArtifactRelPath(RUN_ID, `.harness/${RUN_ID}/code/winner.diff`), "code/winner.diff");
  });

  test("AC1-2 non-redundant path unchanged", () => {
    assert.equal(normalizeArtifactRelPath(RUN_ID, "code/winner.diff"), "code/winner.diff");
  });

  test("AC1-3 a different run_id's prefix is NOT stripped", () => {
    const input = ".harness/run_OTHER999/x.md";
    assert.equal(normalizeArtifactRelPath(RUN_ID, input), input);
  });

  test("AC1-4 .harness-notes/<runId>/ is NOT stripped (exact .harness/<runId>/ match only)", () => {
    const input = `.harness-notes/${RUN_ID}/x.md`;
    assert.equal(normalizeArtifactRelPath(RUN_ID, input), input);
  });

  test("AC1-5 doubly-redundant prefix: exactly ONE layer stripped", () => {
    assert.equal(
      normalizeArtifactRelPath(RUN_ID, `.harness/${RUN_ID}/.harness/${RUN_ID}/x.md`),
      `.harness/${RUN_ID}/x.md`,
    );
  });

  test("AC1-7 backslash-separated prefix normalizes like the forward-slash form", () => {
    const fwd = normalizeArtifactRelPath(RUN_ID, `.harness/${RUN_ID}/code/winner.diff`);
    const bs = normalizeArtifactRelPath(RUN_ID, `.harness\\${RUN_ID}\\code\\winner.diff`);
    assert.equal(fwd, "code/winner.diff");
    assert.equal(bs.replaceAll("\\", "/"), fwd);
  });

  test("run_id regex metacharacters are matched literally, not as a pattern", () => {
    // "." in a run id must not match an arbitrary character.
    assert.equal(normalizeArtifactRelPath("run.a", ".harness/runXa/x.md"), ".harness/runXa/x.md");
    assert.equal(normalizeArtifactRelPath("run.a", ".harness/run.a/x.md"), "x.md");
  });

  test("AC1-6 archiveArtifact with a redundant prefix writes ONE .harness/<runId>/ level on disk", async () => {
    const project = makeProject();
    const run = await runs.ensureRun({ request_text: "bug1 e2e", project_path: project, mode: "single" });
    const stage = await runs.startStage({ run_id: run.run_id, kind: "spec", gate_type: "spec" });
    const out = await runs.archiveArtifact({
      run_id: run.run_id,
      stage_id: stage.stage_id,
      kind: "spec",
      relative_path: `.harness/${run.run_id}/code/x.md`,
      bytes: "# x\n",
    });
    const expected = join(project, ".harness", run.run_id, "code", "x.md");
    const doubled = join(project, ".harness", run.run_id, ".harness", run.run_id, "code", "x.md");
    assert.ok(existsSync(expected), `expected artifact at ${expected}`);
    assert.equal(readFileSync(expected, "utf8"), "# x\n");
    assert.ok(!existsSync(doubled), `doubled path must not exist: ${doubled}`);
    assert.equal(out.status, "ok");
    assert.equal(out.absolute_path, expected);
  });
});

// ─── BUG-2: browser-validation-evidence evaluates the latest report per stage ─

const bvCheck = miss.CHECK_DEFINITIONS.find((c) => c.id === "browser-validation-evidence");
const CTX = { project_path: ".", constitution_sha_at_start: null };
const T1 = "2026-01-01T10:00:00.000Z";
const T2 = "2026-01-01T11:00:00.000Z";
const rep = (path, text, stage_id, created_at) => ({ path, kind: "browser_validation_report", text, stage_id, created_at });
const NA_OK = "severity: not_applicable\nreason: non-ui-cli project, no web surface\n";

describe("BUG-2 browser-validation-evidence recency scoping", () => {
  test("check exists in CHECK_DEFINITIONS", () => {
    assert.ok(bvCheck, "browser-validation-evidence must be in CHECK_DEFINITIONS");
  });

  test("AC2-1 same stage: older errors + newer clean -> pass (stale errors superseded)", () => {
    const r = bvCheck.evaluate([rep("old.md", "severity: errors\n", "s1", T1), rep("new.md", "severity: clean\n", "s1", T2)], CTX);
    assert.equal(r.status, "pass", `${r.status}: ${r.evidence}`);
    assert.equal(r.evidence, "new.md");
  });

  test("AC2-1 input order does not matter: newer clean listed FIRST still wins", () => {
    const r = bvCheck.evaluate([rep("new.md", "severity: clean\n", "s1", T2), rep("old.md", "severity: errors\n", "s1", T1)], CTX);
    assert.equal(r.status, "pass", `${r.status}: ${r.evidence}`);
  });

  test("AC2-2 same stage: older clean + newer errors -> fail (recency, not 'find any clean')", () => {
    const r = bvCheck.evaluate([rep("old.md", "severity: clean\n", "s1", T1), rep("new.md", "severity: errors\n", "s1", T2)], CTX);
    assert.equal(r.status, "fail", `${r.status}: ${r.evidence}`);
    assert.match(r.evidence, /^new\.md: severity=errors/);
  });

  test("AC2-3 different stages: each latest counts; one stage's errors still fail the run", () => {
    const r = bvCheck.evaluate([rep("s1.md", "severity: errors\n", "s1", T1), rep("s2.md", "severity: clean\n", "s2", T2)], CTX);
    assert.equal(r.status, "fail", `${r.status}: ${r.evidence}`);
    assert.match(r.evidence, /^s1\.md: severity=errors/);
  });

  test("per-stage scoping: each stage judged on its OWN latest (s1 healed, s2 regressed) -> fail on s2", () => {
    const r = bvCheck.evaluate([
      rep("s1-old.md", "severity: errors\n", "s1", T1),
      rep("s2-old.md", "severity: clean\n", "s2", T1),
      rep("s1-new.md", "severity: clean\n", "s1", T2),
      rep("s2-new.md", "severity: errors\n", "s2", T2),
    ], CTX);
    assert.equal(r.status, "fail", `${r.status}: ${r.evidence}`);
    assert.match(r.evidence, /^s2-new\.md: severity=errors/);
  });

  test("per-stage scoping: both stages healed by their own re-runs -> pass", () => {
    const r = bvCheck.evaluate([
      rep("s1-old.md", "severity: errors\n", "s1", T1),
      rep("s2-old.md", "severity: errors\n", "s2", T1),
      rep("s1-new.md", "severity: clean\n", "s1", T2),
      rep("s2-new.md", "severity: warnings\n", "s2", T2),
    ], CTX);
    assert.equal(r.status, "pass", `${r.status}: ${r.evidence}`);
  });

  test("a newer report in ANOTHER stage does not supersede this stage's errors", () => {
    const r = bvCheck.evaluate([rep("s1.md", "severity: errors\n", "s1", T1), rep("s2.md", "severity: clean\n", "s2", T2)], CTX);
    assert.equal(r.status, "fail");
  });

  test("null stage_id reports are each their own scope (a newer null-stage clean does not hide an older null-stage errors)", () => {
    const r = bvCheck.evaluate([rep("a.md", "severity: errors\n", null, T1), rep("b.md", "severity: clean\n", null, T2)], CTX);
    assert.equal(r.status, "fail", `${r.status}: ${r.evidence}`);
    assert.match(r.evidence, /^a\.md: severity=errors/);
  });

  test("unavailable superseded by a newer clean in the same stage -> pass", () => {
    const r = bvCheck.evaluate([rep("old.md", "severity: unavailable\n", "s1", T1), rep("new.md", "severity: clean\n", "s1", T2)], CTX);
    assert.equal(r.status, "pass", `${r.status}: ${r.evidence}`);
  });

  test("clean superseded by a newer unavailable in the same stage -> fail (unavailable gap)", () => {
    const r = bvCheck.evaluate([rep("old.md", "severity: clean\n", "s1", T1), rep("new.md", "severity: unavailable\n", "s1", T2)], CTX);
    assert.equal(r.status, "fail", `${r.status}: ${r.evidence}`);
    assert.match(r.evidence, /^new\.md: severity=unavailable/);
  });

  test("bare not_applicable superseded by a newer clean -> pass", () => {
    const r = bvCheck.evaluate([rep("old.md", "severity: not_applicable\n", "s1", T1), rep("new.md", "severity: clean\n", "s1", T2)], CTX);
    assert.equal(r.status, "pass", `${r.status}: ${r.evidence}`);
  });

  test("justified not_applicable superseded by a newer bare not_applicable -> fail (no justification)", () => {
    const r = bvCheck.evaluate([rep("old.md", NA_OK, "s1", T1), rep("new.md", "severity: not_applicable\n", "s1", T2)], CTX);
    assert.equal(r.status, "fail", `${r.status}: ${r.evidence}`);
    assert.match(r.evidence, /^new\.md: severity=not_applicable with no justification/);
  });

  test("unparseable fallback names the LATEST report, not a superseded one", () => {
    const r = bvCheck.evaluate([rep("old.md", "severity: clean\n", "s1", T1), rep("new.md", "result: inconclusive\n", "s1", T2)], CTX);
    assert.equal(r.status, "fail", `${r.status}: ${r.evidence}`);
    assert.equal(r.evidence, "new.md: severity not parseable");
  });

  test("created_at tie: the later element (insertion order) wins", () => {
    const a = bvCheck.evaluate([rep("first.md", "severity: errors\n", "s1", T1), rep("second.md", "severity: clean\n", "s1", T1)], CTX);
    assert.equal(a.status, "pass", `${a.status}: ${a.evidence}`);
    const b = bvCheck.evaluate([rep("first.md", "severity: clean\n", "s1", T1), rep("second.md", "severity: errors\n", "s1", T1)], CTX);
    assert.equal(b.status, "fail", `${b.status}: ${b.evidence}`);
  });

  test("AC2-4 single errors -> fail; single clean -> pass; zero reports -> fail", () => {
    assert.equal(bvCheck.evaluate([rep("r.md", "severity: errors\n", "s1", T1)], CTX).status, "fail");
    assert.equal(bvCheck.evaluate([rep("r.md", "severity: clean\n", "s1", T1)], CTX).status, "pass");
    const none = bvCheck.evaluate([], CTX);
    assert.equal(none.status, "fail");
    assert.match(none.evidence, /no browser_validation_report/);
  });

  test("AC2-5 sole report with unparseable severity -> fail", () => {
    assert.equal(bvCheck.evaluate([rep("r.md", "result: inconclusive\n", "s1", T1)], CTX).status, "fail");
  });

  test("bundles without stage_id/created_at (direct callers) still evaluate", () => {
    const r = bvCheck.evaluate([{ path: "r.md", kind: "browser_validation_report", text: "severity: clean\n" }], CTX);
    assert.equal(r.status, "pass");
  });

  // AC2-6: runMissabilityChecks must actually populate stage_id + created_at
  // from the artifacts table; a bundle without them would make every report
  // its own scope and the stale errors report would fail this run.
  async function dbRun(bodies, { sameStage = true } = {}) {
    const project = makeProject();
    const run = await runs.ensureRun({ request_text: "bug2 db", project_path: project, mode: "single" });
    const s1 = await runs.startStage({ run_id: run.run_id, kind: "browser_validation", gate_type: "contract" });
    const s2 = sameStage ? s1 : await runs.startStage({ run_id: run.run_id, kind: "browser_validation", gate_type: "contract" });
    for (const [i, body] of bodies.entries()) {
      await runs.archiveArtifact({
        run_id: run.run_id,
        stage_id: i === 0 ? s1.stage_id : s2.stage_id,
        kind: "browser_validation_report",
        relative_path: `browser-validation/report-${i}.md`,
        bytes: body,
      });
    }
    const result = miss.runMissabilityChecks({ run_id: run.run_id, required_check_ids: ["browser-validation-evidence"] });
    return result.results.find((x) => x.check_id === "browser-validation-evidence");
  }

  test("AC2-6 DB-backed: re-archived stage (errors then clean) -> pass", async () => {
    const bv = await dbRun(["# r\n\nseverity: errors\n", "# r\n\nseverity: clean\n"]);
    assert.equal(bv?.status, "pass", `${bv?.status}: ${bv?.evidence}`);
  });

  test("AC2-6 DB-backed: re-archived stage (clean then errors) -> fail", async () => {
    const bv = await dbRun(["# r\n\nseverity: clean\n", "# r\n\nseverity: errors\n"]);
    assert.equal(bv?.status, "fail", `${bv?.status}: ${bv?.evidence}`);
    assert.match(bv.evidence, /report-1\.md: severity=errors/);
  });

  test("AC2-6 DB-backed: errors in one stage, clean in ANOTHER stage -> fail", async () => {
    const bv = await dbRun(["# r\n\nseverity: errors\n", "# r\n\nseverity: clean\n"], { sameStage: false });
    assert.equal(bv?.status, "fail", `${bv?.status}: ${bv?.evidence}`);
  });
});

// ─── BUG-3b: nonzero exit with zero reported failures is not all_pass ────────

describe("BUG-3b classify() exit-code cross-check", () => {
  const { parseTestOutcome } = tdd;
  const nodeSpec = (pass, fail) =>
    `ℹ tests ${pass + fail}\nℹ suites 1\nℹ pass ${pass}\nℹ fail ${fail}\nℹ cancelled 0\nℹ skipped 0\nℹ todo 0\nℹ duration_ms 12.3\n`;

  test("AC3-5 vitest exit 1 with 'Tests  5 passed (5)' -> mixed, reason names the nonzero exit", () => {
    const r = tdd.parseTestOutcome("vitest", 1, "Tests  5 passed (5)\n", "");
    assert.equal(r.actual, "mixed");
    assert.equal(r.passed, 5);
    assert.equal(r.failed, 0);
    assert.match(r.reason, /nonzero exit \(1\) despite reported zero failures/);
  });

  test("node-test exit 1 with spec summary 5 pass / 0 fail -> mixed", () => {
    const r = parseTestOutcome("node-test", 1, nodeSpec(5, 0), "");
    assert.equal(r.actual, "mixed");
    assert.equal(r.passed, 5);
    assert.equal(r.failed, 0);
    assert.match(r.reason, /nonzero exit \(1\)/);
  });

  test("AC3-6 no regression: vitest exit 0 with 5 passed -> all_pass, null reason", () => {
    const r = parseTestOutcome("vitest", 0, "Tests  5 passed (5)\n", "");
    assert.equal(r.actual, "all_pass");
    assert.equal(r.passed, 5);
    assert.equal(r.failed, 0);
    assert.equal(r.reason, null);
  });

  test("no regression: node-test exit 0 with 5 pass / 0 fail -> all_pass", () => {
    assert.equal(parseTestOutcome("node-test", 0, nodeSpec(5, 0), "").actual, "all_pass");
  });

  test("AC3-7 no regression: genuine all_fail is all_fail regardless of exit code", () => {
    assert.equal(parseTestOutcome("vitest", 1, "Tests  15 failed (15)\n", "").actual, "all_fail");
    assert.equal(parseTestOutcome("vitest", 0, "Tests  15 failed (15)\n", "").actual, "all_fail");
  });

  test("AC3-7 no regression: passed>0 && failed>0 is mixed with the counts reason", () => {
    const r = parseTestOutcome("vitest", 1, "Tests  3 passed | 2 failed (5)\n", "");
    assert.equal(r.actual, "mixed");
    assert.equal(r.passed, 3);
    assert.equal(r.failed, 2);
    assert.match(r.reason, /mixed outcome: 3 passed, 2 failed/);
  });
});
