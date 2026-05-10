/**
 * Anti-runaway loop ceiling. Counts validator (verdict) calls per run and
 * blocks new ones beyond the configured ceiling. Distinct from cost
 * tracking (which is logged-not-enforced) — this prevents broken-rubric
 * loops from burning through token budgets. Default 6 per run.
 *
 * Override: pass `override=true` to retry_with_critique (the user can do this
 * via /pp:retry --budget-override).
 */

import { db } from "../db/database.js";
import { DEFAULT_LOOP_CEILING } from "../config.js";

export function loopCeilingStatus(run_id: string): {
  run_id: string;
  validator_calls: number;
  ceiling: number;
  remaining: number;
  blocked: boolean;
} {
  const row = db()
    .prepare(
      `SELECT COUNT(*) AS c FROM verdicts v
       JOIN attempts a ON a.id = v.attempt_id
       JOIN stages   s ON s.id = a.stage_id
       WHERE s.run_id = ?`
    )
    .get(run_id) as { c: number };

  const ceiling = DEFAULT_LOOP_CEILING;
  const validator_calls = row?.c ?? 0;
  const remaining = Math.max(0, ceiling - validator_calls);
  return {
    run_id,
    validator_calls,
    ceiling,
    remaining,
    blocked: validator_calls >= ceiling,
  };
}

/** Reflexion ×1 invariant + loop-ceiling check, in one place. */
export function checkRetryEligible(opts: {
  attempt_id: string;
  budget_override?: boolean;
}): { ok: true; parent_attempt_id: string } | { ok: false; reason: string } {
  const att = db()
    .prepare(`SELECT id, stage_id, retry_index, parent_attempt_id FROM attempts WHERE id = ?`)
    .get(opts.attempt_id) as
    | { id: string; stage_id: string; retry_index: number; parent_attempt_id: string | null }
    | undefined;
  if (!att) return { ok: false, reason: `attempt ${opts.attempt_id} not found` };

  if (att.retry_index >= 1) {
    return { ok: false, reason: `Reflexion ×1 invariant: this attempt is already a retry (retry_index=${att.retry_index})` };
  }

  const stage = db()
    .prepare(`SELECT run_id FROM stages WHERE id = ?`)
    .get(att.stage_id) as { run_id: string } | undefined;
  if (!stage) return { ok: false, reason: `stage ${att.stage_id} not found` };

  if (!opts.budget_override) {
    const ceiling = loopCeilingStatus(stage.run_id);
    if (ceiling.blocked) {
      return {
        ok: false,
        reason: `loop ceiling reached: ${ceiling.validator_calls}/${ceiling.ceiling} validator calls in this run. Pass budget_override=true to force.`,
      };
    }
  }

  return { ok: true, parent_attempt_id: opts.attempt_id };
}
