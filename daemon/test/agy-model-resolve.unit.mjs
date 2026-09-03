// Unit tests for the agy model-id resolver (mcp/agy-model.ts) and the
// vendor-agnostic judge selection resolver (config.ts).
//
// Covers:
//   1. splitAgyModelId — suffix split, bare family, retired non-effort suffix.
//   2. resolveAgyInvocation — every canonicalization case, table-driven:
//      suffixed alone, suffixed + matching effort, suffixed + conflicting
//      effort, bare family + effort, bare family alone, nothing given,
//      unknown id / unknown family.
//   3. resolveJudgeSelection — default, escalated, ambiguity, allow-list
//      enforcement, effort range, and the override_source + override_reason
//      requirement for any deviation from the pinned default.
//   4. prices() merges bundled (vendor, model) rates missing from an
//      operator's on-disk prices.json, so a newly pinned model never prices
//      at 0 on an install whose prices.json predates it.
//
// Pure/offline: no daemon, no MCP peer, no subprocess. Runs against dist/.
//
// DE-HARDCODING POLICY: expectations derive from JUDGE_MODEL_POLICY /
// DEFAULT_MODELS wherever the value is policy-dependent. The retained literals
// are (a) EXPECTED_AGY_PIN / EXPECTED_AGY_ESCALATED — deliberate tripwires that
// catch a silent agy repin, which a derived assertion would be blind to, and
// (b) ids that must always be REJECTED and therefore must never track config.

import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { strict as assert } from "node:assert";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DIST = join(__dirname, "..", "dist");

// PP_HOME must be set before any dist import that resolves paths.js.
const SUITE_DIR = mkdtempSync(join(tmpdir(), "pp-agy-model-resolve-"));
const PP_ROOT = join(SUITE_DIR, ".pair-programmer");
mkdirSync(PP_ROOT, { recursive: true });
process.env.PP_HOME = SUITE_DIR;

// An operator prices.json that PREDATES the 3.8 pin: it has the 3.7 lane but
// none of the 3.8 ids. prices() must fill the gap in memory from the bundle.
writeFileSync(
  join(PP_ROOT, "prices.json"),
  JSON.stringify(
    {
      _comment: "test fixture — deliberately missing the gemini-3.8-* lane",
      google: {
        "gemini-3.7-flash-medium": { input: 1.0, output: 3.0 },
      },
      openai: {
        "gpt-5.6-terra": { input: 999.0, output: 999.0 },
      },
    },
    null,
    2,
  ),
  "utf8",
);

const importDist = (relPath) => import(pathToFileURL(join(DIST, relPath)).href);

const { JUDGE_MODEL_POLICY, DEFAULT_MODELS, resolveJudgeSelection, judgePolicyFor, isAllowedJudgeModel } =
  await importDist("config.js");
const { resolveAgyInvocation, splitAgyModelId } = await importDist("mcp/agy-model.js");

// Tripwire literals — intentionally NOT derived.
const EXPECTED_AGY_PIN = "gemini-3.8-flash-medium";
const EXPECTED_AGY_ESCALATED = "gemini-3.1-pro-high";

let passed = 0;
let failed = 0;

function it(label, fn) {
  try {
    fn();
    passed++;
    console.log(`✓ ${label}`);
  } catch (err) {
    failed++;
    console.error(`✗ ${label}`);
    console.error(`  ${err.message}`);
  }
}

// ─── 0. Pins ─────────────────────────────────────────────────────────────

it(`agy default pin is ${EXPECTED_AGY_PIN}`, () => {
  assert.equal(JUDGE_MODEL_POLICY.agy.default.model, EXPECTED_AGY_PIN);
  assert.equal(DEFAULT_MODELS.agy_critique, EXPECTED_AGY_PIN);
  assert.equal(DEFAULT_MODELS.agy_generate, EXPECTED_AGY_PIN);
});

