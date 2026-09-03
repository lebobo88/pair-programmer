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
const { parseAgyModels, evaluateAgyPin, evaluateAgyPins, defaultAgyPins } =
  await importDist("orchestrator/agy-pin.js");

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

// ─── J7: multi-pin freshness (evaluateAgyPins) ──────────────────────────────
//
// doctor() no longer checks one scalar pin. It checks every lane pp can
// actually invoke — the default critique pin, the escalated critique pin, and
// the generate pin — and separately reports allow-list drift.

const SERVED_ALL = parseAgyModels(AGY_MODELS_STDOUT);

test("defaultAgyPins covers all three lanes and matches DEFAULT_MODELS", () => {
  const pins = defaultAgyPins();
  assert.deepEqual(Object.keys(pins).sort(), ["critique_default", "critique_escalated", "generate"]);
  assert.equal(pins.critique_default, DEFAULT_MODELS.agy_critique);
  assert.equal(pins.critique_escalated, DEFAULT_MODELS.agy_critique_escalated);
  assert.equal(pins.generate, DEFAULT_MODELS.agy_generate);
});

test("evaluateAgyPins: every shipped pin served -> aggregate true, per_pin all true", () => {
  const res = evaluateAgyPins(defaultAgyPins(), SERVED_ALL);
  assert.equal(res.agy_pin_served, true);
  assert.deepEqual(res.per_pin, {
    critique_default: true,
    critique_escalated: true,
    generate: true,
  });
  assert.deepEqual(res.unserved_allowlist, [], "shipped allow-list is a subset of the served list");
  assert.equal(res.note, null);
  // Legacy fields survive for existing consumers.
  assert.equal(res.pinned_model, DEFAULT_MODELS.agy_critique);
  assert.equal(res.pinned_models.critique_escalated, DEFAULT_MODELS.agy_critique_escalated);
});

test("evaluateAgyPins: escalated pin absent -> aggregate false, per_pin isolates the lane", () => {
  const served = SERVED_ALL.filter((id) => id !== "gemini-3.1-pro-high");
  const res = evaluateAgyPins(defaultAgyPins(), served);
  assert.equal(res.agy_pin_served, false, "one unserved pin degrades the aggregate");
  assert.equal(res.per_pin.critique_default, true);
  assert.equal(res.per_pin.generate, true);
  assert.equal(res.per_pin.critique_escalated, false, "only the escalated lane is broken");
  assert.match(res.note, /critique_escalated="gemini-3\.1-pro-high"/);
  assert.match(res.note, /invalid model selection/, "the note states the real agy behaviour");
  assert.ok(res.unserved_allowlist.includes("gemini-3.1-pro-high"));
});

test("evaluateAgyPins: probe failure -> aggregate null and every lane null", () => {
  const res = evaluateAgyPins(defaultAgyPins(), null, "`agy models` failed: ENOENT");
  assert.equal(res.agy_pin_served, null);
  assert.deepEqual(res.per_pin, {
    critique_default: null,
    critique_escalated: null,
    generate: null,
  });
  assert.equal(res.served_models, null);
  assert.deepEqual(res.unserved_allowlist, [], "no drift claim can be made without a served list");
  assert.match(res.note, /inconclusive/);
  assert.match(res.note, /ENOENT/);
});

test("evaluateAgyPins: an empty parsed list is inconclusive, never a hard false", () => {
  const res = evaluateAgyPins(defaultAgyPins(), []);
  assert.equal(res.agy_pin_served, null);
  assert.ok(Object.values(res.per_pin).every((v) => v === null));
});

test("evaluateAgyPins: unserved_allowlist surfaces drift while every pin is healthy", () => {
  // gemini-3.1-pro-low is allow-listed for operator overrides but is NOT a pin.
  // Dropping it must leave the aggregate true and still report the drift.
  const served = SERVED_ALL.filter((id) => id !== "gemini-3.1-pro-low");
  const res = evaluateAgyPins(defaultAgyPins(), served);
  assert.equal(res.agy_pin_served, true, "a non-pinned allow-list gap is not a degradation");
  assert.ok(Object.values(res.per_pin).every((v) => v === true));
  assert.deepEqual(res.unserved_allowlist, ["gemini-3.1-pro-low"]);
  assert.match(res.note, /allow-list drift/);
});

test("evaluateAgyPin (legacy single-pin form) keeps its shape and adds the new fields", () => {
  const ok = evaluateAgyPin(DEFAULT_MODELS.agy_critique, SERVED_ALL);
  assert.equal(ok.agy_pin_served, true);
  assert.equal(ok.note, null, "a served single pin still carries no note");
  assert.equal(ok.pinned_model, DEFAULT_MODELS.agy_critique);
  assert.deepEqual(ok.per_pin, { critique_default: true });
  assert.deepEqual(ok.pinned_models, { critique_default: DEFAULT_MODELS.agy_critique });

  const bad = evaluateAgyPin("gemini-3.1-pro-preview", SERVED_ALL);
  assert.equal(bad.agy_pin_served, false);
  assert.deepEqual(bad.per_pin, { critique_default: false });
  assert.match(bad.note, /NOT served/);
  // The corrected rationale: agy rejects, it does not silently fall back.
  assert.match(bad.note, /invalid model selection/);
  assert.ok(!/falls back silently/.test(bad.note));
});
