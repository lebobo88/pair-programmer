// Shape contract for describeJudgeCapabilities() — the per-vendor judge
// capability summary that doctor() and gate_eligible_judges publish.
//
// Hydra's host_bridge reads `critique_model` directly and previously carried
// static fallback pins because pp never published the escalated id or the
// allow-list. These tests lock the additive surface (J6):
//   - `critique_model` still exists and still equals the vendor default.
//   - `allowed_critique_models` is a superset of {default, escalated}.
//   - claude stays `driver_selected` with a null model.
//   - the effort lists match JUDGE_MODEL_POLICY exactly.
//
// Everything is derived from JUDGE_MODEL_POLICY, so these tests compare against
// the policy table rather than hard-coding ids — repinning the constitution's
// judge should not require editing this file.

import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync, mkdirSync } from "node:fs";
import test from "node:test";
import assert from "node:assert/strict";

const SUITE_DIR = mkdtempSync(join(tmpdir(), "pp-judge-caps-"));
mkdirSync(join(SUITE_DIR, ".pair-programmer"), { recursive: true });
process.env.PP_HOME = SUITE_DIR;

const __dirname = dirname(fileURLToPath(import.meta.url));
const DIST = join(__dirname, "..", "dist");
const importDist = (relPath) => import(pathToFileURL(join(DIST, relPath)).href);

const { describeJudgeCapabilities } = await importDist("orchestrator/gates.js");
const { JUDGE_MODEL_POLICY, DEFAULT_MODELS } = await importDist("config.js");

const CAPS = describeJudgeCapabilities();

const REQUIRED_FIELDS = [
  "critique_model",
  "default_critique_model",
  "escalated_critique_model",
  "allowed_critique_models",
  "default_reasoning_effort",
  "allowed_reasoning_efforts",
  "same_vendor_mode",
  "unavailable_when_generator_model_is",
  "notes",
];

test("every vendor entry carries the full field set", () => {
  assert.deepEqual(Object.keys(CAPS).sort(), ["agy", "claude", "codex"]);
  for (const [vendor, summary] of Object.entries(CAPS)) {
    for (const field of REQUIRED_FIELDS) {
      assert.ok(field in summary, `${vendor}.${field} must be present`);
    }
    assert.ok(Array.isArray(summary.allowed_critique_models), `${vendor}.allowed_critique_models is an array`);
    assert.ok(Array.isArray(summary.allowed_reasoning_efforts), `${vendor}.allowed_reasoning_efforts is an array`);
    assert.ok(Array.isArray(summary.unavailable_when_generator_model_is));
    assert.equal(typeof summary.notes, "string");
    assert.ok(summary.notes.length > 0, `${vendor}.notes is non-empty`);
  }
});

test("critique_model (the field Hydra reads) still equals the vendor default", () => {
  assert.equal(CAPS.codex.critique_model, JUDGE_MODEL_POLICY.codex.default.model);
  assert.equal(CAPS.codex.critique_model, CAPS.codex.default_critique_model);
  assert.equal(CAPS.codex.critique_model, DEFAULT_MODELS.codex_critique);

  assert.equal(CAPS.agy.critique_model, JUDGE_MODEL_POLICY.agy.default.model);
  assert.equal(CAPS.agy.critique_model, CAPS.agy.default_critique_model);
  assert.equal(CAPS.agy.critique_model, DEFAULT_MODELS.agy_critique);
});

test("escalated_critique_model matches the policy escalated pin", () => {
  assert.equal(CAPS.codex.escalated_critique_model, JUDGE_MODEL_POLICY.codex.escalated.model);
  assert.equal(CAPS.codex.escalated_critique_model, DEFAULT_MODELS.codex_critique_escalated);
  assert.equal(CAPS.agy.escalated_critique_model, JUDGE_MODEL_POLICY.agy.escalated.model);
  assert.equal(CAPS.agy.escalated_critique_model, DEFAULT_MODELS.agy_critique_escalated);
});

test("allowed_critique_models is a superset of {default, escalated}", () => {
  for (const vendor of ["codex", "agy"]) {
    const summary = CAPS[vendor];
    assert.ok(
      summary.allowed_critique_models.includes(summary.default_critique_model),
      `${vendor}: default must be allow-listed`,
    );
    assert.ok(
      summary.allowed_critique_models.includes(summary.escalated_critique_model),
      `${vendor}: escalated must be allow-listed`,
    );
    assert.deepEqual(
      summary.allowed_critique_models,
      [...JUDGE_MODEL_POLICY[vendor].allowed_models],
      `${vendor}: allow-list is derived verbatim from JUDGE_MODEL_POLICY`,
    );
  }
});

test("effort lists match the policy exactly", () => {
  for (const vendor of ["codex", "agy"]) {
    assert.equal(
      CAPS[vendor].default_reasoning_effort,
      JUDGE_MODEL_POLICY[vendor].default.reasoning_effort,
    );
    assert.deepEqual(
      CAPS[vendor].allowed_reasoning_efforts,
      [...JUDGE_MODEL_POLICY[vendor].allowed_efforts],
    );
    assert.ok(
      CAPS[vendor].allowed_reasoning_efforts.includes(CAPS[vendor].default_reasoning_effort),
      `${vendor}: the default effort must itself be allowed`,
    );
  }
});

test("agy is conditional_cross_vendor, not degenerate, and the note says so", () => {
  assert.equal(CAPS.agy.same_vendor_mode, "conditional_cross_vendor");
  assert.deepEqual(CAPS.agy.unavailable_when_generator_model_is, []);
  assert.ok(
    CAPS.agy.allowed_critique_models.length >= 8,
    "agy serves at least eight critique-eligible ids",
  );
  assert.match(CAPS.agy.notes, /eight/i, "the note names the eight served ids");
  assert.match(CAPS.agy.notes, /record_verdict/, "the note names the record_verdict rejection");
  assert.doesNotMatch(CAPS.agy.notes, /hard-pinned/, "the stale hard-pin claim is gone");
});

test("codex stays conditional_cross_vendor", () => {
  assert.equal(CAPS.codex.same_vendor_mode, "conditional_cross_vendor");
  assert.deepEqual(CAPS.codex.unavailable_when_generator_model_is, [
    JUDGE_MODEL_POLICY.codex.default.model,
  ]);
});

test("claude stays driver_selected with a null model and empty lists", () => {
  assert.equal(CAPS.claude.same_vendor_mode, "driver_selected");
  assert.equal(CAPS.claude.critique_model, null);
  assert.equal(CAPS.claude.default_critique_model, null);
  assert.equal(CAPS.claude.escalated_critique_model, null);
  assert.deepEqual(CAPS.claude.allowed_critique_models, []);
  assert.equal(CAPS.claude.default_reasoning_effort, null);
  assert.deepEqual(CAPS.claude.allowed_reasoning_efforts, []);
});

test("the summary is a fresh object each call (no shared mutable arrays)", () => {
  const a = describeJudgeCapabilities();
  const b = describeJudgeCapabilities();
  assert.notEqual(a.codex.allowed_critique_models, b.codex.allowed_critique_models);
  a.codex.allowed_critique_models.push("mutated");
  assert.ok(!describeJudgeCapabilities().codex.allowed_critique_models.includes("mutated"));
});
