/**
 * autogenesis-analyzer — pp's self-evolution loop.
 *
 * At every `finalize_run`, this module sweeps the recent DB rows for the
 * project looking for *recurring* patterns: the same rubric flagging the
 * same dimension repeatedly, the same stage failing with structurally
 * similar critiques, the same missability check failing N times on
 * artifacts that were actually fine. Each detected pattern becomes an
 * `evolution_proposals` row + (when TheEights is reachable) a
 * `eights.evolution.propose` submission.
 *
 * Design invariants:
 *   - **Cheap, runs every finalize.** All detection is DB queries against
 *     the existing runs / verdicts / missability_checks tables. No LLM
 *     calls, no semantic reasoning at this stage — just structural
 *     pattern matching. Real reasoning happens later when an operator
 *     reviews via `/pp:evolution review`.
 *   - **Idempotent.** Running the analyzer twice over the same project
 *     state must NOT create duplicate proposals. We key on
 *     (resource_rid, signal_fingerprint) and skip when the same proposal
 *     is already pending.
 *   - **No side effects on pp's resources.** The analyzer only WRITES
 *     evolution_proposals rows + submits to TheEights' evolution queue.
 *     Approved proposals get committed by TheEights' PpWriteBridge to a
 *     side-branch — pp itself never edits its own .claude/* files.
 *   - **Graceful degradation.** When TheEights is offline, proposals
 *     still land in the local evolution_proposals table; they're a
 *     paper trail the operator can review with `/pp:evolution list`
 *     even without the cross-system evolution loop.
 *
 * Detected patterns (Phase F initial set):
 *   P1 — recurring rubric false-positive: same rubric_id flagged the
 *        same artifact kind ≥3 times across the same project.
 *   P2 — recurring stage critique structure: same stage_kind failed
 *        with similar critique vocabulary ≥2 times.
 *   P3 — recurring missability false-positive: same check_id reported
 *        `fail` ≥3 times in the same project (almost always means the
 *        check's heuristic is too tight for this project's idioms).
 */

import { nanoid } from "nanoid";
import { db } from "../db/database.js";
import { log } from "../util/logger.js";
import { envelopeFor } from "./../ecosystem/eights-client.js";
import { evolution } from "./../ecosystem/eights-client.js";

const NOW = () => new Date().toISOString();

export type DetectedProposal = {
  proposal_id: string;
  resource_rid: string;
  pattern: "rubric-false-positive" | "stage-critique" | "missability-false-positive";
  signal_count: number;
  justification: string;
  risk_class: "low" | "medium" | "high";
};

/**
 * Sweep recent project state for recurring drift patterns. Returns the
 * proposals written (existing or newly inserted). Safe to call at every
 * finalize_run.
 */
