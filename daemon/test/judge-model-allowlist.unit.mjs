// J4 — recordVerdict judge allow-list + override provenance.
//
// Asserts, against a temp SQLite DB (no daemon, no MCP peer, no subprocess):
//   1. Every id in JUDGE_MODEL_POLICY.codex.allowed_models is accepted, with
//      the matching judge_model_source (default for the default pin,
//      escalated for the escalated pin, cli + reason for the rest).
//   2. Same for JUDGE_MODEL_POLICY.agy.allowed_models.
//   3. The historical gemini-3.7-flash-medium pin is still recordable via the
//      cli override channel (it stayed on the allow-list precisely so E2-1-era
//      rows and a deliberate rollback remain expressible).
//   4. A bogus id is rejected per producer.
//   5. judge_producer="gemini" (the legacy alias) cannot record an arbitrary
//      model — it is held to agy's allow-list via normalizeProducer.
//   6. Identical agy generator/judge model ids are REJECTED (the old
//      `att.producer !== "agy"` exemption is gone).
//   7. Identical codex generator/judge ids are rejected (unchanged behavior,
//      asserted so the rewrite of the guard didn't drop it).
//   8. source=cli with no reason (and with a too-short reason) is rejected.
//   9. source="default" with a non-default model is rejected.
//  10. Effort outside the vendor's allowed_efforts is rejected.
//  11. effort/source/reason are persisted on the row AND returned.
//
// DE-HARDCODING: allow-listed ids are read from ../dist/config.js. The only
// retained literals are ids that must always be REJECTED (bogus) and the
// historical 3.7 id, which is asserted BY NAME on purpose — deriving it would
// make criterion 3 tautological.

import { strict as assert } from "node:assert";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DIST = join(__dirname, "..", "dist");

const SUITE_DIR = mkdtempSync(join(tmpdir(), "pp-judge-allowlist-"));
mkdirSync(join(SUITE_DIR, ".pair-programmer"), { recursive: true });
process.env.PP_HOME = SUITE_DIR;
process.env.EIGHTS_SKIP_AUDIT_CHECK = "1";

const { JUDGE_MODEL_POLICY, CLAUDE_TIER_MODELS } = await import(
  pathToFileURL(join(DIST, "config.js")).href
);
const runs = await import(pathToFileURL(join(DIST, "orchestrator", "runs.js")).href);
const { db } = await import(pathToFileURL(join(DIST, "db", "database.js")).href);

const GENERATOR_MODEL = CLAUDE_TIER_MODELS.sonnet;
const HISTORICAL_AGY_PIN = "gemini-3.7-flash-medium";
const REASON = "operator pinned this judge for the J4 allow-list regression test";
const CRITIQUE =
  "Reviewed the diff against the rubric. All dimensions scored; no fabricated " +
  "citations; the allow-list path is exercised end to end by this fixture.";

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

// One run + one stage for the whole file; each assertion gets its OWN attempt
// so verdicts never collide. ensureRun git-inits a project directory, which is
// the expensive part on Windows — doing it ~25 times pushed this file past the
// 60s default test timeout for no added coverage.
const PROJECT = mkdtempSync(join(tmpdir(), "pp-jal-"));
mkdirSync(join(PROJECT, ".harness"), { recursive: true });
writeFileSync(join(PROJECT, "AGENTS.md"), "# AGENTS\n", "utf8");
const SHARED_RUN = await runs.ensureRun({
  request_text: "judge allow-list fixture",
  project_path: PROJECT,
  mode: "single",
});
const SHARED_STAGE = await runs.startStage({
  run_id: SHARED_RUN.run_id,
  kind: "code",
  gate_type: "code",
});

/** A fresh attempt on the shared stage. */
async function newAttempt(producer = "claude", modelId = GENERATOR_MODEL) {
  const att = runs.recordAttempt({
    stage_id: SHARED_STAGE.stage_id,
    producer,
    model_id: modelId,
    status: "ok",
  });
  return att.attempt_id;
}

