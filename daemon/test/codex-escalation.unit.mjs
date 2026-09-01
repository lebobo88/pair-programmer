// Unit tests for the opt-in escalated Codex critique model in pp_codex.critique.
// Asserts:
//   1. DEFAULT_MODELS.codex_critique matches the constitutional JUDGE-1 pin.
//   2. DEFAULT_MODELS.codex_critique_escalated matches the escalation pin.
//   3. selectCritiqueModel(false) returns the default pin.
//   4. selectCritiqueModel(true) returns the escalated pin.
//   5. Caller-passed args.model is ignored — selection depends only on escalate.
//   6. recordVerdict accepts judge_model_id=<escalated pin>.
//   7. recordVerdict still rejects arbitrary (non-pinned) codex judge_model_id.
//   8. codexCritique e2e: escalate:true → invoked with the escalated pin (DI seam).
//   9. codexCritique e2e: escalate:false → invoked with the default pin (DI seam).
//  10. codexCritique e2e: escalate:false + args.model:"gpt-5-bogus" → still default.
// Items 1-5 are pure/offline. Items 6-7 exercise runs.recordVerdict against
// a temp SQLite DB — no subprocess, no MCP server. Items 8-10 use the _invoke
// DI seam to capture genArgs without spawning the Codex CLI.
//
// DE-HARDCODING POLICY (model-id refresh, 2026-08-22): every assertion below
// derives its expected model id from DEFAULT_MODELS / CLAUDE_TIER_MODELS in
// ../dist/config.js rather than duplicating the pin. The ONLY literals retained
// are (a) EXPECTED_JUDGE1_PIN / EXPECTED_ESCALATED_PIN below — the deliberate
// tripwire that catches a silent constitutional-pin drift, which a derived
// assertion would be tautologically blind to — and (b) "gpt-5-bogus", an id
// that must always be REJECTED and therefore must never track the config.

import { strict as assert } from "node:assert";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DIST = join(__dirname, "..", "dist");

// Set PP_HOME before any dist imports so the DB lands in a temp dir.
const SUITE_DIR = mkdtempSync(join(tmpdir(), "pp-codex-escalation-"));
mkdirSync(join(SUITE_DIR, ".pair-programmer"), { recursive: true });
process.env.PP_HOME = SUITE_DIR;
process.env.EIGHTS_SKIP_AUDIT_CHECK = "1";

const { DEFAULT_MODELS, CLAUDE_TIER_MODELS } = await import(
  pathToFileURL(join(DIST, "config.js")).href
);

// Tripwire literals — intentionally NOT derived. CONSTITUTION.md Article V (as
// amended, SHA 13b4fa18) pins JUDGE-1 to gpt-5.6-terra at medium reasoning
// effort; the escalated lane is gpt-5.6-sol. Changing DEFAULT_MODELS without a
// constitution amendment must break this file loudly, which a self-referential
// assertion could never do.
const EXPECTED_JUDGE1_PIN = "gpt-5.6-terra";
const EXPECTED_ESCALATED_PIN = "gpt-5.6-sol";
// Generator model for the recordVerdict fixtures — derived so a tier repin
// cannot silently desync the fixture from the shipped tier map.
const GENERATOR_MODEL = CLAUDE_TIER_MODELS.sonnet;
const { selectCritiqueModel, codexCritique } = await import(
  pathToFileURL(join(DIST, "mcp", "codex-server.js")).href
);

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

// ─── 1. Constitutional default unchanged ─────────────────────────────────

it(`DEFAULT_MODELS.codex_critique is ${EXPECTED_JUDGE1_PIN} (JUDGE-1 constitutional default)`, () => {
  assert.equal(
    DEFAULT_MODELS.codex_critique,
    EXPECTED_JUDGE1_PIN,
    "codex_critique default must not change without a HITL constitution amendment — JUDGE-1 pins it",
  );
});

// ─── 2. Escalation entry present ─────────────────────────────────────────

it(`DEFAULT_MODELS.codex_critique_escalated is ${EXPECTED_ESCALATED_PIN}`, () => {
  assert.equal(
    DEFAULT_MODELS.codex_critique_escalated,
    EXPECTED_ESCALATED_PIN,
    `escalated entry must point at ${EXPECTED_ESCALATED_PIN}`,
  );
});

