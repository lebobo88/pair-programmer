/**
 * Plan-first structural finalize gate.
 *
 * X1b: standard/major-scoped runs must pass through a planning stage before
 * a `code` stage is allowed to finalize as 'passed'. This module supplies
 * the two predicates `getStageFinalizeReadiness` (in runs.ts) composes into
 * a blocker: whether the gate applies to a run at all (`planFirstRequired`),
 * and whether a `code` stage has an eligible predecessor
 * (`findPriorPassedPlanningStage`).
 *
 * Why PLAN_FIRST_STAGE_KINDS is a set, not a single 'spec' kind: shipped team
 * pipelines shape their planning stage differently by domain.
 * bug-fix-team/game-bug-fix-team open with `repro` (reproduce the bug before
 * touching code); refactor-team/game-refactor-team/game-bug-fix-team open
 * with `invariants` (what must not change); game-feature-team runs a game
 * design chain (`one_pager`, `gdd`, `mechanic_spec`, `tech_design_doc`)
 * before `code`. A gate that only recognized `spec` would block every
 * standard/major run dispatched through those teams even though they DO plan
 * before coding -- they just don't call it a spec. See the regression test
 * in daemon/test/plan-first-gate.unit.mjs that walks every .claude/teams/*.yaml
 * and asserts each team with a `code` stage lists at least one of these kinds
 * before its first `code` stage.
 *
 * Threat model / scope: this gate reads the run's persisted
 * `taxonomy_mapping_json` (written at intake, before any stage row exists, by
 * `recordTaxonomyMapping`) and only engages for scope 'standard' or 'major'.
 * Runs with no recorded mapping, an unparseable mapping, or a mapping without
 * a valid `.scope` are UNAFFECTED (fail-open, not fail-closed) -- this is
 * deliberate. Hydra-driven attended runs never call recordTaxonomyMapping, so
 * gating on its absence would block every attended engineering run in the
 * ecosystem, not just the pp-native taxonomy-driven flow this gate targets.
 * `recordTaxonomyMapping` itself freezes the recorded `.scope` once the run
 * has any stage row (see its doc comment in runs.ts) so a generator cannot
 * dodge this gate mid-run by re-recording a 'trivial' scope after stages
 * begin.
 *
 * OPERATOR-DECIDED EXEMPTION -- best-of runs: `runs.mode = 'best_of'` is
 * exempt from this gate regardless of recorded scope. `/pp:best-of`
 * (best-of-n.ts `startBestOfStage`) opens ONLY a `code` stage -- an explicit
 * code-generation race across N candidate vendors/attempts, judged
 * cross-vendor at finalize -- and has no planning-stage step in its
 * pipeline. Without this exemption every standard/major-scope best-of run
 * would throw PlanFirstGateViolation on its first (and only) stage, which
 * would break the feature outright rather than enforce a real planning
 * discipline. The exemption is read directly off `runs.mode`, not off the
 * taxonomy mapping, so it can't be spoofed by an ordinary run merely
 * recording a mapping shaped like a best-of run.
 *
 * INVERTED relative to the TDD gate (tdd-gate.ts `findPriorTestsPreStage`):
 * the TDD gate treats the ABSENCE of a prior `tests_pre` stage as "this
 * pipeline isn't TDD-shaped, gate does not apply" -- opt-in per pipeline
 * shape. This gate treats the ABSENCE of a prior *passed* planning stage as
 * the violation itself -- opt-out only via scope ('trivial'/no mapping) or
 * an explicit 'surfaced' finalize. Do not read the two predicates as
 * symmetric: a null return from the TDD lookup clears its gate, while a null
 * return from `findPriorPassedPlanningStage` is exactly what trips this one.
 */

import { db } from "../db/database.js";

export const PLAN_FIRST_STAGE_KINDS = [
  "spec",
  "repro",
  "invariants",
  "one_pager",
  "gdd",
  "mechanic_spec",
  "tech_design_doc",
] as const;

export type PlanFirstStageKind = typeof PLAN_FIRST_STAGE_KINDS[number];

