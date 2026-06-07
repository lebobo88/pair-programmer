/**
 * eights-writes — fire-and-forget wrappers that turn pp lifecycle events
 * into TheEights memories.
 *
 * Design contract (Phase B / T1.1):
 *   - Every wrapper is **async, returns void, NEVER throws**. Call sites
 *     dispatch them via `void` (no await) so they don't block pp's sync
 *     orchestration paths (archiveArtifact, recordVerdict, finalizeRun).
 *   - On success, the returned memory_id/handle is back-written to the
 *     correct DB row (artifacts.eights_memory_id, runs.eights_episodic_handle,
 *     verdicts.eights_memory_id). The row may have been deleted by the time
 *     the back-write fires; we use UPDATE … WHERE id = ?, which silently
 *     no-ops in that case.
 *   - Cell tagging happens inline at artifact time. Content is truncated to
 *     CLASSIFY_MAX_CHARS to keep classifier prompts cheap.
 *   - All calls go through eights-client.ts and inherit its graceful-
 *     degradation behavior (no peer → all returns null → no DB updates →
 *     pp continues exactly as today).
 *
 * The shape of memory writes mirrors the table in the integration plan:
 *
 *   start_run        → episode    cell=context    handle=pp:run:<run_id>
 *   archive_artifact → artifact   cell=classified handle=pp:artifact:<sha>
 *   record_verdict   → evaluation cell=focus|risk handle=pp:verdict:<id>
 *   smoke fail       → incident   cell=risk       handle=pp:smoke:<run_id>
 *   finalize_run     → summary    cell=vision     handle=pp:run:<id>:final
 *                                                 supersedes prior partials
 *   missability fail → incident   cell=triggers   handle=pp:missability:…
 */

import { db } from "../db/database.js";
import { log } from "../util/logger.js";
import { DEFAULT_CELL, type EightCell } from "../config.js";
import {
  memory,
  cells,
  constitution,
  audit,
  envelopeFor,
  type EightsEnvelope,
} from "./eights-client.js";

/** Max characters of artifact content passed to cells.classify. */
const CLASSIFY_MAX_CHARS = 2_000;

/** Max characters of any field embedded in a memory.add content payload. */
const MEMORY_CONTENT_MAX_CHARS = 8_000;

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, n) + `\n…[truncated ${s.length - n} chars]`;
}

/** In-process cache: SHA256 → classified cell. Same content always yields
 *  the same tag, so we never re-classify identical artifacts. */
const cellCacheBySha = new Map<string, EightCell>();

// ─── Write path ──────────────────────────────────────────────────────────

export type RunStartContext = {
  run_id: string;
  project_path: string;
  request_text: string;
  mode: string;
  team: string | null;
  forum: string | null;
  hydra_workflow_id: string | null;
  hydra_origin_squad: string | null;
};

/** Open episode for a starting run. Stored handle: pp:run:<run_id>. */
export async function writeRunStartEpisode(ctx: RunStartContext): Promise<void> {
  try {
    const env = envelopeFor({ run_id: ctx.run_id, project_path: ctx.project_path });
    const content = [
      `# pp run started`,
      ``,
      `**run_id**: ${ctx.run_id}`,
      `**project**: ${ctx.project_path}`,
      `**mode**: ${ctx.mode}`,
      ctx.team   ? `**team**: ${ctx.team}`     : null,
      ctx.forum  ? `**forum**: ${ctx.forum}`   : null,
      ctx.hydra_workflow_id
        ? `**hydra**: workflow=${ctx.hydra_workflow_id} origin=${ctx.hydra_origin_squad ?? "?"}`
        : null,
      ``,
      `## Request`,
      ``,
      truncate(ctx.request_text, MEMORY_CONTENT_MAX_CHARS),
    ]
      .filter(line => line !== null)
      .join("\n");

    const result = await memory.add({
      envelope: env,
      content,
      // TheEights MemoryType: a run lifecycle event is an "episodic" memory.
      type: "episodic",
      summary: truncate(ctx.request_text.split("\n")[0] ?? "", 200),
      scopes: ["pp:kind:episode"],
      provenance: { run_id: ctx.run_id, actor: "pp-daemon" },
      cell: "context",
      handle: `pp:run:${ctx.run_id}`,
    });
    if (result?.id) {
      try {
        db().prepare(`UPDATE runs SET eights_episodic_handle = ? WHERE id = ?`)
          .run(result.handle ?? `pp:run:${ctx.run_id}`, ctx.run_id);
      } catch (err) {
        log.debug({ err, run_id: ctx.run_id }, "back-write eights_episodic_handle failed");
      }
    }
  } catch (err) {
    log.debug({ err, run_id: ctx.run_id }, "writeRunStartEpisode swallowed");
  }
}

