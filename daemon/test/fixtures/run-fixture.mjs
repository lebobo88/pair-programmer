// ─── daemon/test/fixtures/run-fixture.mjs ─────────────────────────────────
//
// Phase B / R3.9 — the fixture builder is a real, COMMITTED deliverable of
// this phase, not a throwaway script. Phase A's own "largest getRun payload"
// measurement (137,255 chars, run_Ez8ZNLbSB2h6) was taken with a one-off
// script that left nothing reproducible; this file is what fixes that.
//
// CONTRACT
//   - Deterministic: fixed seeds, fixed timestamps, no Date.now(), no
//     Math.random(), no crypto.randomUUID(). Two calls to buildFixture()
//     with the same options, against two independent temp databases, MUST
//     produce byte-identical serialized getRun / buildReplayBundle payloads
//     (R3.9 acceptance).
//   - Side-effect timing: this module does NOT statically import any
//     `dist/` module at the top level, because the guard test (R3.2) must
//     set PP_HOME before the FIRST dist import, and this file may be
//     statically imported by the guard test before that happens. All dist
//     imports here are dynamic (`await import(...)`) and only execute
//     inside buildFixture(), which the caller invokes after PP_HOME is set.
//   - Sizing is parameterized (stageCount / attemptsPerStage /
//     verdictsPerAttempt / critiqueMdChars) so the guard test can request
//     both a "floor" fixture (>= FIXTURE_FLOOR_CHARS, R3.10) and an
//     "oversize" fixture that exceeds a declared ceiling (R3.11's negative
//     test), from the same deterministic generator.
//   - Every construction is idempotent within a single database: the run
//     row (and its cascade) is deleted before insert, so calling
//     buildFixture() twice against the same open db() handle does not
//     violate a PRIMARY KEY constraint and still yields identical output.

import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DIST = join(__dirname, "..", "..", "dist");

function importDist(relPath) {
  return import(pathToFileURL(join(DIST, relPath)).href);
}

// Provenance (R2.6/R3.10): Phase A baseline measured the largest real
// getRun payload on disk at 137,255 chars (run_Ez8ZNLbSB2h6, corrected
// 2026-09-06). R3.10 requires this fixture's getRun payload to serialize
// to STRICTLY MORE than that figure, and the fixture must self-check the
// floor rather than trust a stale constant.
export const PHASE_A_BASELINE_GET_RUN_CHARS = 137255;

// R3.10: the floor the fixture's own getRun serialization must clear,
// strictly greater than PHASE_A_BASELINE_GET_RUN_CHARS.
export const FIXTURE_FLOOR_CHARS = 150000;

/** Deterministic filler text: no randomness, no wall-clock dependence. */
function detText(seed, targetLen) {
  const base = `fixture-content-${seed}-`;
  let out = "";
  while (out.length < targetLen) out += base;
  return out.slice(0, targetLen);
}

const FIXED_TS = "2026-01-01T00:00:00.000Z";

/**
 * Documented size parameterization (R3.9). Defaults produce a payload
 * comfortably above FIXTURE_FLOOR_CHARS (the "floor" preset used by the
 * positive R3.7 assertion). Callers that need an over-ceiling fixture for
 * R3.11's negative test should pass a larger `critiqueMdChars` (see
 * OVERSIZE_FIXTURE_OPTS below) — critique_md is the dominant contributor to
 * getRun's payload size (F-6), so scaling it alone is the cheapest way to
 * cross a ceiling deterministically.
 *
 * @param {object} [opts]
 * @param {string} [opts.runId] - run id to (re)build under. Default is
 *   fixed and deterministic; pass a distinct id to keep two fixtures
 *   coexisting in the same database.
 * @param {number} [opts.stageCount]
 * @param {number} [opts.attemptsPerStage]
 * @param {number} [opts.verdictsPerAttempt]
 * @param {number} [opts.critiqueMdChars] - length of each verdict's
 *   critique_md body. Dominant size driver (F-6: verdicts.critique_md via
 *   SELECT *).
 * @returns {Promise<{
 *   runId: string,
 *   getRunBytes: number,
 *   getRunChars: number,
 *   replayBytes: number,
 *   replayChars: number,
 *   ratio: number,
 *   getRunSerialized: string,
 *   replaySerialized: string,
 * }>}
 */
