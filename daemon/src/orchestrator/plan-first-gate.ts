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
 * `.scope` is 'standard' or 'major'. Every other state -- missing row,
 * NULL/empty `taxonomy_mapping_json`, malformed JSON, a non-object payload,
 * or a `.scope` that is absent/invalid/'trivial' -- returns false, meaning
 * the run is unaffected by this gate.
 */
export function planFirstRequired(run_id: string): boolean {
  const row = db()
    .prepare(`SELECT taxonomy_mapping_json FROM runs WHERE id = ?`)
    .get(run_id) as { taxonomy_mapping_json: string | null } | undefined;
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
 * Ordering rule (cross-vendor critique gpt-5.6-terra P1a/P1b, fixed here):
 * a planning stage counts only if, evaluated at readiness time against its
 * CURRENT row:
 *   1. status = 'passed', AND
 *   2. finished_at IS NOT NULL, AND
 *   3. finished_at <= the code stage's started_at.
 * A stage that merely STARTED before the code stage no longer qualifies --
 * P1a's window (spec started, code started while spec still open, spec later
 * passes) is closed because we now gate on completion, not the start race.
 * Re-opened/re-finalized planning stages are naturally covered because this
 * reads the row's live status/finished_at rather than caching an earlier
 * pass: a stage later flipped away from 'passed' stops counting, and a stage
 * re-finalized to a later finished_at is compared against that later value.
 *
 * Tie-break (P1b): `finished_at` and `started_at` are `new Date().toISOString()`
 * (see runs.ts `now()`), a fixed-width UTC string with millisecond precision,
 * so lexical `<`/`=` on the raw column is equivalent to chronological order --
 * no need to parse. When finished_at exactly equals the code stage's
 * started_at (same millisecond), string equality alone cannot order them, so
 * we fall back to insertion order: the planning stage must have a lower
 * SQLite `rowid` than the code stage (rowid is monotonically assigned on
 * INSERT and available on this table because `stages` is a normal, not
 * WITHOUT ROWID, table). This mirrors what actually happened: whichever row
 * SQLite inserted first is the one that (by construction, since both use the
 * same clock source and INSERT immediately follows the `now()` read) was
 * created earlier when timestamps alias to the same millisecond.
 *
 * This is a single SQL query so the ordering + tie-break can't drift out of
 * sync between two code paths.
 */
export function findPriorPassedPlanningStage(
  code_stage_id: string,
): { stage_id: string; kind: PlanFirstStageKind } | null {
  const code = db()
    .prepare(`SELECT id, run_id, started_at, rowid AS row_id FROM stages WHERE id = ?`)
    .get(code_stage_id) as
      | { id: string; run_id: string; started_at: string; row_id: number }
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
         AND (
           finished_at < ?
           OR (finished_at = ? AND rowid < ?)
         )
       ORDER BY finished_at DESC, rowid DESC
       LIMIT 1`,
    )
    .get(code.run_id, ...PLAN_FIRST_STAGE_KINDS, code.started_at, code.started_at, code.row_id) as
      | { id: string; kind: PlanFirstStageKind }
      | undefined;

  return prior ? { stage_id: prior.id, kind: prior.kind } : null;
}