it(`agy escalated pin is ${EXPECTED_AGY_ESCALATED} at high effort`, () => {
  assert.equal(JUDGE_MODEL_POLICY.agy.escalated.model, EXPECTED_AGY_ESCALATED);
  assert.equal(JUDGE_MODEL_POLICY.agy.escalated.reasoning_effort, "high");
  assert.equal(DEFAULT_MODELS.agy_critique_escalated, EXPECTED_AGY_ESCALATED);
});

it("DEFAULT_MODELS critique entries are derived from JUDGE_MODEL_POLICY", () => {
  assert.equal(DEFAULT_MODELS.codex_critique, JUDGE_MODEL_POLICY.codex.default.model);
  assert.equal(DEFAULT_MODELS.codex_critique_escalated, JUDGE_MODEL_POLICY.codex.escalated.model);
  assert.equal(DEFAULT_MODELS.agy_critique, JUDGE_MODEL_POLICY.agy.default.model);
  assert.equal(DEFAULT_MODELS.agy_critique_escalated, JUDGE_MODEL_POLICY.agy.escalated.model);
});

// ─── 1. splitAgyModelId ──────────────────────────────────────────────────

it("splitAgyModelId splits a served suffixed id", () => {
  assert.deepEqual(splitAgyModelId("gemini-3.8-flash-medium"), {
    family: "gemini-3.8-flash",
    effort: "medium",
  });
  assert.deepEqual(splitAgyModelId("gemini-3.1-pro-high"), {
    family: "gemini-3.1-pro",
    effort: "high",
  });
});

it("splitAgyModelId returns null for a bare family and for a non-effort suffix", () => {
  assert.equal(splitAgyModelId("gemini-3.8-flash"), null);
  assert.equal(splitAgyModelId("gemini-3.1-pro"), null);
  // The E2-1 retired id: "preview" is not an effort.
  assert.equal(splitAgyModelId("gemini-3.1-pro-preview"), null);
});

// ─── 2. resolveAgyInvocation — accepted cases ────────────────────────────

const ACCEPT_CASES = [
  {
    label: "nothing given → the default pin",
    input: {},
    model_id: EXPECTED_AGY_PIN,
    effort: "medium",
  },
  {
    label: "suffixed id alone → that id, effort from the suffix",
    input: { model: "gemini-3.7-flash-low" },
    model_id: "gemini-3.7-flash-low",
    effort: "low",
  },
  {
    label: "suffixed id + matching effort → accepted",
    input: { model: "gemini-3.8-flash-high", reasoning_effort: "high" },
    model_id: "gemini-3.8-flash-high",
    effort: "high",
  },
  {
    label: "bare family + effort → <family>-<effort>",
    input: { model: "gemini-3.7-flash", reasoning_effort: "high" },
    model_id: "gemini-3.7-flash-high",
    effort: "high",
  },
  {
    label: "bare pro family + low → gemini-3.1-pro-low",
    input: { model: "gemini-3.1-pro", reasoning_effort: "low" },
    model_id: "gemini-3.1-pro-low",
    effort: "low",
  },
  {
    label: "bare flash family alone → <family>-medium",
    input: { model: "gemini-3.8-flash" },
    model_id: "gemini-3.8-flash-medium",
    effort: "medium",
  },
  {
    label: "effort alone → default family at that effort",
    input: { reasoning_effort: "low" },
    model_id: "gemini-3.8-flash-low",
    effort: "low",
  },
];

for (const c of ACCEPT_CASES) {
  it(`resolveAgyInvocation: ${c.label}`, () => {
    const got = resolveAgyInvocation(c.input);
    assert.deepEqual(got, { model_id: c.model_id, effort: c.effort });
    assert.ok(
      JUDGE_MODEL_POLICY.agy.allowed_models.includes(got.model_id),
      "resolver must always return an allow-listed suffixed id",
    );
  });
}

// ─── 2b. resolveAgyInvocation — rejected cases ───────────────────────────

