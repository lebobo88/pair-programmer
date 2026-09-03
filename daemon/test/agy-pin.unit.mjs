// Unit tests for the agy pinned-model served check (finding E2-1).
//
// Covers:
//   - DEFAULT_MODELS.agy_* are re-pinned to gemini-3.8-flash-medium.
//   - DEFAULT_MODELS.agy_critique_escalated is the gemini-3.1-pro-high lane.
//   - parseAgyModels() extracts ids from real `agy models` output shape.
//   - evaluateAgyPin() -> ok when the pin is in the served list.
//   - evaluateAgyPin() -> degraded (false) when the pin is absent.
//   - evaluateAgyPin() -> fail-soft null when the probe produced nothing.
//
// The models list is mocked (passed in directly); no CLI is invoked. Runs
// against the compiled dist/.

import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync, mkdirSync } from "node:fs";
import test from "node:test";
import assert from "node:assert/strict";

const SUITE_DIR = mkdtempSync(join(tmpdir(), "pp-agy-pin-"));
mkdirSync(join(SUITE_DIR, ".pair-programmer"), { recursive: true });
process.env.PP_HOME = SUITE_DIR;

const __dirname = dirname(fileURLToPath(import.meta.url));
const DIST = join(__dirname, "..", "dist");
const importDist = (relPath) => import(pathToFileURL(join(DIST, relPath)).href);

const { DEFAULT_MODELS } = await importDist("config.js");
const { parseAgyModels, evaluateAgyPin } = await importDist("orchestrator/agy-pin.js");

// Verbatim `agy models` output (agy 1.1.24, 2026-09-02).
const AGY_MODELS_STDOUT = [
  "Fetching available models...",
  "gemini-3.8-flash-high\tGemini 3.8 Flash (High)",
  "gemini-3.8-flash-medium\tGemini 3.8 Flash (Medium)",
  "gemini-3.8-flash-low\tGemini 3.8 Flash (Low)",
  "gemini-3.7-flash-high\tGemini 3.7 Flash (High)",
  "gemini-3.7-flash-medium\tGemini 3.7 Flash (Medium)",
  "gemini-3.7-flash-low\tGemini 3.7 Flash (Low)",
  "gemini-3.6-flash-high\tGemini 3.6 Flash (High)",
  "gemini-3.6-flash-medium\tGemini 3.6 Flash (Medium)",
  "gemini-3.6-flash-low\tGemini 3.6 Flash (Low)",
  "gemini-3.1-pro-high\tGemini 3.1 Pro (High)",
  "gemini-3.1-pro-low\tGemini 3.1 Pro (Low)",
  "claude-sonnet-4-6\tClaude Sonnet 4.6 (Thinking)",
  "claude-opus-4-6-thinking\tClaude Opus 4.6 (Thinking)",
  "gpt-oss-120b-medium\tGPT-OSS 120B (Medium)",
  "",
].join("\n");

test("E2-1: agy pins point at a served model id, not gemini-3.1-pro-preview", () => {
  assert.equal(DEFAULT_MODELS.agy_critique, "gemini-3.8-flash-medium");
  assert.equal(DEFAULT_MODELS.agy_generate, "gemini-3.8-flash-medium");
  assert.equal(DEFAULT_MODELS.agy_critique_escalated, "gemini-3.1-pro-high");
  const served = parseAgyModels(AGY_MODELS_STDOUT);
  assert.ok(
    served.includes(DEFAULT_MODELS.agy_critique),
    "the shipped agy_critique pin must appear in the served-model list",
  );
  assert.ok(!served.includes("gemini-3.1-pro-preview"), "the retired id is not served");
});

test("parseAgyModels skips the progress line and keeps only ids", () => {
  const ids = parseAgyModels(AGY_MODELS_STDOUT);
  assert.equal(ids.length, 14);
  assert.equal(ids[0], "gemini-3.8-flash-high");
  assert.equal(ids.at(-1), "gpt-oss-120b-medium");
  assert.ok(!ids.some((id) => /\s/.test(id)), "no human labels leaked into the id list");
  assert.ok(!ids.includes("Fetching"), "the progress line must not be parsed as a model");
});

test("parseAgyModels on empty / non-model output yields no ids", () => {
  assert.deepEqual(parseAgyModels(""), []);
  assert.deepEqual(parseAgyModels("Fetching available models...\n"), []);
});

test("evaluateAgyPin: pin present in served list -> served, no note", () => {
  const res = evaluateAgyPin("gemini-3.8-flash-medium", parseAgyModels(AGY_MODELS_STDOUT));
  assert.equal(res.agy_pin_served, true);
  assert.equal(res.note, null);
  assert.equal(res.pinned_model, "gemini-3.8-flash-medium");
});

test("evaluateAgyPin: pin absent from served list -> degraded with a warning", () => {
  // The exact E2-1 condition: the old pin against today's served list.
  const res = evaluateAgyPin("gemini-3.1-pro-preview", parseAgyModels(AGY_MODELS_STDOUT));
  assert.equal(res.agy_pin_served, false);
  assert.ok(res.note, "a degraded pin must carry an operator-facing note");
  assert.match(res.note, /gemini-3\.1-pro-preview/);
  assert.match(res.note, /NOT served/);
  assert.ok(res.served_models.includes("gemini-3.8-flash-medium"));
});

test("evaluateAgyPin: probe failure is fail-soft null, never false", () => {
  const res = evaluateAgyPin("gemini-3.8-flash-medium", null, "`agy models` failed: ENOENT");
  assert.equal(res.agy_pin_served, null);
  assert.equal(res.served_models, null);
  assert.match(res.note, /inconclusive/);
  assert.match(res.note, /ENOENT/);
});

test("evaluateAgyPin: empty parsed list is inconclusive, not degraded", () => {
  // An output-format change must not be reported as "the pin disappeared".
  const res = evaluateAgyPin("gemini-3.8-flash-medium", []);
  assert.equal(res.agy_pin_served, null);
  assert.match(res.note, /inconclusive/);
});

test("doctor degradation rule: only a hard false marks google degraded", () => {
  // Mirrors the expression in runs.ts doctor(): agy_pin_served === false.
  const degradedFor = (pin) => evaluateAgyPin(pin, parseAgyModels(AGY_MODELS_STDOUT)).agy_pin_served === false;
  assert.equal(degradedFor("gemini-3.1-pro-preview"), true);
  assert.equal(degradedFor("gemini-3.8-flash-medium"), false);
  assert.equal(evaluateAgyPin("gemini-3.8-flash-medium", null).agy_pin_served === false, false);
});
