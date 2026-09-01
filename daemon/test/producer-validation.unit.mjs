/**
 * producer-validation.unit.mjs
 *
 * Regression suite for the cross-vendor provenance gate.
 *
 * The defect: `attempts.producer` was a free-form string (schema.sql even
 * documented "<subagent name>" as legal), but recordVerdict computes
 * cross_vendor by comparing vendorFor(attempt.producer) against
 * vendorFor(judge_producer) -- and vendorFor returns null for anything outside
 * PRODUCERS. A role string such as "tests_pre-generator" therefore resolved to
 * null and silently collapsed cross_vendor to FALSE on every verdict, so a
 * required_cross_vendor gate was satisfiable by nothing. Nothing errored.
 *
 * The fix is fail-closed at three layers, each pinned below:
 *   1. ProducerSchema  -- the MCP input boundary (record_attempt/record_verdict)
 *   2. assertProducer  -- recordAttempt, for callers that bypass the MCP schema
 *   3. recordVerdict   -- refuses an attempt row whose producer maps to no
 *                         vendor (covers rows written BEFORE the fix)
 *
 * Anti-stall contract: temp sqlite via PP_HOME, direct dist imports, no live
 * daemon, no MCP peer.
 *   Run: node --test --test-timeout=60000 test/producer-validation.unit.mjs
 */

import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import assert from "node:assert/strict";
import { describe, it, before } from "node:test";

// PP_HOME must be set BEFORE any dist import so the DB is isolated.
const SUITE_DIR = mkdtempSync(join(tmpdir(), "pp-producer-validation-"));
mkdirSync(join(SUITE_DIR, ".pair-programmer"), { recursive: true });
process.env.PP_HOME = SUITE_DIR;
process.env.EIGHTS_SKIP_AUDIT_CHECK = "1";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DIST = join(__dirname, "..", "dist");
const importDist = (rel) => import(pathToFileURL(join(DIST, rel)).href);

const PROJECT = mkdtempSync(join(tmpdir(), "pp-pv-project-"));
mkdirSync(join(PROJECT, ".harness"), { recursive: true });
writeFileSync(join(PROJECT, "AGENTS.md"), "# AGENTS", "utf8");

let config, runs, db;

before(async () => {
  config = await importDist("config.js");
  runs = await importDist("orchestrator/runs.js");
  db = (await importDist("db/database.js")).db;
});

const rid = (p) => `${p}_${Math.random().toString(36).slice(2, 12)}`;