function sourceFor(policy, modelId) {
  if (modelId === policy.default.model) return { judge_model_source: "default" };
  if (modelId === policy.escalated.model) return { judge_model_source: "escalated" };
  return { judge_model_source: "cli", judge_override_reason: REASON };
}

// ─── 1 & 2. Every allow-listed id is accepted, per producer ──────────────

for (const [producer, policy] of [["codex", JUDGE_MODEL_POLICY.codex], ["agy", JUDGE_MODEL_POLICY.agy]]) {
  for (const modelId of policy.allowed_models) {
    const attemptId = await newAttempt();
    it(`recordVerdict accepts allow-listed ${producer} judge_model_id=${modelId}`, () => {
      const v = runs.recordVerdict({
        attempt_id: attemptId,
        judge_producer: producer,
        judge_model_id: modelId,
        outcome: "pass",
        critique_md: CRITIQUE,
        score_json: { correctness: 0.9 },
        ...sourceFor(policy, modelId),
      });
      assert.ok(v.verdict_id, "verdict_id should be set");
      assert.equal(v.cross_vendor, true, "claude generator + non-claude judge is cross-vendor");
    });
  }
}

// ─── 3. Historical agy pin remains recordable ────────────────────────────

it(`${HISTORICAL_AGY_PIN} is still on the agy allow-list`, () => {
  assert.ok(
    JUDGE_MODEL_POLICY.agy.allowed_models.includes(HISTORICAL_AGY_PIN),
    "the E2-1-era agy pin must stay expressible so historical rows and a rollback are recordable",
  );
});

{
  const attemptId = await newAttempt();
  it(`recordVerdict accepts the historical ${HISTORICAL_AGY_PIN} via source=cli + reason`, () => {
    const v = runs.recordVerdict({
      attempt_id: attemptId,
      judge_producer: "agy",
      judge_model_id: HISTORICAL_AGY_PIN,
      outcome: "pass",
      critique_md: CRITIQUE,
      score_json: { correctness: 0.9 },
      judge_model_source: "cli",
      judge_override_reason: REASON,
    });
    assert.ok(v.verdict_id);
    assert.equal(v.judge_model_source, "cli");
  });
}

// ─── 4. Bogus ids rejected per producer ──────────────────────────────────

for (const [producer, bogus] of [["codex", "gpt-5-bogus"], ["agy", "gemini-9.9-imaginary"]]) {
  const attemptId = await newAttempt();
  it(`recordVerdict rejects bogus ${producer} judge_model_id=${bogus}`, () => {
    assert.throws(
      () => runs.recordVerdict({
        attempt_id: attemptId,
        judge_producer: producer,
        judge_model_id: bogus,
        outcome: "pass",
        critique_md: CRITIQUE,
        score_json: { correctness: 0.9 },
        judge_model_source: "cli",
        judge_override_reason: REASON,
      }),
      (err) => /JUDGE_MODEL_POLICY allow-list/.test(err.message),
      "a non-allow-listed model must be rejected",
    );
  });
}

// ─── 5. Legacy "gemini" alias cannot smuggle an arbitrary model ──────────

{
  const attemptId = await newAttempt();
  it('judge_producer="gemini" cannot record an arbitrary model (alias is held to the agy allow-list)', () => {
    assert.throws(
      () => runs.recordVerdict({
        attempt_id: attemptId,
        judge_producer: "gemini",
        judge_model_id: "gemini-1.0-anything-goes",
        outcome: "pass",
        critique_md: CRITIQUE,
        score_json: { correctness: 0.9 },
        judge_model_source: "cli",
        judge_override_reason: REASON,
      }),
      (err) => /JUDGE_MODEL_POLICY allow-list/.test(err.message),
      'the "gemini" alias must not bypass the agy allow-list',
    );
  });
}

{
  const attemptId = await newAttempt();
  it('judge_producer="gemini" with an allow-listed agy id is accepted', () => {
    const v = runs.recordVerdict({
      attempt_id: attemptId,
      judge_producer: "gemini",
      judge_model_id: JUDGE_MODEL_POLICY.agy.default.model,
      outcome: "pass",
      critique_md: CRITIQUE,
      score_json: { correctness: 0.9 },
    });
    assert.ok(v.verdict_id);
  });
}