export async function buildFixture(opts = {}) {
  const {
    runId = "run_fixture_deterministic_0001",
    stageCount = 4,
    attemptsPerStage = 3,
    verdictsPerAttempt = 2,
    critiqueMdChars = 7000,
  } = opts;

  const { db } = await importDist("db/database.js");
  const { getRun } = await importDist("orchestrator/runs.js");
  const { buildReplayBundle } = await importDist("orchestrator/replay.js");
  const { jsonContent } = await importDist("mcp/helpers.js");

  const conn = db();

  // Idempotent re-run: cascade-delete any prior fixture under this id.
  conn.prepare(`DELETE FROM runs WHERE id = ?`).run(runId);

  conn
    .prepare(
      `INSERT INTO runs (id, project_path, request_text, mode, status, started_at, finished_at)
       VALUES (?,?,?,?,?,?,?)`,
    )
    .run(
      runId,
      "/fixture/project",
      "deterministic run-fixture for daemon/test/mcp-instructions.unit.mjs (R3.9)",
      "single",
      "complete",
      FIXED_TS,
      FIXED_TS,
    );

  for (let s = 0; s < stageCount; s++) {
    const stageId = `${runId}_stage_${s}`;
    conn
      .prepare(
        `INSERT INTO stages (id, run_id, kind, gate_type, status, started_at, finished_at)
         VALUES (?,?,?,?,?,?,?)`,
      )
      .run(stageId, runId, "code", "code_style", "passed", FIXED_TS, FIXED_TS);

    for (let a = 0; a < attemptsPerStage; a++) {
      const attemptId = `${stageId}_attempt_${a}`;
      conn
        .prepare(
          `INSERT INTO attempts
             (id, stage_id, producer, model_id, prompt_hash, artifact_path,
              tokens_in, tokens_out, cost_usd, wall_ms, retry_index,
              parent_attempt_id, status, created_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        )
        .run(
          attemptId,
          stageId,
          "claude",
          "claude-sonnet-5",
          detText(`prompt-${s}-${a}`, 40),
          `artifact-${s}-${a}.md`,
          1000,
          2000,
          0.05,
          12345,
          0,
          null,
          "ok",
          FIXED_TS,
        );

      for (let v = 0; v < verdictsPerAttempt; v++) {
        const verdictId = `${attemptId}_verdict_${v}`;
        conn
          .prepare(
            `INSERT INTO verdicts
               (id, attempt_id, judge_producer, judge_model_id, rubric_id,
                outcome, critique_md, score_json, cross_vendor,
                judge_reasoning_effort, judge_model_source,
                judge_override_reason, created_at)
             VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          )
          .run(
            verdictId,
            attemptId,
            "codex",
            "gpt-5.6-terra",
            "openapi-3.1-stability@1",
            "pass",
            detText(`critique-${s}-${a}-${v}`, critiqueMdChars),
            JSON.stringify({ score: 0.9, dims: { schema_validity: 0.9, deprecation_policy: 0.9 } }),
            1,
            "medium",
            "default",
            null,
            FIXED_TS,
          );
      }
    }
  }

  const artifactCount = 8;
  for (let i = 0; i < artifactCount; i++) {
    conn
      .prepare(
        `INSERT INTO artifacts (id, run_id, stage_id, taxonomy_section, kind, path, sha256, bytes, created_at)
         VALUES (?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        `${runId}_artifact_${i}`,
        runId,
        null,
        "4.7",
        "spec",
        `artifact-${i}.md`,
        detText(`sha-${i}`, 64),
        1024,
        FIXED_TS,
      );
  }

  const getRunResult = getRun(runId);
  const getRunSerialized = jsonContent(getRunResult).content[0].text;
  const getRunBytes = Buffer.byteLength(getRunSerialized, "utf8");

  const replayResult = buildReplayBundle(runId);
  const replaySerialized = jsonContent(replayResult).content[0].text;
  const replayBytes = Buffer.byteLength(replaySerialized, "utf8");

  return {
    runId,
    getRunBytes,
    getRunChars: getRunSerialized.length,
    replayBytes,
    replayChars: replaySerialized.length,
    ratio: replayBytes / getRunBytes,
    getRunSerialized,
    replaySerialized,
  };
}

/**
 * R3.10 self-check: the fixture MUST clear FIXTURE_FLOOR_CHARS before any
 * ceiling assertion runs against it. Fails loudly, naming the floor and the
 * actual size, if a fixture (built with buildFixture's defaults or the
 * caller's own options) falls short. This is a self-check on the fixture's
 * OWN output, not a re-implementation of the guard test's ceiling logic.
 */
export function assertClearsFloor(fixtureResult) {
  if (fixtureResult.getRunChars < FIXTURE_FLOOR_CHARS) {
    throw new Error(
      `run-fixture.mjs: fixture's getRun payload (${fixtureResult.getRunChars} chars) ` +
        `is BELOW the required floor of ${FIXTURE_FLOOR_CHARS} chars (R3.10). ` +
        `The floor exists because the Phase A baseline's largest real getRun payload was ` +
        `${PHASE_A_BASELINE_GET_RUN_CHARS} chars; a fixture under the floor turns the ceiling ` +
        `assertion into a tautology. Increase stageCount/attemptsPerStage/verdictsPerAttempt/` +
        `critiqueMdChars in the caller's buildFixture() options.`,
    );
  }
}

/**
 * R3.11 negative-test preset: a fixture whose getRun payload deliberately
 * exceeds get_run's declared ceiling (300,000 chars, R2.7). Reuses the same
 * topology as the default/"floor" preset but scales critiqueMdChars up —
 * critique_md is the dominant size driver (F-6), so this is the cheapest
 * deterministic way to cross a ceiling. Callers pass this into
 * buildFixture() under a distinct runId so it can coexist with the floor
 * fixture in the same database.
 */
export const OVERSIZE_FIXTURE_OPTS = {
  runId: "run_fixture_deterministic_oversize_0001",
  stageCount: 4,
  attemptsPerStage: 3,
  verdictsPerAttempt: 2,
  critiqueMdChars: 15000,
};
