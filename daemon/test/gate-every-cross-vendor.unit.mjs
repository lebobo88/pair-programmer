// Unit tests for J6 — every-gate cross-vendor + deterministic different-model
// judge selection.
//
// Covers:
//   - evaluateGate() returns required_cross_vendor:true for EVERY GateType
//     (JUDGE-1, CONSTITUTION.md Article V as amended 2026-09-03 SHA 5df284cb),
//     with base_tier still reported and a reason string that cites JUDGE-1.
//   - selectJudgeModels() over every pairing: default generator, escalated
//     generator, explicit generator, cross-vendor generator, a requested model
//     that is present / absent / identical to the generator's, and a bad effort.
//   - listAllowedJudges() exposes exactly ONE closing lane and it is always the
//     cross-vendor one; the same-vendor lane, when present, is closing:false.
//   - PP_DISABLE_AGY=1 drops agy from both preferred_producers and
//     preferred_models.
//
// Self-contained: pure functions from dist/, no daemon, no DB writes.

import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync, mkdirSync } from "node:fs";
import test from "node:test";
import assert from "node:assert/strict";

const SUITE_DIR = mkdtempSync(join(tmpdir(), "pp-gate-xvendor-"));
mkdirSync(join(SUITE_DIR, ".pair-programmer"), { recursive: true });
process.env.PP_HOME = SUITE_DIR;

const __dirname = dirname(fileURLToPath(import.meta.url));
const DIST = join(__dirname, "..", "dist");
const importDist = (relPath) => import(pathToFileURL(join(DIST, relPath)).href);

const { evaluateGate, listAllowedJudges, selectJudgeModels, resolveSameVendorCapability } =
  await importDist("orchestrator/gates.js");
const { JUDGE_MODEL_POLICY, DEFAULT_MODELS } = await importDist("config.js");

const GATE_TYPES = ["spec", "design", "security", "contract", "code_style", "docs_polish", "lint_class"];

const CODEX = JUDGE_MODEL_POLICY.codex;
const AGY = JUDGE_MODEL_POLICY.agy;

function withFlag(value, fn) {
  const prev = process.env.PP_DISABLE_AGY;
  if (value === undefined) delete process.env.PP_DISABLE_AGY;
  else process.env.PP_DISABLE_AGY = value;
  try { return fn(); }
  finally {
    if (prev === undefined) delete process.env.PP_DISABLE_AGY;
    else process.env.PP_DISABLE_AGY = prev;
  }
}

// ─── 1. Every gate is cross-vendor ───────────────────────────────────────

test("every GateType yields required_cross_vendor:true", () => {
  for (const gate_type of GATE_TYPES) {
    const decision = evaluateGate({ gate_type });
    assert.equal(decision.required_cross_vendor, true, `${gate_type} must be cross-vendor`);
    assert.equal(decision.base_tier, "cross_vendor", `${gate_type} base_tier`);
    assert.match(decision.reason, /JUDGE-1/, `${gate_type} reason must cite JUDGE-1`);
    assert.match(decision.reason, new RegExp(gate_type), `${gate_type} reason names the gate`);
  }
});

test("formerly same-vendor gates stay cross-vendor under every producer/model combination", () => {
  for (const gate_type of ["code_style", "docs_polish", "lint_class"]) {
    for (const generator_producer of ["codex", "agy", "claude", "copilot"]) {
      for (const generator_model of [undefined, DEFAULT_MODELS.codex_critique, "some-unknown-model"]) {
        const d = evaluateGate({ gate_type, generator_producer, generator_model });
        assert.equal(
          d.required_cross_vendor,
          true,
          `${gate_type}/${generator_producer}/${generator_model} must stay cross-vendor`,
        );
      }
    }
  }
});

test("keyword and profile branches still explain the decision via upgraded/reason", () => {
  const plain = evaluateGate({ gate_type: "docs_polish" });
  assert.equal(plain.upgraded, false, "no independent signal → upgraded stays false");

  const keyword = evaluateGate({ gate_type: "docs_polish", prompt_keywords: "rotate the oauth token" });
  assert.equal(keyword.required_cross_vendor, true);
  assert.equal(keyword.upgraded, true, "escalation keyword is an independent signal");
  assert.match(keyword.reason, /escalation keywords/);
  assert.match(keyword.reason, /JUDGE-1/, "JUDGE-1 citation survives an upgrade");

  const profile = evaluateGate({ gate_type: "lint_class", profile: "enterprise" });
  assert.equal(profile.upgraded, true);
  assert.match(profile.reason, /enterprise/);
});

