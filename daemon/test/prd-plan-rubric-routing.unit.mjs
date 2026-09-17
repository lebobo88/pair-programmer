// X1a — prd-quality@1 / plan-decomposition-quality@1 rubrics + routing.
//
// Covers:
//   1. getRubric() returns both new rubrics with the right dimension names
//      (asserted against the markdown body, since Rubric has no structured
//      dimension list — mirrors how existing rubric bodies are checked, e.g.
//      smoke.mjs's wcag "8-state matrix" / web-runtime-validation "carve_outs"
//      assertions).
//   2. evaluateGate(gate_type:"spec", artifact_kind:"plan") ->
//      plan-decomposition-quality@1; artifact_kind:"prd" -> prd-quality@1.
//   3. An unrelated spec kind (artifact_kind:"acceptance_criteria", which has
//      no ARTIFACT_KIND_RUBRICS entry) still falls through to the gate_type
//      default rfc-2119-normative@1.
//   4. The forum "spec" stage (kind:"prd") resolves prd-quality@1 both as its
//      declared rubric_id AND when that value is threaded through evaluateGate
//      as rubric_hint (the precedence path .claude/commands/pp/review.md
//      actually uses: rubric_hint=stage.rubric_id).
//   5. Non-vacuity proof (no on-disk mutation): evaluateGate with NO
//      artifact_kind at all falls back to the gate_type default
//      rfc-2119-normative@1, while artifact_kind:"plan" resolves to
//      plan-decomposition-quality@1 — proving the artifact_kind map (not the
//      gate_type default) drives the "plan" result. A further check that
//      artifact_kind:"prd" WITH rubric_hint:"rfc-2119-normative@1" resolves
//      to rfc-2119-normative@1 documents that rubric_hint takes precedence
//      over the artifact_kind map.
//   6. Outcome-partition text proof: prd-quality@1 (same-convention
//      partition; Hydra has no PRD-specific rubric) and
//      plan-decomposition-quality@1 (Hydra-mirrored partition) markdown
//      bodies literally encode the pass/fail/revise thresholds (0.6, 0.4,
//      "exactly one") and name their structural dimensions, so the
//      partition can't silently drift out of the rubric text.
//
// Self-contained: pure functions from dist/, no daemon, no DB writes, no
// mutation of compiled output.

import { strict as assert } from "node:assert";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DIST = join(__dirname, "..", "dist");
const importDist = (relPath) => import(pathToFileURL(join(DIST, relPath)).href);

const { evaluateGate } = await importDist("orchestrator/gates.js");
const { getRubric, listRubrics } = await importDist("rubrics/registry.js");
const { getForum } = await importDist("orchestrator/forums.js");

test("getRubric returns prd-quality@1 with the right dimension names", () => {
  const r = getRubric("prd-quality@1");
  assert.ok(r, "prd-quality@1 must exist in the registry");
  assert.equal(r.kind, "spec");
  for (const dim of [
    "problem_statement", "users_and_jobs", "scope_and_non_goals",
    "functional_requirements", "acceptance_criteria", "nfrs",
    "success_metrics", "risks_and_open_questions",
  ]) {
    assert.match(r.markdown, new RegExp(`\\*\\*${dim}\\*\\*`), `missing dimension ${dim}`);
  }
  assert.match(r.markdown, /RFC 2119|MUST/, "must reference normative language");
});

test("getRubric returns plan-decomposition-quality@1 with the right dimension names", () => {
  const r = getRubric("plan-decomposition-quality@1");
  assert.ok(r, "plan-decomposition-quality@1 must exist in the registry");
  assert.equal(r.kind, "spec");
  for (const dim of [
    "goal_fidelity", "decomposition_soundness", "dependency_correctness",
    "acceptance_testability", "envelope_typing", "risk_surfacing",
    "ceiling_respect", "cell_coverage",
  ]) {
    assert.match(r.markdown, new RegExp(`\\*\\*${dim}\\*\\*`), `missing dimension ${dim}`);
  }
  assert.match(r.markdown, /ADVISORY/, "cell_coverage must be documented as advisory");
});

test("listRubrics includes both new ids", () => {
  const ids = listRubrics().map((r) => r.id);
  assert.ok(ids.includes("prd-quality@1"));
  assert.ok(ids.includes("plan-decomposition-quality@1"));
});