// ─── 3. selectCritiqueModel without escalation → default ─────────────────

it("selectCritiqueModel(false) returns DEFAULT_MODELS.codex_critique", () => {
  assert.equal(selectCritiqueModel(false), DEFAULT_MODELS.codex_critique);
});

it("selectCritiqueModel(undefined-coerced-false) returns DEFAULT_MODELS.codex_critique", () => {
  // Simulates args.escalate being absent (falsy via ?? false in codexCritique).
  assert.equal(selectCritiqueModel(false), DEFAULT_MODELS.codex_critique);
});

// ─── 4. selectCritiqueModel with escalation → escalated pin ──────────────

it("selectCritiqueModel(true) returns DEFAULT_MODELS.codex_critique_escalated", () => {
  assert.equal(selectCritiqueModel(true), DEFAULT_MODELS.codex_critique_escalated);
});

// ─── 5. Caller-passed model is ignored — only escalate matters ────────────

it("model selection is determined solely by the escalate boolean, not a caller-passed model string", () => {
  // selectCritiqueModel takes exactly one boolean argument — it has no model
  // parameter. The invented-id guard in codexCritique (~line 310) drops
  // args.model before it can influence anything; selectCritiqueModel is the
  // sole path to the effective model.

  // escalate=false always yields the constitutional default.
  assert.equal(selectCritiqueModel(false), DEFAULT_MODELS.codex_critique);

  // escalate=true always yields the pinned escalation model.
  assert.equal(selectCritiqueModel(true), DEFAULT_MODELS.codex_critique_escalated);

  // The two pinned models are distinct — escalation is meaningful.
  assert.notEqual(
    DEFAULT_MODELS.codex_critique,
    DEFAULT_MODELS.codex_critique_escalated,
    "pinned default and pinned escalation must not be the same model",
  );

  // selectCritiqueModel accepts exactly one parameter (boolean). Any
  // caller-passed args.model string never reaches this function — it is
  // consumed by the warning branch in codexCritique and never forwarded.
  // TypeScript enforces this at compile time; confirm at runtime:
  assert.equal(selectCritiqueModel.length, 1, "selectCritiqueModel takes exactly 1 param (boolean)");
});

// ─── 6. recordVerdict accepts escalated-pin verdicts ─────────────────────

await itAsync("recordVerdict accepts judge_model_id=<escalated codex pin>", async () => {
  const project = mkdtempSync(join(tmpdir(), "pp-codex-esc-proj-"));
  mkdirSync(join(project, ".harness"), { recursive: true });
  writeFileSync(join(project, "AGENTS.md"), "# AGENTS\n", "utf8");

  const runs = await import(pathToFileURL(join(DIST, "orchestrator", "runs.js")).href);
  const run = await runs.ensureRun({ request_text: "escalation record test", project_path: project, mode: "single" });
  const stage = await runs.startStage({ run_id: run.run_id, kind: "code", gate_type: "security" });
  // Generator is Claude — Codex judge is cross-vendor.
  const att = runs.recordAttempt({
    stage_id: stage.stage_id,
    producer: "claude",
    model_id: GENERATOR_MODEL,
    status: "ok",
  });

  // Must NOT throw — this is the escalated pinned model.
  const verdict = runs.recordVerdict({
    attempt_id: att.attempt_id,
    judge_producer: "codex",
    judge_model_id: DEFAULT_MODELS.codex_critique_escalated,
    rubric_id: "owasp-asvs-l2@1",
    outcome: "pass",
    critique_md: "Escalated security gate review: all ASVS-L2 controls verified present. No credential leakage, injection surface contained, auth flows correctly scoped.",
    score_json: { correctness: 0.95, safety: 0.9 },
  });
  assert.ok(verdict.verdict_id, "verdict_id should be set");
  assert.equal(verdict.cross_vendor, true, "claude generator + codex judge = cross-vendor");
});

// ─── 7. recordVerdict still rejects arbitrary (non-pinned) codex model ids ─