/**
 * True only when `run_id` has a recorded taxonomy mapping whose parsed
 * `.scope` is 'standard' or 'major', AND the run's mode is not 'best_of'.
 * Every other state -- missing row, NULL/empty `taxonomy_mapping_json`,
 * malformed JSON, a non-object payload, a `.scope` that is
 * absent/invalid/'trivial', or `mode = 'best_of'` -- returns false, meaning
 * the run is unaffected by this gate. See the module comment's
 * "OPERATOR-DECIDED EXEMPTION" section for why best-of runs are exempt.
 */
export function planFirstRequired(run_id: string): boolean {
  const row = db()
    .prepare(`SELECT taxonomy_mapping_json, mode FROM runs WHERE id = ?`)
    .get(run_id) as { taxonomy_mapping_json: string | null; mode: string | null } | undefined;
  if (row?.mode === "best_of") return false;
  const raw = row?.taxonomy_mapping_json;
  if (!raw || !raw.trim()) return false;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return false; // malformed mapping -> unaffected, not fail-closed
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return false;

  const scope = (parsed as { scope?: unknown }).scope;
  return scope === "standard" || scope === "major";
}

/**
 * For a `code` stage, find a stage in the same run whose kind is in
 * PLAN_FIRST_STAGE_KINDS and whose *completion* -- not its start -- precedes
 * the code stage's start. Returns null if no such stage exists, which is the
 * condition that trips the plan-first blocker.
 *
 * Ordering rule (cross-vendor critique gpt-5.6-terra P1a; rowid tie-break
 * removed per follow-up critique, see below): a planning stage counts only
 * if, evaluated at readiness time against its CURRENT row:
 *   1. status = 'passed', AND
 *   2. finished_at IS NOT NULL, AND
 *   3. finished_at STRICTLY LESS THAN the code stage's started_at.
 * A stage that merely STARTED before the code stage no longer qualifies --
 * P1a's window (spec started, code started while spec still open, spec later
 * passes) is closed because we now gate on completion, not the start race.
 * Re-opened/re-finalized planning stages are naturally covered because this
 * reads the row's live status/finished_at rather than caching an earlier
 * pass: a stage later flipped away from 'passed' stops counting, and a stage
 * re-finalized to a later finished_at is compared against that later value.
 *
 * No tie-break, equal timestamps BLOCK (fixed here, second cross-vendor
 * pass): `finished_at`/`started_at` are `new Date().toISOString()` (see
 * runs.ts `now()`), millisecond-precision UTC strings. The previous revision
 * of this module fell back, on an exact-millisecond tie, to comparing
 * SQLite `rowid` -- reasoning that whichever row was INSERTed first must
 * have been created first. That reasoning is unsound: `rowid` records when
 * a stage row was INSERTed (i.e. *started*), not when it *finished*. A spec
 * row can be inserted first (lower rowid) and still finish, at millisecond
 * resolution, in the same tick a later-inserted code stage starts --
 * because "starts" and "finishes" are different events on different rows,
 * rowid order says nothing about their relative finish/start order. Given
 * timestamps equal at millisecond granularity, we cannot prove the planning
 * stage's completion strictly preceded the code stage's start, so we treat
 * the tie as NOT proven and block (conservative, fail-closed on ambiguity)
 * rather than guessing from insertion order.
 *
 * This is a single SQL query so the ordering rule can't drift out of sync
 * between two code paths.
 */
export function findPriorPassedPlanningStage(
  code_stage_id: string,
): { stage_id: string; kind: PlanFirstStageKind } | null {
  const code = db()
    .prepare(`SELECT id, run_id, started_at FROM stages WHERE id = ?`)
    .get(code_stage_id) as
      | { id: string; run_id: string; started_at: string }
      | undefined;
  if (!code) return null;

  const placeholders = PLAN_FIRST_STAGE_KINDS.map(() => "?").join(", ");
  const prior = db()
    .prepare(
      `SELECT id, kind FROM stages
       WHERE run_id = ?
         AND kind IN (${placeholders})
         AND status = 'passed'
         AND finished_at IS NOT NULL
         AND finished_at < ?
       ORDER BY finished_at DESC
       LIMIT 1`,
    )
    .get(code.run_id, ...PLAN_FIRST_STAGE_KINDS, code.started_at) as
      | { id: string; kind: PlanFirstStageKind }
      | undefined;

  return prior ? { stage_id: prior.id, kind: prior.kind } : null;
}
