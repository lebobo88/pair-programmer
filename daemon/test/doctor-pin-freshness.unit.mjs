// Unit tests for J7 — doctor()'s pin-freshness surface, exercised through the
// pure helpers it is built from. No CLI is spawned and doctor() itself is NOT
// called: it probes `agy models`, the Codex bridge, and Playwright, none of
// which are available (or deterministic) in an offline agent context.
//
// Covers:
//   - evaluateCodexPin(): tri-state served-vs-requested comparison.
//     * CLI reported nothing            -> null  (known unknown, not a failure)
//     * CLI reported the requested id   -> true, no note
//     * CLI reported a different id     -> false + an operator-facing note
//   - the vendor_degraded.openai rule that consumes it.
//   - unpricedJudgeModels(): every allow-listed judge id must have a price row;
//     an unpriced id bills 0 through computeCost() and no budget scope moves.
//   - evaluateAgyPins() aggregation as doctor consumes it (per-lane detail).
//
// Runs against the compiled dist/ with a throwaway PP_HOME so the prices table
// is seeded from the bundled daemon/prices.json rather than the operator's.

import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync, mkdirSync } from "node:fs";
import test from "node:test";
import assert from "node:assert/strict";

const SUITE_DIR = mkdtempSync(join(tmpdir(), "pp-doctor-pin-"));
mkdirSync(join(SUITE_DIR, ".pair-programmer"), { recursive: true });
process.env.PP_HOME = SUITE_DIR;

const __dirname = dirname(fileURLToPath(import.meta.url));
const DIST = join(__dirname, "..", "dist");
const importDist = (relPath) => import(pathToFileURL(join(DIST, relPath)).href);

const { DEFAULT_MODELS, JUDGE_MODEL_POLICY } = await importDist("config.js");
const { computeCost } = await importDist("util/prices.js");
const { evaluateCodexPin, unpricedJudgeModels } = await importDist("orchestrator/runs.js");
const { evaluateAgyPins, defaultAgyPins, parseAgyModels } =
  await importDist("orchestrator/agy-pin.js");

// ─── evaluateCodexPin ───────────────────────────────────────────────────────

test("evaluateCodexPin: CLI reported no model -> null, never false", () => {
  for (const reported of [undefined, null, "", "   "]) {
    const res = evaluateCodexPin(DEFAULT_MODELS.codex_critique, reported);
    assert.equal(res.codex_pin_served, null, `reported=${JSON.stringify(reported)}`);
    assert.equal(res.reported_model, null);
    assert.equal(res.pinned_model, DEFAULT_MODELS.codex_critique);
    assert.match(res.note, /inconclusive/);
    assert.match(res.note, /known unknown/);
  }
});

test("evaluateCodexPin: served id equals the pin -> true, no note", () => {
  const res = evaluateCodexPin("gpt-5.6-terra", "gpt-5.6-terra");
  assert.equal(res.codex_pin_served, true);
  assert.equal(res.note, null);
  assert.equal(res.reported_model, "gpt-5.6-terra");
});

test("evaluateCodexPin: served id differs -> false with both ids in the note", () => {
  const res = evaluateCodexPin("gpt-5.6-terra", "gpt-5.6-luna");
  assert.equal(res.codex_pin_served, false);
  assert.equal(res.reported_model, "gpt-5.6-luna");
  assert.match(res.note, /gpt-5\.6-terra/);
  assert.match(res.note, /gpt-5\.6-luna/);
  assert.match(res.note, /mismatch/i);
});

test("evaluateCodexPin: surrounding whitespace in the CLI report is not a mismatch", () => {
  const res = evaluateCodexPin("gpt-5.6-terra", "  gpt-5.6-terra\n");
  assert.equal(res.codex_pin_served, true);
  assert.equal(res.reported_model, "gpt-5.6-terra");
});

test("doctor degradation rule: only a hard false marks openai degraded", () => {
  // Mirrors the expression in runs.ts doctor(): codex_pin_served === false.
  const degraded = (reported) =>
    evaluateCodexPin("gpt-5.6-terra", reported).codex_pin_served === false;
  assert.equal(degraded("gpt-5.6-luna"), true);
  assert.equal(degraded("gpt-5.6-terra"), false);
  assert.equal(degraded(undefined), false, "an unreported model must not degrade the vendor");
});