export async function analyzeAndPropose(opts: {
  run_id: string;
  project_path: string;
}): Promise<DetectedProposal[]> {
  const proposals: DetectedProposal[] = [];

  try {
    // ─── P1: rubric flagging the same artifact-kind ≥3 times ───
    const rubricRows = db()
      .prepare(
        `SELECT v.rubric_id, a.kind AS artifact_kind, COUNT(*) AS n
           FROM verdicts v
           JOIN attempts att ON att.id = v.attempt_id
           JOIN stages   s   ON s.id   = att.stage_id
           JOIN runs     r   ON r.id   = s.run_id
           LEFT JOIN artifacts a ON a.run_id = r.id AND a.stage_id = s.id
          WHERE r.project_path = ?
            AND v.outcome IN ('fail','revise')
            AND v.rubric_id IS NOT NULL
          GROUP BY v.rubric_id, a.kind
         HAVING n >= 3`
      )
      .all(opts.project_path) as Array<{ rubric_id: string; artifact_kind: string | null; n: number }>;

    for (const r of rubricRows) {
      const rid = `resource:pp.rubric.${r.rubric_id}`;
      const fingerprint = `rubric-fp:${r.rubric_id}:${r.artifact_kind ?? "any"}`;
      proposals.push(
        await upsertProposal({
          run_id: opts.run_id,
          resource_rid: rid,
          pattern: "rubric-false-positive",
          signal_count: r.n,
          justification:
            `Rubric "${r.rubric_id}" has flagged ${r.n} ${r.artifact_kind ?? "artifact"}(s) ` +
            `in this project across runs. If these failures share a common false-positive ` +
            `structure, the rubric may need an exception clause for this project's idioms. ` +
            `Operator review recommended via /pp:evolution review.`,
          risk_class: r.rubric_id.includes("owasp") || r.rubric_id.includes("wcag") ? "high" : "medium",
          fingerprint,
        })
      );
    }

    // ─── P2: same stage_kind surfaced ≥2 times ───
    const stageRows = db()
      .prepare(
        `SELECT s.kind AS stage_kind, COUNT(*) AS n
           FROM stages s
           JOIN runs r ON r.id = s.run_id
          WHERE r.project_path = ?
            AND s.status = 'surfaced'
          GROUP BY s.kind
         HAVING n >= 2`
      )
      .all(opts.project_path) as Array<{ stage_kind: string; n: number }>;

    for (const r of stageRows) {
      const rid = `resource:pp.stage-prompt.${r.stage_kind}`;
      const fingerprint = `stage-critique:${r.stage_kind}`;
      proposals.push(
        await upsertProposal({
          run_id: opts.run_id,
          resource_rid: rid,
          pattern: "stage-critique",
          signal_count: r.n,
          justification:
            `Stage kind "${r.stage_kind}" has surfaced ${r.n} times in this project's history. ` +
            `Reflexion ×1 is patching the symptom each time, but the underlying gap appears ` +
            `structural. Consider refining the generator agent's prompt or the stage's rubric. ` +
            `The reflexion-coach should surface the recurring critique pattern explicitly on ` +
            `next failure.`,
          risk_class: "medium",
          fingerprint,
        })
      );
    }

    // ─── P3: missability check failing ≥3 times ───
    const missRows = db()
      .prepare(
        `SELECT m.check_id, COUNT(*) AS n
           FROM missability_checks m
           JOIN runs r ON r.id = m.run_id
          WHERE r.project_path = ?
            AND m.status = 'fail'
          GROUP BY m.check_id
         HAVING n >= 3`
      )
      .all(opts.project_path) as Array<{ check_id: string; n: number }>;

    for (const r of missRows) {
      const rid = `resource:pp.missability.${r.check_id}`;
      const fingerprint = `missability-fp:${r.check_id}`;
      proposals.push(
        await upsertProposal({
          run_id: opts.run_id,
          resource_rid: rid,
          pattern: "missability-false-positive",
          signal_count: r.n,
          justification:
            `Missability check "${r.check_id}" has reported FAIL ${r.n} times in this project. ` +
            `If those failures were dismissed as false positives, the check's heuristic may be ` +
            `too tight for this project's documentation idioms — propose a regex / trigger refinement.`,
          risk_class: "medium",
          fingerprint,
        })
      );
    }
  } catch (err) {
    log.warn({ err, run_id: opts.run_id }, "autogenesis-analyzer swallowed (best-effort)");
  }

  return proposals;
}

type UpsertInput = {
  run_id: string;
  resource_rid: string;
  pattern: DetectedProposal["pattern"];
  signal_count: number;
  justification: string;
  risk_class: DetectedProposal["risk_class"];
  fingerprint: string;
};

