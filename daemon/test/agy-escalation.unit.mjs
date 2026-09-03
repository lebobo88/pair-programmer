// Unit tests for the agy (Antigravity) judge selection surface in
// pp_agy.critique — the mirror of codex-escalation.unit.mjs (issue #29, J5).
//
// Asserts:
//   1. DEFAULT_MODELS.agy_critique matches the pinned agy default.
//   2. DEFAULT_MODELS.agy_critique_escalated matches the escalated pin.
//   3. agyCritique e2e: no model, no escalate → the default pin at medium.
//   4. agyCritique e2e: escalate:true → the escalated pin at its pinned effort.
//   5. agyCritique e2e: an allow-listed override (source cli + reason) REACHES
//      genArgs.model — J5 replaced the old silent discard.
//   6. agyCritique e2e: a BARE family + reasoning_effort is canonicalized to the
//      served effort-suffixed id before it reaches genArgs.model.
//   7. agyCritique e2e: a suffixed id whose suffix contradicts reasoning_effort
//      THROWS (agy rejects suffixed-id + --effort at the CLI level).
//   8. agyCritique e2e: a non-served model ("gemini-9.9-bogus") THROWS.
//   9. agyCritique e2e: escalate:true together with model THROWS (ambiguous).
//  10. agyCritique e2e: override_source=cli with NO override_reason THROWS.
//  11. genArgs never carries an `--effort`-style separate flag request that
//      contradicts the model id: the resolved effort always matches the suffix.
//
// Every case runs through the `_invoke` DI seam added in J5
// (AgyCritiqueInternalOptions, antigravity-server.ts) so nothing spawns the agy
// CLI. Fully offline: no daemon, no MCP peer, no subprocess.
//
// DE-HARDCODING POLICY — same rationale as codex-escalation.unit.mjs:44-50.
// Every assertion derives its expected id from DEFAULT_MODELS /
// JUDGE_MODEL_POLICY in ../dist/config.js rather than duplicating the pin. The
// ONLY literals retained are (a) EXPECTED_AGY_PIN / EXPECTED_AGY_ESCALATED_PIN
// below — the deliberate tripwire that catches a silent pin drift, which a
// derived assertion would be tautologically blind to — and (b)
// "gemini-9.9-bogus", an id that must ALWAYS be rejected and therefore must
// never track the config.

import { strict as assert } from "node:assert";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync, mkdirSync } from "node:fs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DIST = join(__dirname, "..", "dist");

// Set PP_HOME before any dist imports so nothing touches the real state dir.
const SUITE_DIR = mkdtempSync(join(tmpdir(), "pp-agy-escalation-"));
mkdirSync(join(SUITE_DIR, ".pair-programmer"), { recursive: true });
process.env.PP_HOME = SUITE_DIR;
process.env.EIGHTS_SKIP_AUDIT_CHECK = "1";

const { DEFAULT_MODELS, JUDGE_MODEL_POLICY } = await import(
  pathToFileURL(join(DIST, "config.js")).href
);
const { agyCritique } = await import(
  pathToFileURL(join(DIST, "mcp", "antigravity-server.js")).href
);

// Tripwire literals — intentionally NOT derived, exactly as in
// codex-escalation.unit.mjs:44-50. A repin of the agy judge lane must break
// this file loudly; a self-referential assertion could never do that.
const EXPECTED_AGY_PIN = "gemini-3.8-flash-medium";
const EXPECTED_AGY_ESCALATED_PIN = "gemini-3.1-pro-high";

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

async function itAsync(label, fn) {
  try {
    await fn();
    passed++;
    console.log(`✓ ${label}`);
  } catch (err) {
    failed++;
    console.error(`✗ ${label}`);
    console.error(`  ${err.message}`);
  }
}

// ─── 1-2. Pins unchanged ─────────────────────────────────────────────────

it(`DEFAULT_MODELS.agy_critique is ${EXPECTED_AGY_PIN}`, () => {
  assert.equal(
    DEFAULT_MODELS.agy_critique,
    EXPECTED_AGY_PIN,
    "the agy judge default must not drift silently — repin in JUDGE_MODEL_POLICY deliberately",
  );
});