const REJECT_CASES = [
  {
    label: "suffixed id + conflicting effort names both",
    input: { model: "gemini-3.8-flash-medium", reasoning_effort: "high" },
    match: /gemini-3\.8-flash-medium[\s\S]*high|high[\s\S]*gemini-3\.8-flash-medium/,
  },
  {
    label: "bare pro family alone → no gemini-3.1-pro-medium is served",
    input: { model: "gemini-3.1-pro" },
    match: /gemini-3\.1-pro-high/,
  },
  {
    label: "bare family + unserved effort lists that family's suffixes",
    input: { model: "gemini-3.1-pro", reasoning_effort: "medium" },
    match: /gemini-3\.1-pro-low/,
  },
  {
    label: "retired id gemini-3.1-pro-preview is rejected",
    input: { model: "gemini-3.1-pro-preview" },
    match: /not served/,
  },
  {
    label: "unknown family is rejected with the allow-list",
    input: { model: "gemini-9.9-turbo" },
    match: /allowed agy models/,
  },
  {
    label: "unserved suffixed id is rejected with the allow-list",
    input: { model: "gemini-3.6-flash-medium" },
    match: /allowed agy models/,
  },
  {
    label: "xhigh is not an agy effort",
    input: { model: "gemini-3.8-flash", reasoning_effort: "xhigh" },
    match: /allowed agy efforts/,
  },
];

for (const c of REJECT_CASES) {
  it(`resolveAgyInvocation rejects: ${c.label}`, () => {
    assert.throws(() => resolveAgyInvocation(c.input), c.match);
  });
}

// ─── 3. resolveJudgeSelection ────────────────────────────────────────────

it("resolveJudgeSelection: codex with no hints → the JUDGE-1 default", () => {
  assert.deepEqual(resolveJudgeSelection({ producer: "codex" }), {
    model: JUDGE_MODEL_POLICY.codex.default.model,
    reasoning_effort: JUDGE_MODEL_POLICY.codex.default.reasoning_effort,
    source: "default",
  });
});

it("resolveJudgeSelection: escalate:true → the escalated pin, source escalated, no reason required", () => {
  assert.deepEqual(resolveJudgeSelection({ producer: "codex", escalate: true }), {
    model: JUDGE_MODEL_POLICY.codex.escalated.model,
    reasoning_effort: JUDGE_MODEL_POLICY.codex.escalated.reasoning_effort,
    source: "escalated",
  });
  assert.deepEqual(resolveJudgeSelection({ producer: "agy", escalate: true }), {
    model: JUDGE_MODEL_POLICY.agy.escalated.model,
    reasoning_effort: JUDGE_MODEL_POLICY.agy.escalated.reasoning_effort,
    source: "escalated",
  });
});

it("resolveJudgeSelection: model + escalate:true is ambiguous", () => {
  assert.throws(
    () => resolveJudgeSelection({ producer: "codex", model: "gpt-5.6-luna", escalate: true }),
    /ambiguous/i,
  );
});

it("resolveJudgeSelection: non-allow-listed model throws and lists the allow-list", () => {
  assert.throws(
    () =>
      resolveJudgeSelection({
        producer: "codex",
        model: "gpt-5-bogus",
        override_source: "cli",
        override_reason: "operator asked",
      }),
    /allowed models/,
  );
});

it("resolveJudgeSelection: effort outside the vendor range throws", () => {
  assert.throws(
    () =>
      resolveJudgeSelection({
        producer: "codex",
        reasoning_effort: "extreme",
        override_source: "cli",
        override_reason: "operator asked",
      }),
    /allowed efforts/,
  );
});

it("resolveJudgeSelection: override without a reason throws", () => {
  assert.throws(
    () => resolveJudgeSelection({ producer: "codex", model: "gpt-5.6-luna", override_source: "cli" }),
    /override requires override_source and override_reason/,
  );
});

it("resolveJudgeSelection: override with an unrecognized source throws", () => {
  assert.throws(
    () =>
      resolveJudgeSelection({
        producer: "codex",
        model: "gpt-5.6-luna",
        override_source: "vibes",
        override_reason: "felt right",
      }),
    /override requires override_source and override_reason/,
  );
});