function insertRun() {
  const id = rid("run_pv");
  db().prepare(
    `INSERT INTO runs(id, project_path, request_text, mode, status, started_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(id, PROJECT, "producer-validation test", "single", "running", new Date().toISOString());
  return id;
}

function insertStage(run_id, kind = "code") {
  const id = rid("stage_pv");
  db().prepare(
    `INSERT INTO stages(id, run_id, kind, gate_type, status, started_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(id, run_id, kind, kind, "running", new Date().toISOString());
  return id;
}

/** Insert an attempt via raw SQL, bypassing every guard -- simulates a pre-fix row. */
function insertRawAttempt(stage_id, producer, model_id = "claude-sonnet-5") {
  const id = rid("attempt_pv");
  db().prepare(
    `INSERT INTO attempts(id, stage_id, producer, model_id, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(id, stage_id, producer, model_id, "ok", new Date().toISOString());
  return id;
}

// The exact shapes observed in the run that surfaced this defect.
const ROLE_STRINGS = ["tests_pre-generator", "tests", "engineer", "spec-author", "general-purpose"];

// --- Layer 1: ProducerSchema (the MCP input boundary) ----------------------

describe("ProducerSchema", () => {
  it("accepts every current vendor id", () => {
    for (const p of config.PRODUCERS) {
      assert.equal(config.ProducerSchema.safeParse(p).success, true, `should accept ${p}`);
    }
  });

  it("accepts the legacy gemini alias so historical rows stay writable", () => {
    // normalizeProducer maps gemini -> agy; rejecting it would break replay of
    // runs recorded before the Gemini CLI -> Antigravity rename.
    assert.equal(config.ProducerSchema.safeParse("gemini").success, true);
  });

  it("rejects sub-agent role strings (the regression)", () => {
    for (const role of ROLE_STRINGS) {
      assert.equal(config.ProducerSchema.safeParse(role).success, false, `should reject ${role}`);
    }
  });

  it("rejection message names agent_type as the correct field", () => {
    // The message is the whole remediation path for whoever hits this, so its
    // content is part of the contract, not incidental.
    const res = config.ProducerSchema.safeParse("tests_pre-generator");
    assert.equal(res.success, false);
    const msg = res.error.issues[0].message;
    assert.match(msg, /agent_type/);
    assert.match(msg, /tests_pre-generator/);
  });

  it("rejects the empty string", () => {
    assert.equal(config.ProducerSchema.safeParse("").success, false);
  });
});

// --- vendorFor: the primitive the whole gate rests on ----------------------

describe("vendorFor", () => {
  it("maps every accepted producer to a non-null vendor", () => {
    // If this ever regresses, cross_vendor silently goes false again.
    for (const p of [...config.PRODUCERS, "gemini"]) {
      assert.notEqual(config.vendorFor(p), null, `${p} must resolve to a vendor`);
    }
  });

  it("returns null for role strings -- why they must never be stored", () => {
    for (const role of ROLE_STRINGS) assert.equal(config.vendorFor(role), null);
  });
});

// --- Layer 2: assertProducer / recordAttempt (domain boundary) -------------

describe("assertProducer", () => {
  it("throws on a role string and passes on a vendor id", () => {
    assert.throws(() => config.assertProducer("tests_pre-generator"), /agent_type/);
    assert.doesNotThrow(() => config.assertProducer("claude"));
  });
});

describe("recordAttempt", () => {
  it("rejects a role string at the domain boundary, not just via MCP", () => {
    // recordAttempt is exported and reachable without the MCP schema, so the
    // guard has to live here too or the boundary has a hole.
    const stage_id = insertStage(insertRun());
    assert.throws(
      () => runs.recordAttempt({ stage_id, producer: "tests_pre-generator", model_id: "claude-sonnet-5" }),
      /agent_type/,
    );
  });

  it("accepts a valid vendor producer", () => {
    const stage_id = insertStage(insertRun());
    const out = runs.recordAttempt({ stage_id, producer: "claude", model_id: "claude-sonnet-5" });
    assert.ok(out.attempt_id);
  });

  it("writes nothing when it rejects", () => {
    // A rejected call must not leave a partial row behind.
    const stage_id = insertStage(insertRun());
    assert.throws(() => runs.recordAttempt({ stage_id, producer: "tests", model_id: "x" }));
    const n = db().prepare(`SELECT COUNT(*) AS c FROM attempts WHERE stage_id = ?`).get(stage_id).c;
    assert.equal(n, 0);
  });
});

// --- Layer 3: recordVerdict (covers rows written BEFORE the fix) -----------

describe("recordVerdict cross_vendor provenance", () => {
  it("refuses a verdict on a pre-fix attempt whose producer maps to no vendor", () => {
    // THE regression. Before the fix this returned cross_vendor:false silently.
    const stage_id = insertStage(insertRun());
    const attempt_id = insertRawAttempt(stage_id, "tests_pre-generator");
    assert.throws(
      () => runs.recordVerdict({
        attempt_id,
        judge_producer: "codex",
        judge_model_id: config.DEFAULT_MODELS.codex_critique,
        outcome: "pass",
      }),
      /maps to no vendor/,
    );
  });

  it("records no verdict row when it refuses", () => {
    const stage_id = insertStage(insertRun());
    const attempt_id = insertRawAttempt(stage_id, "tests");
    assert.throws(() => runs.recordVerdict({
      attempt_id,
      judge_producer: "codex",
      judge_model_id: config.DEFAULT_MODELS.codex_critique,
      outcome: "pass",
    }));
    const n = db().prepare(`SELECT COUNT(*) AS c FROM verdicts WHERE attempt_id = ?`).get(attempt_id).c;
    assert.equal(n, 0);
  });

  it("computes cross_vendor=true for claude generator + codex judge", () => {
    // The property the gate exists to prove -- anthropic vs openai.
    const stage_id = insertStage(insertRun());
    const attempt_id = insertRawAttempt(stage_id, "claude");
    const out = runs.recordVerdict({
      attempt_id,
      judge_producer: "codex",
      judge_model_id: config.DEFAULT_MODELS.codex_critique,
      outcome: "pass",
    });
    assert.equal(out.cross_vendor, true);
  });

  it("computes cross_vendor=false for a genuine same-vendor pair", () => {
    // A different Claude model judging a Claude attempt is same-vendor: false
    // here is CORRECT, and must stay distinguishable from the silent false the
    // role-string bug produced.
    const stage_id = insertStage(insertRun());
    const attempt_id = insertRawAttempt(stage_id, "claude", "claude-sonnet-5");
    const out = runs.recordVerdict({
      attempt_id,
      judge_producer: "claude",
      judge_model_id: "claude-opus-5",
      outcome: "pass",
    });
    assert.equal(out.cross_vendor, false);
  });
});