it(`DEFAULT_MODELS.agy_critique_escalated is ${EXPECTED_AGY_ESCALATED_PIN}`, () => {
  assert.equal(
    DEFAULT_MODELS.agy_critique_escalated,
    EXPECTED_AGY_ESCALATED_PIN,
    `the escalated agy lane must point at ${EXPECTED_AGY_ESCALATED_PIN}`,
  );
});

// ─── DI seam plumbing ────────────────────────────────────────────────────
//
// `_invoke` intercepts the genArgs agyCritique would otherwise hand to the real
// agyGenerate. output_schema:{type:"object"} makes useDefaultSchema=false so the
// stub result is returned directly (no stabilizeCritiqueResult retry loop).

const STUB_CWD = mkdtempSync(join(tmpdir(), "pp-agy-esc-cwd-"));

/** Minimal AntigravityResult-shaped stub that looks like a successful run. */
function makeStubResult(capturedModel) {
  return {
    text: JSON.stringify({ outcome: "pass", critique_md: "ok", score_entries: [] }),
    parsed: { outcome: "pass", critique_md: "ok", score_entries: [] },
    tokens_in: 0,
    tokens_out: 0,
    cost_usd: 0,
    model: capturedModel,
    wall_ms: 1,
    exit_code: 0,
  };
}

/** Run agyCritique through the DI seam and return the captured genArgs. */
async function captureGenArgs(critiqueArgs) {
  let captured;
  await agyCritique(
    {
      artifact_text: "fn foo() {}",
      rubric_md: "check it",
      cwd: STUB_CWD,
      output_schema: { type: "object" },
      ...critiqueArgs,
    },
    {
      _invoke: async (genArgs) => {
        captured = genArgs;
        return makeStubResult(genArgs.model);
      },
    },
  );
  return captured;
}

/** Split a served agy id into family + effort suffix (mirrors agy-model.ts). */
function splitId(id) {
  for (const suffix of ["low", "medium", "high", "xhigh"]) {
    if (id.endsWith(`-${suffix}`)) {
      return { family: id.slice(0, id.length - suffix.length - 1), effort: suffix };
    }
  }
  return null;
}

// An allow-listed NON-default agy id for the override case, derived so an
// allow-list edit cannot silently make the case vacuous.
const ALLOWED_OVERRIDE_MODEL = JUDGE_MODEL_POLICY.agy.allowed_models.find(
  (m) => m !== DEFAULT_MODELS.agy_critique && m !== DEFAULT_MODELS.agy_critique_escalated,
);

it("the override fixture model is allow-listed and distinct from both pins", () => {
  assert.ok(
    ALLOWED_OVERRIDE_MODEL,
    "JUDGE_MODEL_POLICY.agy.allowed_models must carry a third id for the override case to be meaningful",
  );
});

// ─── 3. Default lane ─────────────────────────────────────────────────────

await itAsync("agyCritique e2e: no model, no escalate → the default pin at its pinned effort", async () => {
  const genArgs = await captureGenArgs({});
  assert.equal(genArgs.model, DEFAULT_MODELS.agy_critique);
  assert.equal(genArgs.reasoning_effort, JUDGE_MODEL_POLICY.agy.default.reasoning_effort);
  assert.equal(genArgs.fresh_session, true, "a critique must stay a stateless adjudication");
  assert.equal(genArgs.skip_recap, true, "a critique must not inherit a project recap");
});

// ─── 4. Escalated lane ───────────────────────────────────────────────────

await itAsync("agyCritique e2e: escalate:true → the escalated pin", async () => {
  const genArgs = await captureGenArgs({ escalate: true });
  assert.equal(genArgs.model, DEFAULT_MODELS.agy_critique_escalated);
  assert.equal(genArgs.reasoning_effort, JUDGE_MODEL_POLICY.agy.escalated.reasoning_effort);
});

// ─── 5. Justified allow-listed override is HONORED ───────────────────────

await itAsync("agyCritique e2e: an allow-listed override with source+reason REACHES genArgs.model", async () => {
  const genArgs = await captureGenArgs({
    model: ALLOWED_OVERRIDE_MODEL,
    override_source: "cli",
    override_reason: "operator pinned a specific agy lane for this gate",
  });
  assert.equal(
    genArgs.model,
    ALLOWED_OVERRIDE_MODEL,
    "a justified allow-listed override must be honored, not silently replaced by the pin",
  );
});