export type ArtifactWriteContext = {
  run_id: string;
  artifact_id: string;
  project_path: string;
  relative_path: string;
  taxonomy_section: string | null;
  kind: string | null;
  sha256: string;
  content_for_classification: string;
  // T6 — audit chain context. Parent artifact ids are derived by the
  // caller from prior artifacts of the same run (spec→architecture→
  // contract→code→test). Optional generator metadata from the most
  // recent attempt on the stage. Null when unknown.
  parent_artifact_ids?: string[];
  generator_agent?: string | null;
  model_id?: string | null;
};

/**
 * Classify + record the artifact as a memory. Result columns are
 * back-written to artifacts row asynchronously.
 */
export async function writeArtifactMemory(ctx: ArtifactWriteContext): Promise<void> {
  try {
    const env = envelopeFor({ run_id: ctx.run_id, project_path: ctx.project_path });

    // Step 1: classify cell (cached by sha256 to avoid redundant LLM calls).
    let cell: EightCell = cellCacheBySha.get(ctx.sha256) ?? DEFAULT_CELL;
    if (!cellCacheBySha.has(ctx.sha256)) {
      const classified = await cells.classify({
        envelope: env,
        text: truncate(ctx.content_for_classification, CLASSIFY_MAX_CHARS),
        summary: `${ctx.kind ?? "artifact"} @ ${ctx.relative_path}`,
      });
      if (classified?.cell) {
        cell = classified.cell;
        cellCacheBySha.set(ctx.sha256, cell);
      }
    }

    // Step 2: write memory.
    const memContent = [
      `# pp artifact`,
      ``,
      `**run_id**: ${ctx.run_id}`,
      `**path**: ${ctx.relative_path}`,
      ctx.kind ? `**kind**: ${ctx.kind}` : null,
      ctx.taxonomy_section ? `**taxonomy**: ${ctx.taxonomy_section}` : null,
      `**sha256**: ${ctx.sha256}`,
      ``,
      truncate(ctx.content_for_classification, MEMORY_CONTENT_MAX_CHARS),
    ]
      .filter(l => l !== null)
      .join("\n");

    const result = await memory.add({
      envelope: env,
      content: memContent,
      // TheEights MemoryType has no "artifact" member; a code/spec artifact is
      // durable knowledge → "semantic". (enum: working|episodic|semantic|
      // procedural|meta)
      type: "semantic",
      summary: `${ctx.kind ?? "artifact"} @ ${ctx.relative_path}`,
      provenance: { run_id: ctx.run_id, actor: "pp-daemon", source_uri: ctx.relative_path },
      cell,
      handle: `pp:artifact:${ctx.sha256.slice(0, 16)}`,
    });

    // Step 3: back-write to artifacts row. Always write cell (even if memory
    // failed) since cells.classify may have succeeded independently.
    try {
      db()
        .prepare(
          `UPDATE artifacts
              SET cell = ?, eights_memory_id = ?, eights_handle = ?
            WHERE id = ?`
        )
        .run(
          cell,
          result?.id ?? null,
          result?.handle ?? null,
          ctx.artifact_id,
        );
    } catch (err) {
      log.debug({ err, artifact_id: ctx.artifact_id }, "back-write artifact cell/eights failed");
    }

    // Step 4 (T6): artifact provenance lives in the memory write above
    // (provenance.run_id + source_uri + the pp:artifact:<sha> handle). TheEights'
    // `eights.audit.trace` is a READ/query tool over the event ledger
    // (TraceArgs: {trace_id?, run_id?, kind?, limit}) — it does NOT ingest
    // (:Run)-[:PRODUCED]->(:Artifact) edges, so we no longer call it here.
    // The audit chain itself is materialized on demand via `audit.bom(run_id)`.
    void ctx.parent_artifact_ids; // retained on the context for bom materialization
  } catch (err) {
    log.debug({ err, artifact_id: ctx.artifact_id }, "writeArtifactMemory swallowed");
  }
}