// ─── 6. Removed agy same-model exemption ─────────────────────────────────

{
  const agyDefault = JUDGE_MODEL_POLICY.agy.default.model;
  const attemptId = await newAttempt("agy", agyDefault);
  it("recordVerdict REJECTS identical agy generator/judge model ids (exemption removed)", () => {
    assert.throws(
      () => runs.recordVerdict({
        attempt_id: attemptId,
        judge_producer: "agy",
        judge_model_id: agyDefault,
        outcome: "pass",
        critique_md: CRITIQUE,
        score_json: { correctness: 0.9 },
      }),
      (err) => /same-vendor verdict requires different model ids/.test(err.message),
      "agy self-judging on an identical model id must no longer be exempt",
    );
  });
}

{
  // The alias must not evade the guard by spelling the producer differently
  // from the attempt's recorded producer.
  const agyDefault = JUDGE_MODEL_POLICY.agy.default.model;
  const attemptId = await newAttempt("gemini", agyDefault);
  it('same-model guard normalizes BOTH sides ("gemini" attempt vs "agy" judge)', () => {
    assert.throws(
      () => runs.recordVerdict({
        attempt_id: attemptId,
        judge_producer: "agy",
        judge_model_id: agyDefault,
        outcome: "pass",
        critique_md: CRITIQUE,
        score_json: { correctness: 0.9 },
      }),
      (err) => /same-vendor verdict requires different model ids/.test(err.message),
    );
  });
}

{
  // A DIFFERENT agy id on both sides is fine — this is what makes removing the
  // exemption tenable at all (agy now has a distinct escalated lane).
  const attemptId = await newAttempt("agy", JUDGE_MODEL_POLICY.agy.default.model);
  it("agy generator + agy judge on DIFFERENT allow-listed ids is accepted", () => {
    const v = runs.recordVerdict({
      attempt_id: attemptId,
      judge_producer: "agy",
      judge_model_id: JUDGE_MODEL_POLICY.agy.escalated.model,
      outcome: "pass",
      critique_md: CRITIQUE,
      score_json: { correctness: 0.9 },
      judge_model_source: "escalated",
    });
    assert.ok(v.verdict_id);
    assert.equal(v.cross_vendor, false, "agy judging agy is same-vendor");
  });
}

// ─── 7. Identical codex ids still rejected ───────────────────────────────

{
  const codexDefault = JUDGE_MODEL_POLICY.codex.default.model;
  const attemptId = await newAttempt("codex", codexDefault);
  it("recordVerdict rejects identical codex generator/judge model ids", () => {
    assert.throws(
      () => runs.recordVerdict({
        attempt_id: attemptId,
        judge_producer: "codex",
        judge_model_id: codexDefault,
        outcome: "pass",
        critique_md: CRITIQUE,
        score_json: { correctness: 0.9 },
      }),
      (err) => /same-vendor verdict requires different model ids/.test(err.message),
    );
  });
}

// ─── 8. Override channels require a reason ───────────────────────────────

for (const source of ["cli", "team_yaml", "hydra"]) {
  const attemptId = await newAttempt();
  it(`recordVerdict rejects judge_model_source="${source}" with no judge_override_reason`, () => {
    assert.throws(
      () => runs.recordVerdict({
        attempt_id: attemptId,
        judge_producer: "codex",
        judge_model_id: "gpt-5.6-luna",
        outcome: "pass",
        critique_md: CRITIQUE,
        score_json: { correctness: 0.9 },
        judge_model_source: source,
      }),
      (err) => /requires\s+judge_override_reason/.test(err.message),
    );
  });
}

{
  const attemptId = await newAttempt();
  it("recordVerdict rejects a too-short judge_override_reason (< 8 chars)", () => {
    assert.throws(
      () => runs.recordVerdict({
        attempt_id: attemptId,
        judge_producer: "codex",
        judge_model_id: "gpt-5.6-luna",
        outcome: "pass",
        critique_md: CRITIQUE,
        score_json: { correctness: 0.9 },
        judge_model_source: "cli",
        judge_override_reason: "  why  ",
      }),
      (err) => /requires\s+judge_override_reason/.test(err.message),
    );
  });
}