// ─── 6. Bare family + effort is canonicalized ────────────────────────────

await itAsync("agyCritique e2e: a bare family + reasoning_effort canonicalizes to the served suffixed id", async () => {
  const defaultSplit = splitId(DEFAULT_MODELS.agy_critique);
  assert.ok(defaultSplit, "the agy default pin must be an effort-suffixed id");
  // Pick an effort for the default family that is served and NOT the default's
  // own suffix, so the canonicalization is observable.
  const target = JUDGE_MODEL_POLICY.agy.allowed_models.find((m) => {
    const sp = splitId(m);
    return sp && sp.family === defaultSplit.family && sp.effort !== defaultSplit.effort;
  });
  assert.ok(target, `family "${defaultSplit.family}" must serve a second effort for this case to bite`);
  const targetEffort = splitId(target).effort;

  const genArgs = await captureGenArgs({
    model: defaultSplit.family,          // BARE family — not itself a served id
    reasoning_effort: targetEffort,
    override_source: "cli",
    override_reason: "bare family plus effort must canonicalize, not fail",
  });
  assert.equal(
    genArgs.model,
    target,
    "the bare family + effort must be collapsed into the single served suffixed id",
  );
  assert.equal(genArgs.reasoning_effort, targetEffort);
  // agy rejects a suffixed id combined with --effort, so the canonical id is
  // the ONLY thing that may carry effort onto the command line.
  assert.ok(splitId(genArgs.model), "the resolved id must always be effort-suffixed");
  assert.equal(
    splitId(genArgs.model).effort,
    genArgs.reasoning_effort,
    "the resolved effort must equal the suffix encoded in the resolved id (item 11)",
  );
});

// ─── 7. Conflicting suffix + effort throws ───────────────────────────────

await itAsync("agyCritique e2e: a suffixed id contradicting reasoning_effort THROWS", async () => {
  const defaultSplit = splitId(DEFAULT_MODELS.agy_critique);
  const conflicting = JUDGE_MODEL_POLICY.agy.allowed_efforts.find((e) => e !== defaultSplit.effort);
  assert.ok(conflicting, "agy must serve more than one effort for this case to bite");
  await assert.rejects(
    () => captureGenArgs({
      model: DEFAULT_MODELS.agy_critique,   // encodes its own effort in the suffix
      reasoning_effort: conflicting,
      override_source: "cli",
      override_reason: "this conflict must be surfaced, not silently resolved",
    }),
    /conflict/i,
    "a suffixed id plus a contradicting effort is a hard agy CLI error and must be rejected here",
  );
});

// ─── 8. Non-served model throws ──────────────────────────────────────────

await itAsync("agyCritique e2e: a non-served model (gemini-9.9-bogus) THROWS", async () => {
  // Pre-J5 this was silently discarded and the pin used, hiding the driver bug
  // that produced the invented id. agy itself rejects unknown ids outright
  // (exit 1, "invalid model selection"), so failing early is strictly better.
  await assert.rejects(
    () => captureGenArgs({
      model: "gemini-9.9-bogus",
      override_source: "cli",
      override_reason: "even a justified override cannot name an unserved model",
    }),
    /is not served/i,
    "an invented model id must be rejected, not ignored",
  );
});

// ─── 9. model + escalate is ambiguous ────────────────────────────────────

await itAsync("agyCritique e2e: escalate:true together with model THROWS (ambiguous)", async () => {
  await assert.rejects(
    () => captureGenArgs({ model: ALLOWED_OVERRIDE_MODEL, escalate: true }),
    /ambiguous judge selection/i,
    "model + escalate is an unresolvable request and must be rejected",
  );
});

// ─── 10. Override without a reason throws ────────────────────────────────

await itAsync("agyCritique e2e: override_source=cli with NO override_reason THROWS", async () => {
  await assert.rejects(
    () => captureGenArgs({ model: ALLOWED_OVERRIDE_MODEL, override_source: "cli" }),
    /override requires override_source and override_reason/i,
    "deviating from the pin without a reason must be rejected",
  );
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
