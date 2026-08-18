// Unit tests for two fixes reviewed together:
//
// P2 (database.ts txImmediateWithRetry): app-level retry on genuine SQLite
// lock contention only, bounded by both maxAttempts and an explicit
// maxWallMs wall-clock backstop, and never retrying a constraint error.
//
// P3 (runs.ts recordVerdict idempotency_token): a retried record_verdict
// call carrying a previously-seen idempotency_token is a no-op that
// returns the original verdict rather than inserting a duplicate row.

import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import assert from "node:assert/strict";

const SUITE_DIR = mkdtempSync(join(tmpdir(), "pp-retry-idem-"));
mkdirSync(join(SUITE_DIR, ".pair-programmer"), { recursive: true });
process.env.PP_HOME = SUITE_DIR;
process.env.EIGHTS_SKIP_AUDIT_CHECK = "1";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DIST = join(__dirname, "..", "dist");
const importDist = (relPath) => import(pathToFileURL(join(DIST, relPath)).href);

let passed = 0;
let failed = 0;
function record(name, fn) {
  return fn().then(
    () => { console.log(`✓ ${name}`); passed++; },
    (err) => { console.error(`✗ ${name}\n  ${err.stack ?? err.message}`); failed++; },
  );
}

function setupProject() {
  const dir = mkdtempSync(join(tmpdir(), "pp-retry-idem-proj-"));
  mkdirSync(join(dir, ".harness"), { recursive: true });
  writeFileSync(join(dir, "AGENTS.md"), "# AGENTS\n", "utf8");
  return dir;
}

// ---------------------------------------------------------------------
// P3: recordVerdict idempotency_token
// ---------------------------------------------------------------------

