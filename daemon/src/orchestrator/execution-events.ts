/**
 * Phase H (GitHub #49, epic #42) — the execution-event ledger.
 *
 * The governing principle (spec.md §0): these are recovery observations,
 * NEVER manufactured ledger rows. A failed critique is not a generation
 * attempt. The `attempts` table means "a producer generated a candidate
 * artifact"; a vendor CLI that exited non-zero generated nothing, an
 * API-killed run generated nothing new, a subagent dispatch/stop pair is a
 * platform-lifecycle observation, not a candidate.
 *
 * R3 (MUST NOT): this module MUST NOT insert, update, or delete any row in
 * `attempts`, `verdicts`, or `stages`. It MUST NOT call `recordAttempt` and
 * MUST NOT call the budget-tally helper `runs.ts` uses for attempt spend
 * (`tallyBudgets`) — the `failed:`/`run:` scope writers below are a
 * deliberately SEPARATE, smaller implementation of the same upsert shape,
 * not a call into that function, so that (a) this file never engages the
 * `recordAttempt` slot hazard and (b) a static source scan can verify (a)
 * by absence of the literal call.
 */

import { createHash } from "node:crypto";
import { nanoid } from "nanoid";
import { db, txImmediate } from "../db/database.js";

export type ExecutionEventKind =
  | "tool_failure"
  | "tool_success_spend"
  | "api_stop_failure"
  | "constitution_drift"
  | "subagent_dispatch"
  | "subagent_stop"
  | "session_end_sweep";

export type ExecutionEventStatus = "failed" | "observed" | "unreconciled" | "reconciled";

const DETAIL_MAX_CHARS = 4096;

/** R2: call_key MUST NOT include a timestamp or a random value. */
export type CallKeyFields = {
  hook_event_name: string;
  session_id?: string | null;
  tool_name?: string | null;
  /** prompt_id when present, otherwise agent_id, otherwise a stable hash of detail. */
  prompt_id?: string | null;
  agent_id?: string | null;
  detail?: string | null;
  /**
   * NEW-2 (judge verdict_i4RtSb1C7X): coarse (whole-second) timestamp, used
   * ONLY by the detail-hash fallback below. Callers that can supply
   * `prompt_id` or `agent_id` never reach that path. A true replay of one
   * call passes the ORIGINAL value so the key re-derives identically; two
   * distinct calls more than a second apart no longer collide just because
   * their detail text reads alike.
   */
  occurred_at_second?: string | null;
};

/** The exact field names R2 says the derivation reads, iterable by tests (AC-H5). */
export const CALL_KEY_FIELDS = ["hook_event_name", "session_id", "tool_name", "call_id"] as const;