test("evaluateGate(spec, artifact_kind=plan) routes to plan-decomposition-quality@1", () => {
  const decision = evaluateGate({ gate_type: "spec", artifact_kind: "plan" });
  assert.equal(decision.rubric_id, "plan-decomposition-quality@1");
});

test("evaluateGate(spec, artifact_kind=prd) routes to prd-quality@1", () => {
  const decision = evaluateGate({ gate_type: "spec", artifact_kind: "prd" });
  assert.equal(decision.rubric_id, "prd-quality@1");
});

test("evaluateGate(spec, artifact_kind=acceptance_criteria) still defaults to rfc-2119-normative@1", () => {
  const decision = evaluateGate({ gate_type: "spec", artifact_kind: "acceptance_criteria" });
  assert.equal(decision.rubric_id, "rfc-2119-normative@1");
});

test("forum 'scope' stage (kind=prd) resolves prd-quality@1", () => {
  const forum = getForum("scope");
  assert.ok(forum, "expected a 'scope' forum");
  const prdStage = forum.stages.find((s) => s.kind === "prd");
  assert.ok(prdStage, "expected a prd stage in the spec forum");
  assert.equal(prdStage.rubric_id, "prd-quality@1");

  // review.md's actual precedence path: rubric_hint=stage.rubric_id is passed
  // straight into evaluateGate, and rubric_hint wins over the artifact_kind
  // map (pickDefaultRubric checks the hint first). Confirm the hint resolves
  // to the same rubric so the two paths agree.
  const decision = evaluateGate({
    gate_type: prdStage.gate_type,
    artifact_kind: prdStage.artifact_kind ?? prdStage.kind,
    rubric_hint: prdStage.rubric_id,
  });
  assert.equal(decision.rubric_id, "prd-quality@1");
});

test("non-vacuity proof: artifact_kind map (not gate_type default) drives 'plan' routing", () => {
  // With no artifact_kind at all, evaluateGate falls back to the gate_type
  // default (rfc-2119-normative@1) — confirming that default is NOT
  // plan-decomposition-quality@1 or prd-quality@1 on its own.
  const noKind = evaluateGate({ gate_type: "spec" });
  assert.equal(noKind.rubric_id, "rfc-2119-normative@1");

  // artifact_kind:"plan" resolves differently from the no-kind default,
  // proving the ARTIFACT_KIND_RUBRICS map entry (not gate_type defaulting)
  // is what makes plan routing resolve to plan-decomposition-quality@1.
  const planKind = evaluateGate({ gate_type: "spec", artifact_kind: "plan" });
  assert.equal(planKind.rubric_id, "plan-decomposition-quality@1");
  assert.notEqual(planKind.rubric_id, noKind.rubric_id);
});

test("precedence proof: rubric_hint wins over the artifact_kind map", () => {
  // artifact_kind:"prd" would normally resolve to prd-quality@1, but an
  // explicit rubric_hint of rfc-2119-normative@1 must win — documenting the
  // precedence order pickDefaultRubric implements (hint checked first).
  const decision = evaluateGate({
    gate_type: "spec",
    artifact_kind: "prd",
    rubric_hint: "rfc-2119-normative@1",
  });
  assert.equal(decision.rubric_id, "rfc-2119-normative@1");
});

test("prd-quality@1 markdown literally encodes the same-convention outcome partition", () => {
  const r = getRubric("prd-quality@1");
  assert.match(r.markdown, /0\.6/, "pass threshold 0.6 must appear verbatim");
  assert.match(r.markdown, /0\.4/, "fail threshold 0.4 must appear verbatim");
  assert.match(r.markdown, /exactly one/i, "must state exactly one outcome applies");
  for (const dim of ["problem_statement", "functional_requirements", "acceptance_criteria"]) {
    assert.match(r.markdown, new RegExp(dim), `structural dimension ${dim} must be named in the outcome text`);
  }
});

test("plan-decomposition-quality@1 markdown literally encodes the Hydra-mirrored outcome partition", () => {
  const r = getRubric("plan-decomposition-quality@1");
  assert.match(r.markdown, /0\.6/, "pass threshold 0.6 must appear verbatim");
  assert.match(r.markdown, /0\.4/, "fail threshold 0.4 must appear verbatim");
  assert.match(r.markdown, /exactly one/i, "must state exactly one outcome applies");
  for (const dim of ["goal_fidelity", "decomposition_soundness", "dependency_correctness"]) {
    assert.match(r.markdown, new RegExp(dim), `structural dimension ${dim} must be named in the outcome text`);
  }
});