await record("recordVerdict with a repeated idempotency_token returns the original verdict and inserts exactly one row", async () => {
  const project = setupProject();
  try {
    const runs = await importDist("orchestrator/runs.js");
    const { db } = await importDist("db/database.js");
    const run = await runs.ensureRun({ request_text: "idem retry", project_path: project, mode: "single" });
    const stage = await runs.startStage({ run_id: run.run_id, kind: "code", gate_type: "code" });
    const att = runs.recordAttempt({ stage_id: stage.stage_id, producer: "claude", model_id: "claude-sonnet-4-6", status: "ok" });

    const first = runs.recordVerdict({
      attempt_id: att.attempt_id,
      judge_producer: "codex",
      judge_model_id: "gpt-5.4",
      outcome: "pass",
      critique_md: "ok",
      score_json: { correctness: 1.0 },
      idempotency_token: "idem-tok-1",
    });
    const second = runs.recordVerdict({
      attempt_id: att.attempt_id,
      judge_producer: "codex",
      judge_model_id: "gpt-5.4",
      outcome: "pass",
      critique_md: "ok",
      score_json: { correctness: 1.0 },
      idempotency_token: "idem-tok-1",
    });

    assert.equal(second.verdict_id, first.verdict_id, "retry with same token must return the original verdict_id");
    const count = db().prepare(`SELECT COUNT(*) AS n FROM verdicts WHERE attempt_id = ?`).get(att.attempt_id);
    assert.equal(count.n, 1, "exactly one verdict row must exist for a repeated idempotency_token");
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

await record("recordVerdict with distinct idempotency_tokens inserts separate rows", async () => {
  const project = setupProject();
  try {
    const runs = await importDist("orchestrator/runs.js");
    const { db } = await importDist("db/database.js");
    const run = await runs.ensureRun({ request_text: "idem distinct", project_path: project, mode: "single" });
    const stage = await runs.startStage({ run_id: run.run_id, kind: "code", gate_type: "code" });
    const att = runs.recordAttempt({ stage_id: stage.stage_id, producer: "claude", model_id: "claude-sonnet-4-6", status: "ok" });

    const a = runs.recordVerdict({
      attempt_id: att.attempt_id, judge_producer: "codex", judge_model_id: "gpt-5.4",
      outcome: "pass", critique_md: "ok", score_json: {}, idempotency_token: "idem-tok-a",
    });
    const b = runs.recordVerdict({
      attempt_id: att.attempt_id, judge_producer: "codex", judge_model_id: "gpt-5.4",
      outcome: "pass", critique_md: "ok", score_json: {}, idempotency_token: "idem-tok-b",
    });
    assert.notEqual(a.verdict_id, b.verdict_id);
    const count = db().prepare(`SELECT COUNT(*) AS n FROM verdicts WHERE attempt_id = ?`).get(att.attempt_id);
    assert.equal(count.n, 2, "distinct tokens must insert separately");
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

await record("recordVerdict rejects a token already owned by a DIFFERENT attempt instead of returning the other attempt's verdict", async () => {
  // LV-8: the idempotency_token unique index is global (unscoped by
  // attempt). A caller that (by bug or genuine collision) reuses a token
  // already recorded against another attempt must get a loud error, never
  // that other attempt's verdict silently handed back as if it were its
  // own. This is the exact defect class that stranded a Hydra attended
  // stage: two different stages' first judge call shared the literal
  // idempotency token "judge-0".
  const project = setupProject();
  try {
    const runs = await importDist("orchestrator/runs.js");
    const { db } = await importDist("db/database.js");
    const run = await runs.ensureRun({ request_text: "idem collision", project_path: project, mode: "single" });

    const stageA = await runs.startStage({ run_id: run.run_id, kind: "code", gate_type: "code" });
    const attA = runs.recordAttempt({ stage_id: stageA.stage_id, producer: "claude", model_id: "claude-sonnet-4-6", status: "ok" });
    const verdictA = runs.recordVerdict({
      attempt_id: attA.attempt_id, judge_producer: "codex", judge_model_id: "gpt-5.4",
      outcome: "pass", critique_md: "ok", score_json: {}, idempotency_token: "shared-collided-token",
    });

    const stageB = await runs.startStage({ run_id: run.run_id, kind: "code", gate_type: "code" });
    const attB = runs.recordAttempt({ stage_id: stageB.stage_id, producer: "claude", model_id: "claude-sonnet-4-6", status: "ok" });

    assert.throws(
      () => runs.recordVerdict({
        attempt_id: attB.attempt_id, judge_producer: "codex", judge_model_id: "gpt-5.4",
        outcome: "pass", critique_md: "ok", score_json: {}, idempotency_token: "shared-collided-token",
      }),
      /idempotency_token .* already recorded against attempt/,
      "a token collision across different attempts must throw, not return the other attempt's verdict",
    );

    // Attempt B must have NO verdict row at all -- the collision must not
    // have silently written or silently "succeeded" as attempt A's row.
    const countB = db().prepare(`SELECT COUNT(*) AS n FROM verdicts WHERE attempt_id = ?`).get(attB.attempt_id);
    assert.equal(countB.n, 0, "the rejected call must not have inserted a row for attempt B");
    // Attempt A's original verdict must be untouched.
    const countA = db().prepare(`SELECT COUNT(*) AS n FROM verdicts WHERE attempt_id = ?`).get(attA.attempt_id);
    assert.equal(countA.n, 1);
    const stillA = db().prepare(`SELECT id FROM verdicts WHERE idempotency_token = ?`).get("shared-collided-token");
    assert.equal(stillA.id, verdictA.verdict_id, "the token must still resolve to attempt A's verdict, unchanged");
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

await record("recordVerdict with no idempotency_token still inserts separately every call", async () => {
  const project = setupProject();
  try {
    const runs = await importDist("orchestrator/runs.js");
    const { db } = await importDist("db/database.js");
    const run = await runs.ensureRun({ request_text: "idem absent", project_path: project, mode: "single" });
    const stage = await runs.startStage({ run_id: run.run_id, kind: "code", gate_type: "code" });
    const att = runs.recordAttempt({ stage_id: stage.stage_id, producer: "claude", model_id: "claude-sonnet-4-6", status: "ok" });

    runs.recordVerdict({ attempt_id: att.attempt_id, judge_producer: "codex", judge_model_id: "gpt-5.4", outcome: "pass", critique_md: "ok", score_json: {} });
    runs.recordVerdict({ attempt_id: att.attempt_id, judge_producer: "codex", judge_model_id: "gpt-5.4", outcome: "pass", critique_md: "ok", score_json: {} });
    const count = db().prepare(`SELECT COUNT(*) AS n FROM verdicts WHERE attempt_id = ?`).get(att.attempt_id);
    assert.equal(count.n, 2, "absent token is legacy behavior: every call inserts");
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------
// P2: txImmediateWithRetry — retries lock contention, not constraint
// errors, bounded by maxAttempts and the maxWallMs backstop.
// ---------------------------------------------------------------------

await record("txImmediateWithRetry retries a lock-contention error and eventually succeeds", async () => {
  const { txImmediateWithRetry } = await importDist("db/database.js");
  let calls = 0;
  const result = txImmediateWithRetry(() => {
    calls++;
    if (calls < 2) {
      const err = new Error("database is locked");
      err.code = "SQLITE_BUSY";
      throw err;
    }
    return "ok";
  }, { maxAttempts: 3, baseDelayMs: 1 });
  assert.equal(result, "ok");
  assert.equal(calls, 2, "should have retried exactly once before succeeding");
});

await record("txImmediateWithRetry does NOT retry a constraint error — fails on first attempt", async () => {
  const { txImmediateWithRetry } = await importDist("db/database.js");
  let calls = 0;
  await assert.rejects(
    async () => txImmediateWithRetry(() => {
      calls++;
      const err = new Error("UNIQUE constraint failed: verdicts.idempotency_token");
      err.code = "SQLITE_CONSTRAINT_UNIQUE";
      throw err;
    }, { maxAttempts: 5, baseDelayMs: 1 }),
    /UNIQUE constraint failed/,
  );
  assert.equal(calls, 1, "a constraint violation must not be retried");
});

await record("txImmediateWithRetry gives up after maxAttempts on sustained lock contention", async () => {
  const { txImmediateWithRetry } = await importDist("db/database.js");
  let calls = 0;
  await assert.rejects(
    async () => txImmediateWithRetry(() => {
      calls++;
      const err = new Error("database is locked");
      err.code = "SQLITE_BUSY";
      throw err;
    }, { maxAttempts: 3, baseDelayMs: 1 }),
    /database is locked/,
  );
  assert.equal(calls, 3, "must stop exactly at maxAttempts, not retry forever");
});

await record("txImmediateWithRetry's maxWallMs backstop cuts retries short even under maxAttempts", async () => {
  const { txImmediateWithRetry } = await importDist("db/database.js");
  let calls = 0;
  await assert.rejects(
    async () => txImmediateWithRetry(() => {
      calls++;
      const err = new Error("database is locked");
      err.code = "SQLITE_BUSY";
      throw err;
    }, { maxAttempts: 100, baseDelayMs: 50, maxWallMs: 30 }),
    /database is locked/,
  );
  // baseDelayMs=50 already exceeds maxWallMs=30 after the very first
  // failed attempt, so the wall-clock backstop must stop retrying long
  // before 100 attempts.
  assert.ok(calls < 10, `expected the wall-time backstop to cut retries well short of maxAttempts, got ${calls} calls`);
});

console.log();
console.log(`${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