test("rubric selection is unaffected by the every-gate change", () => {
  assert.equal(evaluateGate({ gate_type: "spec" }).rubric_id, "rfc-2119-normative@1");
  assert.equal(evaluateGate({ gate_type: "security" }).rubric_id, "owasp-asvs-l1@1");
  assert.equal(evaluateGate({ gate_type: "security", profile: "enterprise" }).rubric_id, "owasp-asvs-l2@1");
  assert.equal(evaluateGate({ gate_type: "design", profile: "web-ui" }).rubric_id, "wcag-2.2-aa@1");
  assert.equal(evaluateGate({ gate_type: "code_style" }).rubric_id, null);
});

// ─── 2. selectJudgeModels ────────────────────────────────────────────────

test("selectJudgeModels: cross-vendor pairing keeps the full allow-list, default first", () => {
  const sel = selectJudgeModels({ judge_producer: "codex", generator_producer: "claude" });
  assert.equal(sel.available, true);
  assert.equal(sel.reason, null);
  assert.equal(sel.models[0], CODEX.default.model, "default is first");
  assert.equal(sel.models[1], CODEX.escalated.model, "escalated is second");
  assert.deepEqual([...sel.models].sort(), [...CODEX.allowed_models].sort());
});

test("selectJudgeModels: same-vendor with the DEFAULT generator model drops that id", () => {
  // codex default generator is gpt-5.6-luna (an allow-listed judge id too).
  const sel = selectJudgeModels({ judge_producer: "codex", generator_producer: "codex" });
  assert.equal(sel.available, true);
  assert.ok(!sel.models.includes(DEFAULT_MODELS.codex_generate), "generator's own model is dropped");
  assert.equal(sel.models[0], CODEX.default.model);
});

test("selectJudgeModels: same-vendor with an EXPLICIT generator model drops that id", () => {
  const sel = selectJudgeModels({
    judge_producer: "codex",
    generator_producer: "codex",
    generator_model: CODEX.default.model,
  });
  assert.equal(sel.available, true);
  assert.ok(!sel.models.includes(CODEX.default.model));
  assert.equal(sel.models[0], CODEX.escalated.model, "escalated becomes best when the default collides");
});

test("selectJudgeModels: an ESCALATED generator model is dropped too", () => {
  const sel = selectJudgeModels({
    judge_producer: "codex",
    generator_producer: "codex",
    generator_model: CODEX.escalated.model,
  });
  assert.equal(sel.available, true);
  assert.ok(!sel.models.includes(CODEX.escalated.model));
  assert.equal(sel.models[0], CODEX.default.model);
});

test("selectJudgeModels: agy same-vendor keeps seven of eight ids", () => {
  const sel = selectJudgeModels({
    judge_producer: "agy",
    generator_producer: "agy",
    generator_model: AGY.default.model,
  });
  assert.equal(sel.available, true);
  assert.ok(!sel.models.includes(AGY.default.model));
  assert.equal(sel.models.length, AGY.allowed_models.length - 1);
  assert.equal(sel.models[0], AGY.escalated.model);
});

test("selectJudgeModels: generator model is NOT dropped across vendors", () => {
  // A codex generator on gpt-5.6-terra judged by agy: nothing to drop.
  const sel = selectJudgeModels({
    judge_producer: "agy",
    generator_producer: "codex",
    generator_model: CODEX.default.model,
  });
  assert.deepEqual([...sel.models].sort(), [...AGY.allowed_models].sort());
});

test("selectJudgeModels: legacy 'gemini' producer normalizes onto the agy policy", () => {
  const sel = selectJudgeModels({
    judge_producer: "gemini",
    generator_producer: "gemini",
    generator_model: AGY.default.model,
  });
  assert.equal(sel.available, true);
  assert.ok(!sel.models.includes(AGY.default.model), "legacy alias still collides on vendor");
});

test("selectJudgeModels: policy-less producers return an empty, available selection", () => {
  for (const p of ["claude", "copilot"]) {
    const sel = selectJudgeModels({ judge_producer: p, generator_producer: "codex" });
    assert.deepEqual(sel.models, [], `${p} has no CLI model pin`);
    assert.equal(sel.available, true, `${p} lane stays available`);
    assert.equal(sel.reason, null);
  }
});

test("selectJudgeModels: a requested model that survives is promoted to the front", () => {
  const sel = selectJudgeModels({
    judge_producer: "codex",
    generator_producer: "claude",
    requested_judge_model: CODEX.escalated.model,
  });
  assert.equal(sel.available, true);
  assert.equal(sel.models[0], CODEX.escalated.model);
  assert.deepEqual([...sel.models].sort(), [...CODEX.allowed_models].sort(), "no id is lost");
});