// ─── 9. source="default"/"escalated" must match the vendor pin ───────────

{
  const attemptId = await newAttempt();
  it('recordVerdict rejects judge_model_source="default" with a non-default model', () => {
    assert.throws(
      () => runs.recordVerdict({
        attempt_id: attemptId,
        judge_producer: "codex",
        judge_model_id: JUDGE_MODEL_POLICY.codex.escalated.model,
        outcome: "pass",
        critique_md: CRITIQUE,
        score_json: { correctness: 0.9 },
        judge_model_source: "default",
      }),
      (err) => /pins\s+judge_model_id/.test(err.message),
    );
  });
}

{
  const attemptId = await newAttempt();
  it('recordVerdict rejects judge_model_source="escalated" with a non-escalated model', () => {
    assert.throws(
      () => runs.recordVerdict({
        attempt_id: attemptId,
        judge_producer: "codex",
        judge_model_id: JUDGE_MODEL_POLICY.codex.default.model,
        outcome: "pass",
        critique_md: CRITIQUE,
        score_json: { correctness: 0.9 },
        judge_model_source: "escalated",
      }),
      (err) => /pins\s+judge_model_id/.test(err.message),
    );
  });
}

// ─── 10. Effort must be within the vendor's allowed_efforts ──────────────

{
  const attemptId = await newAttempt();
  it("recordVerdict rejects a judge_reasoning_effort outside the vendor's allowed_efforts", () => {
    // xhigh is in the union vocabulary but NOT in agy's allowed_efforts.
    assert.ok(!JUDGE_MODEL_POLICY.agy.allowed_efforts.includes("xhigh"));
    assert.throws(
      () => runs.recordVerdict({
        attempt_id: attemptId,
        judge_producer: "agy",
        judge_model_id: JUDGE_MODEL_POLICY.agy.default.model,
        outcome: "pass",
        critique_md: CRITIQUE,
        score_json: { correctness: 0.9 },
        judge_reasoning_effort: "xhigh",
      }),
      (err) => /judge_reasoning_effort/.test(err.message),
    );
  });
}

// ─── 11. Provenance is persisted AND returned ────────────────────────────

{
  const attemptId = await newAttempt();
  it("effort / source / reason are returned by recordVerdict and persisted on the row", () => {
    const v = runs.recordVerdict({
      attempt_id: attemptId,
      judge_producer: "codex",
      judge_model_id: "gpt-5.6-luna",
      outcome: "pass",
      critique_md: CRITIQUE,
      score_json: { correctness: 0.9 },
      judge_reasoning_effort: "high",
      judge_model_source: "team_yaml",
      judge_override_reason: REASON,
    });
    assert.equal(v.judge_reasoning_effort, "high");
    assert.equal(v.judge_model_source, "team_yaml");
    assert.equal(v.judge_override_reason, REASON);

    const row = db()
      .prepare(
        "SELECT judge_reasoning_effort, judge_model_source, judge_override_reason " +
        "FROM verdicts WHERE id = ?",
      )
      .get(v.verdict_id);
    assert.equal(row.judge_reasoning_effort, "high");
    assert.equal(row.judge_model_source, "team_yaml");
    assert.equal(row.judge_override_reason, REASON);
  });
}

{
  const attemptId = await newAttempt();
  it('a verdict recorded with no provenance args defaults to source="default" with null effort/reason', () => {
    const v = runs.recordVerdict({
      attempt_id: attemptId,
      judge_producer: "codex",
      judge_model_id: JUDGE_MODEL_POLICY.codex.default.model,
      outcome: "pass",
      critique_md: CRITIQUE,
      score_json: { correctness: 0.9 },
    });
    assert.equal(v.judge_model_source, "default");
    assert.equal(v.judge_reasoning_effort, null);
    assert.equal(v.judge_override_reason, null);
  });
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