it("resolveJudgeSelection: codex explicit gpt-5.6-luna with source cli + reason is accepted", () => {
  assert.deepEqual(
    resolveJudgeSelection({
      producer: "codex",
      model: "gpt-5.6-luna",
      override_source: "cli",
      override_reason: "A/B-ing the generator model as a judge on a scratch run",
    }),
    { model: "gpt-5.6-luna", reasoning_effort: "medium", source: "cli" },
  );
});

it("resolveJudgeSelection: explicitly restating the default needs no override", () => {
  assert.deepEqual(
    resolveJudgeSelection({ producer: "codex", model: JUDGE_MODEL_POLICY.codex.default.model }),
    {
      model: JUDGE_MODEL_POLICY.codex.default.model,
      reasoning_effort: JUDGE_MODEL_POLICY.codex.default.reasoning_effort,
      source: "default",
    },
  );
});

it("resolveJudgeSelection: agy canonicalizes a bare family through the agy resolver", () => {
  assert.deepEqual(
    resolveJudgeSelection({
      producer: "agy",
      model: "gemini-3.7-flash",
      reasoning_effort: "high",
      override_source: "team_yaml",
      override_reason: "deep-reasoning-team pins the 3.7 lane at high effort",
    }),
    { model: "gemini-3.7-flash-high", reasoning_effort: "high", source: "team_yaml" },
  );
});

it("resolveJudgeSelection: agy conflicting suffix + effort throws", () => {
  assert.throws(
    () =>
      resolveJudgeSelection({
        producer: "agy",
        model: "gemini-3.8-flash-low",
        reasoning_effort: "high",
        override_source: "hydra",
        override_reason: "envelope requested high",
      }),
    /conflict/i,
  );
});

it('resolveJudgeSelection: legacy producer "gemini" resolves like agy', () => {
  assert.deepEqual(resolveJudgeSelection({ producer: "gemini" }), {
    model: JUDGE_MODEL_POLICY.agy.default.model,
    reasoning_effort: JUDGE_MODEL_POLICY.agy.default.reasoning_effort,
    source: "default",
  });
});

it('resolveJudgeSelection: producer "claude" has no judge policy and throws', () => {
  assert.throws(() => resolveJudgeSelection({ producer: "claude" }), /no judge model policy/);
  assert.throws(() => resolveJudgeSelection({ producer: "copilot" }), /no judge model policy/);
  assert.throws(() => resolveJudgeSelection({ producer: "nonsense" }), /no judge model policy/);
});

it("judgePolicyFor / isAllowedJudgeModel agree with the policy table", () => {
  assert.equal(judgePolicyFor("codex"), JUDGE_MODEL_POLICY.codex);
  assert.equal(judgePolicyFor("agy"), JUDGE_MODEL_POLICY.agy);
  assert.equal(judgePolicyFor("gemini"), JUDGE_MODEL_POLICY.agy);
  assert.equal(judgePolicyFor("claude"), null);
  assert.equal(isAllowedJudgeModel("agy", EXPECTED_AGY_PIN), true);
  assert.equal(isAllowedJudgeModel("agy", "gemini-3.1-pro-preview"), false);
  assert.equal(isAllowedJudgeModel("claude", "claude-opus-5"), false);
});

// ─── 4. prices() merges bundled rates missing on disk ────────────────────

const { prices, computeCost } = await importDist("util/prices.js");

it("prices() merges a bundled model absent from the operator's on-disk table", () => {
  const table = prices();
  assert.ok(table.google, "google vendor table present");
  assert.ok(table.google[EXPECTED_AGY_PIN], `${EXPECTED_AGY_PIN} merged in from the bundle`);
});

it(`computeCost(${EXPECTED_AGY_PIN}) is non-zero despite a stale on-disk prices.json`, () => {
  assert.ok(
    computeCost(EXPECTED_AGY_PIN, 1e6, 1e6) > 0,
    "a newly pinned model must never silently price at 0",
  );
});

it("prices() never overwrites an operator-edited on-disk rate", () => {
  const table = prices();
  assert.equal(table.openai["gpt-5.6-terra"].input, 999.0, "operator rate survives the merge");
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