export type VerdictWriteContext = {
  run_id: string;
  verdict_id: string;
  attempt_id: string;
  stage_kind: string;        // e.g., "code" | "spec" — used for cross-run reflexion search
  project_path: string;
  judge_producer: string;
  judge_model_id: string;
  rubric_id: string | null;
  outcome: "pass" | "fail" | "revise";
  critique_md: string | null;
  cross_vendor: boolean;
};

export async function writeVerdictMemory(ctx: VerdictWriteContext): Promise<void> {
  try {
    const env = envelopeFor({ run_id: ctx.run_id, project_path: ctx.project_path });
    const cell: EightCell = ctx.outcome === "pass" ? "focus" : "risk";
    const summary = `${ctx.outcome.toUpperCase()} ${ctx.stage_kind} via ${ctx.judge_producer}/${ctx.judge_model_id}`;
    const content = [
      `# pp verdict`,
      ``,
      `**run_id**: ${ctx.run_id}`,
      `**attempt_id**: ${ctx.attempt_id}`,
      `**stage_kind**: ${ctx.stage_kind}`,
      `**outcome**: ${ctx.outcome}`,
      `**judge**: ${ctx.judge_producer}/${ctx.judge_model_id}${ctx.cross_vendor ? " (cross-vendor)" : ""}`,
      ctx.rubric_id ? `**rubric**: ${ctx.rubric_id}` : null,
      ``,
      ctx.critique_md ? truncate(ctx.critique_md, MEMORY_CONTENT_MAX_CHARS) : "(no critique body)",
    ]
      .filter(l => l !== null)
      .join("\n");

    const result = await memory.add({
      envelope: env,
      content,
      // A judge verdict is a meta-cognitive memory (reflection over an attempt).
      type: "meta",
      summary,
      provenance: { run_id: ctx.run_id, actor: "pp-daemon", model: ctx.judge_model_id },
      cell,
      // The stage_kind scope is critical for cross-run reflexion lookups
      // — list_prior_critiques will search memories scoped to it. The
      // pp:kind:evaluation scope replaces the old (invalid) type="evaluation".
      scopes: ["public", "pp:kind:evaluation", `stage:${ctx.stage_kind}`, `outcome:${ctx.outcome}`],
      handle: `pp:verdict:${ctx.verdict_id}`,
    });
    if (result?.id) {
      try {
        db().prepare(`UPDATE verdicts SET eights_memory_id = ? WHERE id = ?`)
          .run(result.id, ctx.verdict_id);
      } catch (err) {
        log.debug({ err, verdict_id: ctx.verdict_id }, "back-write verdict eights_memory_id failed");
      }
    }
  } catch (err) {
    log.debug({ err, verdict_id: ctx.verdict_id }, "writeVerdictMemory swallowed");
  }
}

export type RunSummaryContext = {
  run_id: string;
  project_path: string;
  status: string;
  summary_md: string | null;
};

/**
 * Submit a constitution attestation for a release/retirement run. Returns
 * the attestation id when TheEights ack'd, null otherwise. Caller is
 * expected to back-write the id onto runs.constitution_attestation_id.
 *
 * Local SHA drift is enforced by the missability check, NOT here — this
 * is the audit trail submission only. A null return is non-fatal.
 */
export async function attestConstitution(params: {
  run_id: string;
  project_path: string;
  constitution_sha: string;
  artifact_shas: string[];
}): Promise<{ attestation_id: string; verdict: "pass" | "fail" } | null> {
  try {
    const env = envelopeFor({ run_id: params.run_id, project_path: params.project_path });
    // TheEights AttestArgs is { envelope, consumer } — it binds the pp consumer
    // to the current constitution and returns a hash-chained receipt. The
    // local artifact-sha + constitution-sha drift check is enforced by pp's
    // missability check (authoritative); this is the audit-trail submission.
    const result = await constitution.attest({
      envelope: env,
      consumer: "pp",
    });
    return result;
  } catch {
    return null;
  }
}