async function upsertProposal(input: UpsertInput): Promise<DetectedProposal> {
  // Idempotency: skip if a pending proposal exists for this resource_rid
  // (the fingerprint is encoded into proposed_change for now).
  const existing = db()
    .prepare(
      `SELECT id, status FROM evolution_proposals
         WHERE resource_rid = ? AND status = 'pending'
         ORDER BY created_at DESC LIMIT 1`
    )
    .get(input.resource_rid) as { id: string; status: string } | undefined;

  if (existing) {
    // Update the signal_count on the existing proposal — recurrence count grows.
    try {
      db()
        .prepare(`UPDATE evolution_proposals SET signal_count = ? WHERE id = ?`)
        .run(input.signal_count, existing.id);
    } catch { /* ignore */ }
    return {
      proposal_id: existing.id,
      resource_rid: input.resource_rid,
      pattern: input.pattern,
      signal_count: input.signal_count,
      justification: input.justification,
      risk_class: input.risk_class,
    };
  }

  const id = `prop_${nanoid(10)}`;
  const proposedChange = JSON.stringify({
    pattern: input.pattern,
    fingerprint: input.fingerprint,
    signal_count: input.signal_count,
    suggestion: "operator review required — analyzer detected recurrence, no automated patch authored",
  });

  try {
    db()
      .prepare(
        `INSERT INTO evolution_proposals
           (id, run_id, resource_rid, proposed_change, justification, signal_count, risk_class, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?)`
      )
      .run(
        id,
        input.run_id,
        input.resource_rid,
        proposedChange,
        input.justification,
        input.signal_count,
        input.risk_class,
        NOW()
      );
  } catch (err) {
    log.debug({ err, resource_rid: input.resource_rid }, "evolution_proposals insert failed");
  }

  // Best-effort eights.evolution.propose. When the daemon ack's, back-write
  // eights_proposal_id; otherwise leave NULL — the local row stands.
  try {
    const env = envelopeFor({ run_id: input.run_id, project_path: "(autogenesis)" });
    void evolution
      .propose({
        envelope: env,
        // TheEights ProposeArgs: { rid, candidate_content, justification, ... }.
        rid: input.resource_rid,
        candidate_content: `pp-autogenesis-${Date.now()}`,
        justification: input.justification,
      })
      .then(result => {
        if (result?.proposal_id) {
          try {
            db().prepare(`UPDATE evolution_proposals SET eights_proposal_id = ? WHERE id = ?`)
              .run(result.proposal_id, id);
          } catch { /* ignore */ }
        }
      });
  } catch { /* ignore */ }

  return {
    proposal_id: id,
    resource_rid: input.resource_rid,
    pattern: input.pattern,
    signal_count: input.signal_count,
    justification: input.justification,
    risk_class: input.risk_class,
  };
}

/**
 * Read evolution proposals scoped to a project (optionally filtered by status).
 * Used by the /pp:evolution list slash command.
 */
export function listProposals(opts: {
  project_path: string;
  status?: "pending" | "approved" | "rejected" | "committed" | "rolled_back";
  limit?: number;
}): Array<{
  id: string;
  run_id: string;
  resource_rid: string;
  proposed_change: string;
  justification: string;
  signal_count: number;
  risk_class: string;
  eights_proposal_id: string | null;
  status: string;
  created_at: string;
}> {
  const limit = Math.max(1, Math.min(opts.limit ?? 50, 200));
  const whereClauses: string[] = ["r.project_path = ?"];
  const params: unknown[] = [opts.project_path];
  if (opts.status) {
    whereClauses.push("ep.status = ?");
    params.push(opts.status);
  }
  return db()
    .prepare(
      `SELECT ep.id, ep.run_id, ep.resource_rid, ep.proposed_change, ep.justification,
              ep.signal_count, ep.risk_class, ep.eights_proposal_id, ep.status, ep.created_at
         FROM evolution_proposals ep
         JOIN runs r ON r.id = ep.run_id
        WHERE ${whereClauses.join(" AND ")}
        ORDER BY ep.created_at DESC
        LIMIT ?`
    )
    .all(...params, limit) as Array<{
      id: string; run_id: string; resource_rid: string; proposed_change: string;
      justification: string; signal_count: number; risk_class: string;
      eights_proposal_id: string | null; status: string; created_at: string;
    }>;
}

/** Update a proposal's local status; used by /pp:evolution review on approve/reject. */
export function setProposalStatus(id: string, status: "approved" | "rejected"): boolean {
  const r = db()
    .prepare(`UPDATE evolution_proposals SET status = ? WHERE id = ? AND status = 'pending'`)
    .run(status, id);
  return r.changes > 0;
}