await itAsync("recordVerdict rejects arbitrary (non-pinned) codex judge_model_id", async () => {
  const project = mkdtempSync(join(tmpdir(), "pp-codex-esc-proj2-"));
  mkdirSync(join(project, ".harness"), { recursive: true });
  writeFileSync(join(project, "AGENTS.md"), "# AGENTS\n", "utf8");

  const runs = await import(pathToFileURL(join(DIST, "orchestrator", "runs.js")).href);
  const run = await runs.ensureRun({ request_text: "rejection test", project_path: project, mode: "single" });
  const stage = await runs.startStage({ run_id: run.run_id, kind: "code", gate_type: "code" });
  const att = runs.recordAttempt({
    stage_id: stage.stage_id,
    producer: "claude",
    model_id: GENERATOR_MODEL,
    status: "ok",
  });

  assert.throws(
    () => runs.recordVerdict({
      attempt_id: att.attempt_id,
      judge_producer: "codex",
      judge_model_id: "gpt-5-bogus",
      outcome: "pass",
      critique_md: "This should be rejected — gpt-5-bogus is not a pinned codex critique model.",
      score_json: { correctness: 0.9 },
    }),
    (err) => /pinned to those models/i.test(err.message),
    "arbitrary model id must be rejected by recordVerdict",
  );
});

// ─── 8-10. codexCritique e2e via _invoke DI seam ─────────────────────────
//
// The _invoke seam (opts._invoke) intercepts the resolved genArgs that
// codexCritique would otherwise pass to the real codexGenerate. We capture
// genArgs.model and return a minimal valid CodexResult stub so codexCritique
// can complete without touching the filesystem or spawning a CLI process.
//
// We pass output_schema:{type:"object"} so useDefaultSchema=false and the
// result is returned directly (no stabilizeCritiqueResult retry loop).

const STUB_CWD = mkdtempSync(join(tmpdir(), "pp-codex-esc-cwd-"));

/** Minimal CodexResult-shaped stub that looks like a successful codex run. */
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

await itAsync("codexCritique e2e: escalate:true → invoked with the escalated pin", async () => {
  let capturedModel;
  await codexCritique(
    {
      artifact_text: "fn foo() {}",
      rubric_md: "check it",
      cwd: STUB_CWD,
      model: DEFAULT_MODELS.codex_critique, // caller-passed model — must be ignored
      escalate: true,
      output_schema: { type: "object" }, // skip stabilize path
    },
    {
      _invoke: async (genArgs) => {
        capturedModel = genArgs.model;
        return makeStubResult(genArgs.model);
      },
    },
  );
  assert.equal(
    capturedModel,
    DEFAULT_MODELS.codex_critique_escalated,
    "escalate:true must invoke with DEFAULT_MODELS.codex_critique_escalated",
  );
});

await itAsync("codexCritique e2e: escalate:false → invoked with the default pin", async () => {
  let capturedModel;
  await codexCritique(
    {
      artifact_text: "fn foo() {}",
      rubric_md: "check it",
      cwd: STUB_CWD,
      model: DEFAULT_MODELS.codex_critique_escalated, // caller-passed — must be ignored
      escalate: false,
      output_schema: { type: "object" },
    },
    {
      _invoke: async (genArgs) => {
        capturedModel = genArgs.model;
        return makeStubResult(genArgs.model);
      },
    },
  );
  assert.equal(
    capturedModel,
    DEFAULT_MODELS.codex_critique,
    "escalate:false must invoke with DEFAULT_MODELS.codex_critique",
  );
});

await itAsync("codexCritique e2e: escalate:false + args.model:gpt-5-bogus → still the default pin (arbitrary model ignored)", async () => {
  let capturedModel;
  await codexCritique(
    {
      artifact_text: "fn foo() {}",
      rubric_md: "check it",
      cwd: STUB_CWD,
      model: "gpt-5-bogus",       // invented id — must be dropped by invented-id guard
      escalate: false,
      output_schema: { type: "object" },
    },
    {
      _invoke: async (genArgs) => {
        capturedModel = genArgs.model;
        return makeStubResult(genArgs.model);
      },
    },
  );
  assert.equal(
    capturedModel,
    DEFAULT_MODELS.codex_critique,
    "arbitrary caller model must never reach the invoker — only escalate determines the model",
  );
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
