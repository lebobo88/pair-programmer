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
//   5. Mutation proof: temporarily removing the "plan" entry from the routing
//      map (re-derived here via a local copy of pickDefaultRubric's fallback
//      behavior) is exercised by calling evaluateGate with an unmapped kind
//      and confirming it does NOT resolve to plan-decomposition-quality@1 —
//      i.e. the map entry, not gate_type defaulting, is what makes the "plan"
//      test pass. See inline test for the actual delete-and-restore proof
//      against the compiled dist module.
//
// Self-contained: pure functions from dist/, no daemon, no DB writes.

import { strict as assert } from "node:assert";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { readFileSync, writeFileSync } from "node:fs";

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

test("mutation proof: deleting the artifact_kind->rubric source mapping breaks plan routing", async () => {
  // Edit the compiled dist file directly (pure-function module, no DB): drop
  // the "plan" entry from ARTIFACT_KIND_RUBRICS, re-import via a cache-busting
  // query string, confirm the plan routing test would now fail, then restore
  // the file exactly and re-verify the fix is back.
  const gatesDistPath = join(DIST, "orchestrator", "gates.js");
  const original = readFileSync(gatesDistPath, "utf8");
  assert.match(original, /plan:\s*"plan-decomposition-quality@1"/, "expected the plan mapping in dist output");

  const mutated = original.replace(/plan:\s*"plan-decomposition-quality@1",?\s*/, "");
  assert.notEqual(mutated, original, "mutation must actually change the file");

  writeFileSync(gatesDistPath, mutated);
  try {
    const bustUrl = `${pathToFileURL(gatesDistPath).href}?mutation-proof=${Date.now()}`;
    const { evaluateGate: mutatedEvaluateGate } = await import(bustUrl);
    const decision = mutatedEvaluateGate({ gate_type: "spec", artifact_kind: "plan" });
    assert.notEqual(
      decision.rubric_id,
      "plan-decomposition-quality@1",
      "removing the plan mapping must break plan routing (mutation proof)",
    );
    // Falls through to the gate_type=spec default.
    assert.equal(decision.rubric_id, "rfc-2119-normative@1");
  } finally {
    writeFileSync(gatesDistPath, original);
  }

  // Restored: re-import (new cache-busted URL) and confirm the fix is back.
  const bustRestoredUrl = `${pathToFileURL(gatesDistPath).href}?mutation-proof-restored=${Date.now()}`;
  const { evaluateGate: restoredEvaluateGate } = await import(bustRestoredUrl);
  const restoredDecision = restoredEvaluateGate({ gate_type: "spec", artifact_kind: "plan" });
  assert.equal(restoredDecision.rubric_id, "plan-decomposition-quality@1");
});