test("selectJudgeModels: a requested model absent from the allow-list is rejected", () => {
  const sel = selectJudgeModels({
    judge_producer: "codex",
    generator_producer: "claude",
    requested_judge_model: "gpt-4o-mini",
  });
  assert.equal(sel.available, false);
  assert.equal(sel.reason, "model_not_allowed");
  assert.deepEqual(sel.models, []);
});

test("selectJudgeModels: a requested model identical to the generator's is rejected as same_model_as_generator", () => {
  const sel = selectJudgeModels({
    judge_producer: "codex",
    generator_producer: "codex",
    generator_model: CODEX.default.model,
    requested_judge_model: CODEX.default.model,
  });
  assert.equal(sel.available, false);
  assert.equal(sel.reason, "same_model_as_generator");
});

test("selectJudgeModels: the same request across vendors is legal", () => {
  const sel = selectJudgeModels({
    judge_producer: "codex",
    generator_producer: "agy",
    generator_model: AGY.default.model,
    requested_judge_model: CODEX.default.model,
  });
  assert.equal(sel.available, true);
  assert.equal(sel.models[0], CODEX.default.model);
});

test("selectJudgeModels: a disallowed reasoning effort is rejected", () => {
  const bad = selectJudgeModels({
    judge_producer: "agy",
    generator_producer: "claude",
    requested_judge_effort: "xhigh", // codex-only effort; not in agy's list
  });
  assert.equal(bad.available, false);
  assert.equal(bad.reason, "effort_not_allowed");

  const ok = selectJudgeModels({
    judge_producer: "codex",
    generator_producer: "claude",
    requested_judge_effort: "xhigh",
  });
  assert.equal(ok.available, true);
  assert.equal(ok.reason, null);
});

test("selectJudgeModels: every allowed effort is accepted for its own vendor", () => {
  for (const effort of CODEX.allowed_efforts) {
    const sel = selectJudgeModels({
      judge_producer: "codex", generator_producer: "claude", requested_judge_effort: effort,
    });
    assert.equal(sel.available, true, `codex effort ${effort}`);
  }
  for (const effort of AGY.allowed_efforts) {
    const sel = selectJudgeModels({
      judge_producer: "agy", generator_producer: "claude", requested_judge_effort: effort,
    });
    assert.equal(sel.available, true, `agy effort ${effort}`);
  }
});

test("selectJudgeModels never returns the generator's model for any same-vendor pairing", () => {
  for (const [producer, policy] of [["codex", CODEX], ["agy", AGY]]) {
    for (const generator_model of policy.allowed_models) {
      const sel = selectJudgeModels({
        judge_producer: producer, generator_producer: producer, generator_model,
      });
      assert.equal(sel.available, true, `${producer}/${generator_model} must stay available`);
      assert.ok(
        !sel.models.includes(generator_model),
        `${producer} judge must never reuse generator model ${generator_model}`,
      );
    }
  }
});

// ─── 3. resolveSameVendorCapability — agy branch mirrors codex ───────────

test("resolveSameVendorCapability: agy picks a DIFFERENT allow-listed id", () => {
  const cap = resolveSameVendorCapability({ generator_producer: "agy" });
  assert.equal(cap.available, true);
  assert.equal(cap.effective_generator_model, DEFAULT_MODELS.agy_generate);
  assert.notEqual(cap.judge_model_id, cap.effective_generator_model, "never the same id");
  assert.ok(AGY.allowed_models.includes(cap.judge_model_id));
});

test("resolveSameVendorCapability: agy with an off-list generator model keeps the default judge id", () => {
  const cap = resolveSameVendorCapability({
    generator_producer: "agy",
    generator_model: "claude-sonnet-4-6", // served by agy, not a judge id
  });
  assert.equal(cap.available, true);
  assert.equal(cap.judge_model_id, AGY.default.model);
});

// ─── 4. listAllowedJudges — exactly one closing lane ─────────────────────

test("listAllowedJudges: exactly one closing lane, and it is judge-cross-vendor", () => {
  for (const gate_type of GATE_TYPES) {
    for (const generator_producer of ["codex", "agy", "claude"]) {
      const decision = evaluateGate({ gate_type, generator_producer });
      const judges = listAllowedJudges(decision, generator_producer);
      const closing = judges.filter((j) => j.closing);
      assert.equal(closing.length, 1, `${gate_type}/${generator_producer}: exactly one closing lane`);
      assert.equal(closing[0].agent, "judge-cross-vendor");
      assert.equal(closing[0].tier, "cross_vendor");
      assert.ok(closing[0].preferred_producers.length > 0, "closing lane is never empty");
      assert.ok(
        !closing[0].preferred_producers.includes(generator_producer),
        "the closing lane never names the generator's own producer",
      );
    }
  }
});