// ─── unpricedJudgeModels ────────────────────────────────────────────────────

test("unpricedJudgeModels: every allow-listed judge id has a price row", () => {
  const unpriced = unpricedJudgeModels();
  assert.deepEqual(
    unpriced,
    [],
    `allow-listed judge ids with no rate in prices.json: ${unpriced.join(", ")}. ` +
      "computeCost() returns 0 for these, so their calls bill nothing.",
  );
});

test("unpricedJudgeModels: the zero-cost probe it relies on is real", () => {
  // The detection rule: 1M in + 1M out priced at exactly 0 means "no row".
  assert.equal(computeCost("definitely-not-a-real-model-id", 1_000_000, 1_000_000), 0);
  for (const vendor of Object.keys(JUDGE_MODEL_POLICY)) {
    for (const id of JUDGE_MODEL_POLICY[vendor].allowed_models) {
      assert.ok(
        computeCost(id, 1_000_000, 1_000_000) > 0,
        `${vendor}/${id} must price above zero at 1M/1M tokens`,
      );
    }
  }
});

test("unpricedJudgeModels covers both vendors' allow-lists, deduplicated", () => {
  // Guard the shape of the scan: it must walk codex AND agy, not just one.
  assert.ok(Object.keys(JUDGE_MODEL_POLICY).includes("codex"));
  assert.ok(Object.keys(JUDGE_MODEL_POLICY).includes("agy"));
  const result = unpricedJudgeModels();
  assert.ok(Array.isArray(result));
  assert.equal(new Set(result).size, result.length, "no duplicate ids");
});

// ─── the agy half of the same doctor surface ────────────────────────────────

const AGY_MODELS_STDOUT = [
  "Fetching available models...",
  "gemini-3.8-flash-high\tGemini 3.8 Flash (High)",
  "gemini-3.8-flash-medium\tGemini 3.8 Flash (Medium)",
  "gemini-3.8-flash-low\tGemini 3.8 Flash (Low)",
  "gemini-3.7-flash-high\tGemini 3.7 Flash (High)",
  "gemini-3.7-flash-medium\tGemini 3.7 Flash (Medium)",
  "gemini-3.7-flash-low\tGemini 3.7 Flash (Low)",
  "gemini-3.1-pro-high\tGemini 3.1 Pro (High)",
  "gemini-3.1-pro-low\tGemini 3.1 Pro (Low)",
  "",
].join("\n");

test("doctor's agy surface: healthy install is all-true with no drift", () => {
  const res = evaluateAgyPins(defaultAgyPins(), parseAgyModels(AGY_MODELS_STDOUT));
  assert.equal(res.agy_pin_served, true);
  assert.deepEqual(res.per_pin, {
    critique_default: true,
    critique_escalated: true,
    generate: true,
  });
  assert.deepEqual(res.unserved_allowlist, []);
  assert.equal(res.note, null);
});

test("doctor's agy surface: a retired default pin degrades google", () => {
  const served = parseAgyModels(AGY_MODELS_STDOUT).filter(
    (id) => id !== DEFAULT_MODELS.agy_critique,
  );
  const res = evaluateAgyPins(defaultAgyPins(), served);
  assert.equal(res.agy_pin_served, false);
  assert.equal(res.per_pin.critique_default, false);
  assert.equal(res.per_pin.critique_escalated, true);
});

test("doctor's skipped-CLI shape matches the AgyPinCheck contract", () => {
  // The literal doctor() builds when the agy CLI is absent.
  const skipped = {
    agy_pin_served: null,
    pinned_model: DEFAULT_MODELS.agy_critique,
    pinned_models: defaultAgyPins(),
    per_pin: Object.fromEntries(Object.keys(defaultAgyPins()).map((k) => [k, null])),
    served_models: null,
    unserved_allowlist: [],
    note: "agy CLI not installed; pinned-model check skipped.",
  };
  const real = evaluateAgyPins(defaultAgyPins(), null, "probe skipped");
  assert.deepEqual(Object.keys(skipped).sort(), Object.keys(real).sort());
  assert.deepEqual(skipped.per_pin, real.per_pin);
});
