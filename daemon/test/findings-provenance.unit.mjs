// Unit test for R3-tail post-mortem Fix 1.4: judge-cross-vendor
// findings provenance validation. When the judge cites a quoted_text that
// doesn't appear in the cited file, the verdict is flagged as
// hallucination_suspected — surfaces the smell without auto-retracting.

import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import assert from "node:assert/strict";

const SUITE_DIR = mkdtempSync(join(tmpdir(), "pp-findings-prov-"));
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
    (err) => { console.error(`✗ ${name}\n  ${err.message}`); failed++; },
  );
}

function setupProject() {
  const dir = mkdtempSync(join(tmpdir(), "pp-findings-prov-proj-"));
  mkdirSync(join(dir, ".harness"), { recursive: true });
  writeFileSync(join(dir, "AGENTS.md"), "# AGENTS\n", "utf8");
  return dir;
}

await record("provenance with quoted_text on disk does NOT flag hallucination", async () => {
  const project = setupProject();
  try {
    const runs = await importDist("orchestrator/runs.js");
    const { db } = await importDist("db/database.js");
    const run = await runs.ensureRun({ request_text: "prov ok", project_path: project, mode: "single" });
    const stage = await runs.startStage({ run_id: run.run_id, kind: "code", gate_type: "code" });
    const att = runs.recordAttempt({ stage_id: stage.stage_id, producer: "claude", model_id: "claude-sonnet-4-6", status: "ok" });

    // Write a file the judge will cite.
    mkdirSync(join(project, "supabase", "migrations"), { recursive: true });
    writeFileSync(
      join(project, "supabase", "migrations", "007.sql"),
      "CREATE POLICY photo_comments_select_own ON photo_comments\n" +
      "  FOR SELECT TO authenticated\n" +
      "  USING (deleted_at IS NULL AND auth.uid() = user_id);\n",
      "utf8",
    );

    const verdict = runs.recordVerdict({
      attempt_id: att.attempt_id,
      judge_producer: "codex",
      judge_model_id: "gpt-5.4",
      rubric_id: "rls-correctness@1",
      outcome: "pass",
      critique_md: "policy 007 looks good — soft-delete filter present",
      score_json: {
        correctness: 1.0,
        findings_provenance: [
          {
            id: "INFO-1",
            file: "supabase/migrations/007.sql",
            line: 3,
            quoted_text: "USING (deleted_at IS NULL",
            claim: "soft-delete filter present in USING clause",
          },
        ],
      },
    });

    const row = db().prepare(`SELECT hallucination_suspected FROM verdicts WHERE id = ?`).get(verdict.verdict_id);
    assert.equal(row?.hallucination_suspected, 0, "verified quote should NOT flag hallucination");
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

await record("provenance with NON-matching quoted_text flags hallucination", async () => {
  const project = setupProject();
  try {
    const runs = await importDist("orchestrator/runs.js");
    const { db } = await importDist("db/database.js");
    const run = await runs.ensureRun({ request_text: "prov hallu", project_path: project, mode: "single" });
    const stage = await runs.startStage({ run_id: run.run_id, kind: "code", gate_type: "code" });
    const att = runs.recordAttempt({ stage_id: stage.stage_id, producer: "claude", model_id: "claude-sonnet-4-6", status: "ok" });

    mkdirSync(join(project, "apps", "web"), { recursive: true });
    writeFileSync(
      join(project, "apps", "web", "x.ts"),
      "export const REAL_CONTENT = 'this file actually contains this string';\n",
      "utf8",
    );

    const verdict = runs.recordVerdict({
      attempt_id: att.attempt_id,
      judge_producer: "codex",
      judge_model_id: "gpt-5.4",
      rubric_id: "code-quality@1",
      outcome: "fail",
      critique_md: "judge claims a bug that isn't there",
      score_json: {
        findings_provenance: [
          {
            id: "C1",
            file: "apps/web/x.ts",
            line: 1,
            quoted_text: "void idempotencyKey; // explicit no-op",
            claim: "no-op idempotency key in code",
          },
        ],
      },
    });
    const row = db().prepare(`SELECT hallucination_suspected, hallucination_details FROM verdicts WHERE id = ?`).get(verdict.verdict_id);
    assert.equal(row?.hallucination_suspected, 1, "fabricated quote should flag hallucination");
    assert.ok(row?.hallucination_details, "details json populated");
    const details = JSON.parse(row.hallucination_details);
    assert.equal(details.misses.length, 1);
    assert.equal(details.misses[0].file, "apps/web/x.ts");
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

await record("provenance with path-traversal in file is flagged", async () => {
  const project = setupProject();
  try {
    const runs = await importDist("orchestrator/runs.js");
    const { db } = await importDist("db/database.js");
    const run = await runs.ensureRun({ request_text: "traversal", project_path: project, mode: "single" });
    const stage = await runs.startStage({ run_id: run.run_id, kind: "code", gate_type: "code" });
    const att = runs.recordAttempt({ stage_id: stage.stage_id, producer: "claude", model_id: "claude-sonnet-4-6", status: "ok" });
    const verdict = runs.recordVerdict({
      attempt_id: att.attempt_id,
      judge_producer: "codex",
      judge_model_id: "gpt-5.4",
      outcome: "fail",
      critique_md: "bad provenance",
      score_json: {
        findings_provenance: [
          {
            id: "BAD-1",
            file: "../../etc/passwd",
            quoted_text: "root:x:0:0:root:/root:/bin/bash",
            claim: "path-traversal attempt",
          },
        ],
      },
    });
    const row = db().prepare(`SELECT hallucination_suspected FROM verdicts WHERE id = ?`).get(verdict.verdict_id);
    assert.equal(row?.hallucination_suspected, 1, "path-traversal should flag");
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

await record("verdict without findings_provenance is not flagged", async () => {
  const project = setupProject();
  try {
    const runs = await importDist("orchestrator/runs.js");
    const { db } = await importDist("db/database.js");
    const run = await runs.ensureRun({ request_text: "no prov", project_path: project, mode: "single" });
    const stage = await runs.startStage({ run_id: run.run_id, kind: "code", gate_type: "code" });
    const att = runs.recordAttempt({ stage_id: stage.stage_id, producer: "claude", model_id: "claude-sonnet-4-6", status: "ok" });
    const verdict = runs.recordVerdict({
      attempt_id: att.attempt_id,
      judge_producer: "codex",
      judge_model_id: "gpt-5.4",
      outcome: "pass",
      critique_md: "ok",
      score_json: { correctness: 1.0 },
    });
    const row = db().prepare(`SELECT hallucination_suspected FROM verdicts WHERE id = ?`).get(verdict.verdict_id);
    assert.equal(row?.hallucination_suspected, 0);
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

console.log();
console.log(`${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