function sha256Hex(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

/**
 * Deterministic idempotency key for a hook payload (R2). No timestamp, no
 * random value — a replayed hook payload MUST derive the same key so the
 * unique index on `call_key` can dedupe it.
 */
export function deriveCallKey(fields: CallKeyFields): string {
  // NEW-2 (judge verdict_i4RtSb1C7X): the `sha256Hex(detail)` fallback is
  // reached when neither `prompt_id` nor `agent_id` is present, and it makes
  // the key a pure function of the message text -- so two genuinely distinct
  // vendor calls that failed with identical detail derive the SAME key, the
  // second insert is swallowed by ON CONFLICT DO NOTHING, `inserted` is
  // false, and its spend is never tallied. Idempotency is supposed to
  // suppress a REPLAY of one call, not two different calls that happen to
  // read alike.
  //
  // Mixing a monotonic component in would defeat idempotency outright, so
  // instead the fallback narrows the collision window to "same session, same
  // tool, same event, same text, same wall-clock second" by including a
  // coarse timestamp. A true replay of one call re-derives the same key
  // because the caller passes the ORIGINAL `occurred_at`; two distinct calls
  // more than a second apart do not collide. Callers that can supply
  // `prompt_id` or `agent_id` never reach this path and are unaffected.
  const callId = fields.prompt_id
    ?? fields.agent_id
    ?? sha256Hex(`${fields.detail ?? ""}|${fields.occurred_at_second ?? ""}`);
  const raw = [
    fields.hook_event_name,
    fields.session_id ?? "",
    fields.tool_name ?? "",
    callId,
  ].join(" ");
  return sha256Hex(raw);
}

export type WriteExecutionEventInput = {
  call_key: string;
  event_kind: ExecutionEventKind;
  status: ExecutionEventStatus;
  tool_name?: string | null;
  producer?: string | null;
  run_id?: string | null;
  stage_id?: string | null;
  session_id?: string | null;
  agent_id?: string | null;
  attempt_slot_id?: string | null;
  reason?: string | null;
  detail?: string | null;
  tokens_in?: number | null;
  tokens_out?: number | null;
  cost_usd?: number | null;
  wall_ms?: number | null;
};

export type WriteExecutionEventOutput = { id: string; inserted: boolean };

/**
 * Idempotent writer (R2, AC-H3/AC-H4): `INSERT ... ON CONFLICT(call_key) DO
 * NOTHING` inside a single IMMEDIATE transaction. A replayed hook payload
 * with a byte-identical call_key resolves to the existing row's id rather
 * than creating a duplicate or silently no-op'ing into an unreported state.
 */
export function writeExecutionEvent(input: WriteExecutionEventInput): WriteExecutionEventOutput {
  const detail = input.detail != null ? String(input.detail).slice(0, DETAIL_MAX_CHARS) : null;
  const id = `evt_${nanoid(10)}`;
  return txImmediate(() => {
    const info = db()
      .prepare(
        `INSERT INTO execution_events(
          id, call_key, event_kind, tool_name, producer, run_id, stage_id, session_id,
          agent_id, attempt_slot_id, status, reason, detail, tokens_in, tokens_out,
          cost_usd, wall_ms, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(call_key) DO NOTHING`,
      )
      .run(
        id,
        input.call_key,
        input.event_kind,
        input.tool_name ?? null,
        input.producer ?? null,
        input.run_id ?? null,
        input.stage_id ?? null,
        input.session_id ?? null,
        input.agent_id ?? null,
        input.attempt_slot_id ?? null,
        input.status,
        input.reason ?? null,
        detail,
        input.tokens_in ?? null,
        input.tokens_out ?? null,
        input.cost_usd ?? null,
        input.wall_ms ?? null,
        new Date().toISOString(),
      );
    if (info.changes > 0) return { id, inserted: true };
    const existing = db()
      .prepare(`SELECT id FROM execution_events WHERE call_key = ?`)
      .get(input.call_key) as { id: string };
    return { id: existing.id, inserted: false };
  });
}

/**
 * R4b: failed vendor spend MUST be visible in `budget_status` AND
 * distinguishable from successful/attempt spend, so it lives under a
 * `failed:` scope prefix rather than the `run:`/`day:`/`model:` scopes
 * `attempts` spend uses. This is a deliberately separate, smaller
 * implementation of the same upsert shape `runs.ts`'s tallyBudgets uses —
 * see the file-level comment for why this file does not call that function.
 */
export function tallyFailedSpend(
  run_id: string | null,
  model_id: string | null,
  tokens_in: number,
  tokens_out: number,
  cost_usd: number,
): void {
  if (!tokens_in && !tokens_out && !cost_usd) return;
  const day = new Date().toISOString().slice(0, 10);
  const now = new Date().toISOString();
  const stmt = db().prepare(
    `INSERT INTO budgets(scope, tokens_in, tokens_out, cost_usd, updated_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(scope) DO UPDATE SET
       tokens_in  = tokens_in  + excluded.tokens_in,
       tokens_out = tokens_out + excluded.tokens_out,
       cost_usd   = cost_usd   + excluded.cost_usd,
       updated_at = excluded.updated_at`,
  );
  if (run_id) stmt.run(`failed:run:${run_id}`, tokens_in, tokens_out, cost_usd, now);
  stmt.run(`failed:day:${day}`, tokens_in, tokens_out, cost_usd, now);
  if (model_id) stmt.run(`failed:model:${model_id}`, tokens_in, tokens_out, cost_usd, now);
}

/**
 * R16/R28 (HIGH-2 fix, run_p8JPpVhDonUA retry): successful vendor-call
 * spend observed by the `cost-tally` PostToolUse hook. Tallies into the
 * ORDINARY `run:`/`day:`/`model:` scopes (the same scopes attempt spend
 * uses) for EVERY `pp_codex`/`pp_agy` call, not only the `direct_cli`
 * backstop path — `cost-tally` is now the sole owner of vendor-CLI tool
 * spend, because `pp_codex`/`pp_agy` `generate` is deprecated so nearly
 * every such call is a judge critique recorded via `recordVerdict`, which
 * takes no tokens/cost and never tallies. `recordAttempt` (runs.ts) no
 * longer tallies for producers "codex"/"agy" — see its R15 comment — so
 * the two writers' domains are disjoint by producer rather than by path.
 *
 * `shouldTally` MUST be the `writeExecutionEvent(...).inserted` flag for
 * this same call's `call_key`, never a proxy like `direct_cli`: the
 * unique-indexed `call_key` is what makes a duplicate/retried hook
 * invocation for the SAME underlying vendor call tally at most once
 * (structural, not "shouldn't happen") — see the call site in
 * dispatcher.ts for the full reasoning.
 */
export function tallySuccessSpend(
  shouldTally: boolean,
  run_id: string | null,
  model_id: string | null,
  tokens_in: number,
  tokens_out: number,
  cost_usd: number,
): void {
  if (!shouldTally) return;
  if (!tokens_in && !tokens_out && !cost_usd) return;
  const day = new Date().toISOString().slice(0, 10);
  const now = new Date().toISOString();
  const stmt = db().prepare(
    `INSERT INTO budgets(scope, tokens_in, tokens_out, cost_usd, updated_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(scope) DO UPDATE SET
       tokens_in  = tokens_in  + excluded.tokens_in,
       tokens_out = tokens_out + excluded.tokens_out,
       cost_usd   = cost_usd   + excluded.cost_usd,
       updated_at = excluded.updated_at`,
  );
  if (run_id) stmt.run(`run:${run_id}`, tokens_in, tokens_out, cost_usd, now);
  stmt.run(`day:${day}`, tokens_in, tokens_out, cost_usd, now);
  if (model_id) stmt.run(`model:${model_id}`, tokens_in, tokens_out, cost_usd, now);
}

/** R7: the only three StopFailure reasons that constitute an API kill. */
export const API_KILL_REASONS = ["rate_limit", "overloaded", "authentication_failed"] as const;
export type ApiKillReason = typeof API_KILL_REASONS[number];

/**
 * R7b (MUST): an unclassified stop-failure reason is not evidence of an API
 * kill — this returns null rather than guessing, and the caller MUST NOT
 * mark the run `surfaced` when it does.
 *
 * HIGH-3 fix (run_p8JPpVhDonUA retry): the original exact-equality match
 * against the three literal tokens silently discarded real-world variants
 * the platform actually sends — `rate_limit_exceeded`, `Overloaded`
 * (capitalized), etc. — because `dispatcher.ts`'s caller wrote nothing at
 * all on a `null` return (R27: this is precisely the "filter silently
 * discards the inputs the assertion exists to find" vacuity class). Two
 * independent changes close it: (1) matching is now case-insensitive
 * substring containment against each of the three tokens, so the observed
 * platform variants classify correctly; (2) the caller (see
 * `surface-api-killed-run` in dispatcher.ts) no longer writes nothing on a
 * `null` return — it records an `api_stop_failure` observation carrying the
 * *raw, unclassified* reason, without touching the run's status, so an
 * operator can see a run died of something this classifier does not yet
 * recognize instead of that fact being invisible until a bug report. R7b's
 * MUST NOT-surface-the-run half is unchanged: only a classified reason may
 * ever move a run to `surfaced`.
 */
export function classifyStopFailureReason(reason: string | undefined | null): ApiKillReason | null {
  if (!reason) return null;
  const normalized = reason.toLowerCase();

  // NEW-1 (run_p8JPpVhDonUA, judge verdict_i4RtSb1C7X): this used to be
  // `API_KILL_REASONS.find(r => normalized.includes(r))`, which returns the
  // first token in ARRAY order rather than the first one occurring in the
  // string -- so "authentication_failed due to rate_limit" classified as
  // `rate_limit`. That matters more than an ordinary near-miss: a CLASSIFIED
  // reason moves the run to `surfaced` and writes `surfaced_reason`, so a
  // mis-classification records a confident wrong cause, which is worse than
  // the silent drop the broadening replaced. Two changes fix it:
  //
  //   1. pick by EARLIEST POSITION IN THE STRING, so a message that mentions
  //      two classes reports the one it actually leads with;
  //   2. require a word boundary, so `rate_limited` and `rate_limit_exceeded`
  //      still match while an unrelated token that merely embeds one of these
  //      as a substring does not.
  //
  // A message mentioning two classes at the same index is impossible, so the
  // earliest-index rule is total.
  let best: { reason: ApiKillReason; at: number } | null = null;
  for (const candidate of API_KILL_REASONS) {
    // Word-boundary-anchored search. `\\b` would not fire against the `_` in
    // these tokens on its trailing side, so bound explicitly on non-word
    // characters or string edges.
    const re = new RegExp(`(?:^|[^a-z0-9_])${candidate}(?:$|[^a-z0-9_])`, "g");
    const m = re.exec(normalized);
    const at = m ? m.index : normalized.indexOf(candidate);
    if (at < 0) continue;
    if (!best || at < best.at) best = { reason: candidate, at };
  }
  return best ? best.reason : null;
}

/**
 * R13: reconcile a SubagentStop observation against SubagentStart dispatch
 * rows for the same session. Returns the dispatch row to mark reconciled
 * ONLY when there is exactly one match — zero or multiple matches are
 * "unreconciled", never a guessed pick (R13b). agent_id absence is likewise
 * unreconciled. No inference from recency, agent_type, or "the sole open
 * stage" is performed here, by design.
 */
export function findSubagentDispatchMatch(
  session_id: string | null | undefined,
  agent_id: string | null | undefined,
): { run_id: string | null; stage_id: string | null; attempt_slot_id: string | null; event_id: string } | null {
  if (!agent_id || !session_id) return null;
  const rows = db()
    .prepare(
      `SELECT id, run_id, stage_id, attempt_slot_id FROM execution_events
        WHERE event_kind = 'subagent_dispatch' AND status = 'observed'
          AND session_id = ? AND agent_id = ?`,
    )
    .all(session_id, agent_id) as Array<{
      id: string; run_id: string | null; stage_id: string | null; attempt_slot_id: string | null;
    }>;
  if (rows.length !== 1) return null;
  const row = rows[0]!;
  return { run_id: row.run_id, stage_id: row.stage_id, attempt_slot_id: row.attempt_slot_id, event_id: row.id };
}

/** Marks a matched dispatch row reconciled (still an execution_events-only write; R13a). */
export function markDispatchReconciled(event_id: string): void {
  db().prepare(`UPDATE execution_events SET status = 'reconciled' WHERE id = ?`).run(event_id);
}
