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
 * `taxonomy_mapping_json` (written once, at intake, by `recordTaxonomyMapping`)
 * and only engages for scope 'standard' or 'major'. Runs with no recorded
 * mapping, an unparseable mapping, or a mapping without a valid `.scope` are
 * UNAFFECTED (fail-open, not fail-closed) -- this is deliberate. Hydra-driven
 * attended runs never call recordTaxonomyMapping, so gating on its absence
 * would block every attended engineering run in the ecosystem, not just the
 * pp-native taxonomy-driven flow this gate targets.
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
 * For a `code` stage, find the latest stage in the same run whose kind is in
 * PLAN_FIRST_STAGE_KINDS, whose status is 'passed', and which started
 * strictly BEFORE this stage's started_at. Returns null if no such stage
 * exists -- which is the condition that trips the plan-first blocker.
 */
export function findPriorPassedPlanningStage(
  code_stage_id: string,
): { stage_id: string; kind: PlanFirstStageKind } | null {
  const code = db()
    .prepare(`SELECT id, run_id, started_at FROM stages WHERE id = ?`)
    .get(code_stage_id) as { id: string; run_id: string; started_at: string } | undefined;
  if (!code) return null;

  const placeholders = PLAN_FIRST_STAGE_KINDS.map(() => "?").join(", ");
  const prior = db()
    .prepare(
      `SELECT id, kind FROM stages
       WHERE run_id = ? AND kind IN (${placeholders}) AND status = 'passed' AND started_at < ?
       ORDER BY started_at DESC LIMIT 1`,
    )
    .get(code.run_id, ...PLAN_FIRST_STAGE_KINDS, code.started_at) as
      | { id: string; kind: PlanFirstStageKind }
      | undefined;

  return prior ? { stage_id: prior.id, kind: prior.kind } : null;
}