/**
 * Materialize a SLSA-style Bill of Attestations rooted at the run.
 * Returns the bom handle when TheEights ack'd, null otherwise. Caller
 * back-writes runs.audit_bom_handle on success.
 */
export async function materializeAuditBom(
  run_id: string,
  project_path?: string,
): Promise<{ bom_handle: string } | null> {
  try {
    const env = envelopeFor({ run_id, project_path: project_path ?? run_id });
    return await audit.bom(env, run_id);
  } catch {
    return null;
  }
}

/**
 * Verify the audit chain for a past run. Returns null when TheEights is
 * unavailable (callers MUST treat null as "could not verify", not "verified").
 * Returns `{ verified: true }` or `{ verified: false, broken_links }`.
 */
export async function verifyAuditChain(run_id: string): Promise<{ verified: boolean; broken_links?: string[] } | null> {
  try {
    // TheEights VerifyArgs is the empty object and verifies the FULL chain;
    // run_id is retained on the signature for caller ergonomics / logging.
    void run_id;
    return await audit.verify();
  } catch {
    return null;
  }
}

export async function writeRunSummary(ctx: RunSummaryContext): Promise<void> {
  try {
    const env = envelopeFor({ run_id: ctx.run_id, project_path: ctx.project_path });
    const handle = `pp:run:${ctx.run_id}:final`;
    const content = [
      `# pp run finalized`,
      ``,
      `**run_id**: ${ctx.run_id}`,
      `**status**: ${ctx.status}`,
      ``,
      ctx.summary_md ? truncate(ctx.summary_md, MEMORY_CONTENT_MAX_CHARS) : "(no summary body)",
    ].join("\n");

    // Summary supersedes the start-of-run episode for the same run_id.
    await memory.add({
      envelope: env,
      content,
      // Run summary supersedes the start episode → still an episodic memory.
      type: "episodic",
      summary: `${ctx.status} — ${ctx.run_id}`,
      scopes: ["pp:kind:summary"],
      provenance: { run_id: ctx.run_id, actor: "pp-daemon" },
      cell: "vision",
      handle,
      supersedes: [`pp:run:${ctx.run_id}`],
    });
  } catch (err) {
    log.debug({ err, run_id: ctx.run_id }, "writeRunSummary swallowed");
  }
}

export type IncidentContext = {
  run_id: string;
  project_path: string;
  kind: "smoke" | "missability";
  check_id?: string;          // for missability
  detail: string;             // human-readable
};

export async function writeIncidentMemory(ctx: IncidentContext): Promise<void> {
  try {
    const env = envelopeFor({ run_id: ctx.run_id, project_path: ctx.project_path });
    const cell: EightCell = ctx.kind === "missability" ? "triggers" : "risk";
    const handle =
      ctx.kind === "missability"
        ? `pp:missability:${ctx.check_id ?? "unknown"}:${ctx.run_id}`
        : `pp:smoke:${ctx.run_id}`;
    const content = [
      `# pp incident (${ctx.kind})`,
      ``,
      `**run_id**: ${ctx.run_id}`,
      ctx.check_id ? `**check_id**: ${ctx.check_id}` : null,
      ``,
      truncate(ctx.detail, MEMORY_CONTENT_MAX_CHARS),
    ]
      .filter(l => l !== null)
      .join("\n");

    await memory.add({
      envelope: env,
      content,
      // Incidents are episodic events; the "incident" facet is carried in scopes.
      type: "episodic",
      summary: `${ctx.kind} incident: ${ctx.check_id ?? ctx.run_id}`,
      scopes: ["pp:kind:incident", `pp:incident:${ctx.kind}`],
      provenance: { run_id: ctx.run_id, actor: "pp-daemon" },
      cell,
      handle,
    });
  } catch (err) {
    log.debug({ err, run_id: ctx.run_id, kind: ctx.kind }, "writeIncidentMemory swallowed");
  }
}

// ─── Read path: cross-run reflexion ──────────────────────────────────────

export type PriorCritique = {
  memory_id: string;
  summary: string;
  content: string;
  outcome: "pass" | "fail" | "revise" | "unknown";
  created_at: string | null;
  handle: string | null;
};