test("listAllowedJudges: the cross-vendor lane is always first", () => {
  const decision = evaluateGate({ gate_type: "code_style", generator_producer: "codex" });
  const judges = listAllowedJudges(decision, "codex");
  assert.equal(judges[0].agent, "judge-cross-vendor");
});

test("listAllowedJudges: a same-vendor lane is supplementary (closing:false), never alone", () => {
  const decision = evaluateGate({ gate_type: "code_style", generator_producer: "codex" });
  const judges = listAllowedJudges(decision, "codex", { generator_model: DEFAULT_MODELS.codex_generate });
  const same = judges.find((j) => j.agent === "judge-same-vendor");
  assert.ok(same, "codex keeps a supplementary same-vendor lane");
  assert.equal(same.closing, false);
  assert.equal(same.tier, "same_vendor");
  assert.deepEqual(same.preferred_producers, ["codex"]);
  assert.ok(!same.preferred_models.includes(DEFAULT_MODELS.codex_generate));
  assert.ok(judges.length > 1, "a same-vendor lane is never the only entry");
});

test("listAllowedJudges: preferred_models carry the allow-list for the preferred producers", () => {
  const decision = evaluateGate({ gate_type: "spec", generator_producer: "claude" });
  const judges = listAllowedJudges(decision, "claude");
  const cross = judges.find((j) => j.closing);
  assert.deepEqual([...cross.preferred_producers].sort(), ["agy", "codex"]);
  for (const id of [CODEX.default.model, CODEX.escalated.model, AGY.default.model, AGY.escalated.model]) {
    assert.ok(cross.preferred_models.includes(id), `preferred_models should include ${id}`);
  }
  assert.equal(new Set(cross.preferred_models).size, cross.preferred_models.length, "no duplicates");
});

test("listAllowedJudges: a requested model narrows the closing lane to the vendor that serves it", () => {
  const decision = evaluateGate({ gate_type: "spec", generator_producer: "claude" });
  const judges = listAllowedJudges(decision, "claude", {
    requested_judge_model: CODEX.escalated.model,
  });
  const cross = judges.find((j) => j.closing);
  assert.ok(cross.preferred_producers.includes("codex"));
  assert.ok(!cross.preferred_producers.includes("agy"), "agy cannot serve a codex id");
  assert.equal(cross.preferred_models[0], CODEX.escalated.model);
});

test("listAllowedJudges: an unservable requested model still leaves a non-empty closing lane", () => {
  const decision = evaluateGate({ gate_type: "spec", generator_producer: "claude" });
  const judges = listAllowedJudges(decision, "claude", { requested_judge_model: "gpt-4o-mini" });
  const cross = judges.find((j) => j.closing);
  assert.ok(cross, "the closing lane always exists");
  // claude carries no policy so it remains viable; the driver rejects the
  // override rather than the daemon returning an empty lane.
  assert.ok(cross.preferred_producers.length > 0);
});

// ─── 5. PP_DISABLE_AGY=1 ─────────────────────────────────────────────────

test("PP_DISABLE_AGY=1 drops agy from preferred_producers AND preferred_models", () => {
  withFlag("1", () => {
    const decision = evaluateGate({ gate_type: "code_style", generator_producer: "claude" });
    const judges = listAllowedJudges(decision, "claude");
    const cross = judges.find((j) => j.closing);
    assert.deepEqual(cross.preferred_producers, ["codex"]);
    for (const id of AGY.allowed_models) {
      assert.ok(!cross.preferred_models.includes(id), `agy id ${id} must not be offered when disabled`);
    }
    assert.ok(cross.preferred_models.includes(CODEX.default.model));
  });
});

test("PP_DISABLE_AGY=1 drops the agy same-vendor lane but keeps a closing lane", () => {
  withFlag("1", () => {
    const decision = evaluateGate({ gate_type: "docs_polish", generator_producer: "agy" });
    const judges = listAllowedJudges(decision, "agy");
    assert.equal(judges.find((j) => j.agent === "judge-same-vendor"), undefined);
    const closing = judges.filter((j) => j.closing);
    assert.equal(closing.length, 1);
    assert.deepEqual([...closing[0].preferred_producers].sort(), ["claude", "codex"]);
  });
});

test("agy enabled: agy is back in both the producer pool and preferred_models", () => {
  withFlag("0", () => {
    const decision = evaluateGate({ gate_type: "code_style", generator_producer: "claude" });
    const cross = listAllowedJudges(decision, "claude").find((j) => j.closing);
    assert.deepEqual([...cross.preferred_producers].sort(), ["agy", "codex"]);
    assert.ok(cross.preferred_models.includes(AGY.default.model));
  });
});