/**
 * Search TheEights for prior verdicts on the same stage_kind in the same
 * project. Used by the reflexion-coach agent to surface recurring critique
 * patterns across runs (Reflexion∞).
 */
export async function listPriorCritiques(params: {
  stage_kind: string;
  project_path: string;
  k?: number;
}): Promise<PriorCritique[]> {
  try {
    const env: EightsEnvelope = envelopeFor({
      run_id: "(query)",                // not tied to a specific run
      project_path: params.project_path,
    });
    const result = await memory.search({
      envelope: env,
      query: `verdicts and critiques for stage_kind=${params.stage_kind}`,
      k: params.k ?? 5,
      // Verdicts are written as type="meta" tagged pp:kind:evaluation + stage:<k>.
      types: ["meta"],
      scopes: ["pp:kind:evaluation", `stage:${params.stage_kind}`],
    });
    const rows = (result?.results ?? []) as Array<Record<string, unknown>>;
    return rows.map(r => ({
      memory_id:  String(r.id ?? ""),
      summary:    String(r.summary ?? ""),
      content:    String(r.content ?? ""),
      outcome:    normalizeOutcome(r),
      created_at: r.created_at ? String(r.created_at) : null,
      handle:     r.handle ? String(r.handle) : null,
    }));
  } catch (err) {
    log.debug({ err, stage_kind: params.stage_kind }, "listPriorCritiques swallowed");
    return [];
  }
}

function normalizeOutcome(row: Record<string, unknown>): PriorCritique["outcome"] {
  const scopes = (row.scopes ?? []) as unknown[];
  for (const s of scopes) {
    if (typeof s === "string") {
      if (s === "outcome:pass") return "pass";
      if (s === "outcome:fail") return "fail";
      if (s === "outcome:revise") return "revise";
    }
  }
  return "unknown";
}

// ─── Read path: project & request recall helpers (Phase B / T1.2) ────────

export type RecallSummary = {
  total_hits: number;
  prior_runs: number;
  incidents: number;
  evaluations: number;
  top: Array<{ handle: string | null; summary: string; type: string }>;
};

function summarizeRows(rows: Array<Record<string, unknown>>): RecallSummary {
  let prior_runs = 0, incidents = 0, evaluations = 0;
  for (const r of rows) {
    const t = String(r.type ?? "");
    if (t === "episode" || t === "summary") prior_runs += 1;
    else if (t === "incident") incidents += 1;
    else if (t === "evaluation") evaluations += 1;
  }
  return {
    total_hits: rows.length,
    prior_runs,
    incidents,
    evaluations,
    top: rows.slice(0, 5).map(r => ({
      handle: r.handle ? String(r.handle) : null,
      summary: String(r.summary ?? r.content ?? "").slice(0, 120),
      type: String(r.type ?? "unknown"),
    })),
  };
}

/**
 * SessionStart recall: pull recent memories for this project so the
 * operator's first turn has context about prior runs, open incidents,
 * and recurring patterns. Empty when TheEights is unreachable.
 */
export async function recallProjectContext(
  project_path: string,
  k: number = 10,
): Promise<RecallSummary | null> {
  try {
    const env = envelopeFor({ run_id: "(session-start)", project_path });
    const result = await memory.search({
      envelope: env,
      query: `recent activity in project ${env.project_id}`,
      k,
    });
    if (!result) return null;
    const rows = (result.results ?? []) as Array<Record<string, unknown>>;
    return summarizeRows(rows);
  } catch {
    return null;
  }
}

/**
 * UserPromptSubmit recall: semantic search on the user's prompt text.
 * Returns the top-K memories most relevant to what the user is asking
 * about right now. The triage classifier reads this context to better
 * understand whether the request resembles prior work.
 */
export async function recallByQuery(
  project_path: string,
  query: string,
  k: number = 5,
): Promise<RecallSummary | null> {
  try {
    const env = envelopeFor({ run_id: "(prompt)", project_path });
    const result = await memory.search({
      envelope: env,
      query,
      k,
    });
    if (!result) return null;
    const rows = (result.results ?? []) as Array<Record<string, unknown>>;
    return summarizeRows(rows);
  } catch {
    return null;
  }
}
