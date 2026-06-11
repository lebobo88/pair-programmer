import { nanoid } from "nanoid";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync, statSync, existsSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { execa } from "execa";
import { trackedExeca } from "../mcp/cli-runner.js";
import YAML from "yaml";
import { db, txImmediate } from "../db/database.js";
import { projectArtifactDir } from "../util/paths.js";
import {
  RunMode, RunStatus, StageStatus, AttemptStatus, VerdictOutcome, vendorFor,
  ClaudeTier, isClaudeTier,
} from "../config.js";
import { log } from "../util/logger.js";
import { scanForSecrets, SecretsFoundError } from "../security/secret-scan.js";
import { loadProjectProfile } from "./profiles.js";
import { applyMasterPlanPatch, ensureMasterPlan } from "./master-plan.js";
import { TAXONOMY_BY_ID, MASTER_PLAN_SECTIONS } from "./taxonomy.js";
import { ProjectLock, ProjectLockBusyError } from "../util/lock.js";
import { tmpdir } from "node:os";
import { DEFAULT_MODELS } from "../config.js";
import { codexCritique } from "../mcp/codex-server.js";
import { geminiCritique } from "../mcp/gemini-server.js";
import { describeJudgeCapabilities } from "./gates.js";
import { findPriorTestsPreStage, getLatestTddCheck, type TddCheckRow } from "./tdd-gate.js";
import {
  requiredValidatorsForStage,
  type ValidatorKind,
} from "./artifact-validators/validator-policy.js";
import {
  getLatestArtifactValidation,
  runArtifactValidator,
  type ArtifactValidationRow,
} from "./artifact-validators/index.js";
import { parseHydraContext, hydraContextSummary } from "../ecosystem/hydra-context.js";
import {
  writeRunStartEpisode,
  writeArtifactMemory,
  writeVerdictMemory,
  writeRunSummary,
  attestConstitution,
  materializeAuditBom,
} from "../ecosystem/eights-writes.js";
import { emitDecisionRecord } from "../ecosystem/hydra-envelopes.js";
import { analyzeAndPropose } from "./autogenesis-analyzer.js";
import { constitutionSha } from "./constitution.js";
import { getTeam } from "./teams.js";
import { getForum } from "./forums.js";

const now = () => new Date().toISOString();

export type StartRunInput = {
  request_text: string;
  project_path: string;
  mode: RunMode;
  team?: string;
  forum?: string;
  n?: number;
  session_id?: string;
  // v7 ecosystem fields (optional). When present, persisted on the runs row
  // and surfaced to sub-agent prompts via ${HYDRA_CONTEXT}.
  hydra_workflow_id?: string;
  hydra_envelope_id?: string;
  hydra_origin_squad?: string;
  hydra_envelope_type?: string;
};

export type StartRunOutput = {
  run_id: string;
  artifact_dir: string;
  started_at: string;
};

export async function startRun(input: StartRunInput): Promise<StartRunOutput> {
  const id = `run_${nanoid(12)}`;
  const startedAt = now();
  const dir = projectArtifactDir(input.project_path, id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "request.md"), `# Request\n\n${input.request_text}\n`, "utf8");

  // Best-effort per-project advisory lock. If another run holds it, surface
  // a clear error rather than silently letting two runs race the worktree.
  const lock = new ProjectLock(input.project_path);
  try {
    const ack = lock.acquireOrReapStale();
    if (ack.reaped) {
      log.info(
        { project_path: input.project_path, reaped_pid: ack.reaped.pid, reaped_started_at: ack.reaped.started_at },
        "reaped stale project lock at acquire",
      );
    }
  } catch (err) {
    if (err instanceof ProjectLockBusyError) {
      const h = err.holder;
      throw new Error(
        `another pp-daemon run holds the project lock at ${input.project_path}/.harness/.lock ` +
        (h ? `(pid=${h.pid}, started_at=${h.started_at}). ` : `(unparseable metadata). `) +
        `Wait for it to finish, or — if no run is active — remove the file.`
      );
    }
    throw err;
  }

  // Load profile.yaml and persist the snapshot. If absent, store null but
  // log so /pp:doctor can warn. If present, also write a profile_snapshot.yaml
  // artifact (matching the planned per-run layout).
  let profileSnapshotJson: string | null = null;
  let profileYamlText: string | null = null;
  try {
    const profilePath = join(input.project_path, ".harness", "profile.yaml");
    if (existsSync(profilePath)) {
      profileYamlText = readFileSync(profilePath, "utf8");
    }
    const profile = loadProjectProfile(input.project_path);
    if (profile) {
      profileSnapshotJson = JSON.stringify(profile);
      writeFileSync(
        join(dir, "profile_snapshot.yaml"),
        profileYamlText ?? YAML.stringify(profile),
        "utf8"
      );
    }
  } catch (err) {
    log.warn({ err }, "loadProjectProfile failed at start_run");
  }

  // Snapshot AGENTS.md / CLAUDE.md if present. The harness treats AGENTS.md as
  // the cross-tool behavioral contract and CLAUDE.md as its Claude-specific
  // import shim. We snapshot at run-start (rather than ensure-on-start) because
  // ensuring is a finalize-time concern — the run might not need to touch
  // either file, and the missability check (MC-21) prefers absence-as-evidence.
  try {
    const agentsPath = join(input.project_path, "AGENTS.md");
    if (existsSync(agentsPath)) {
      writeFileSync(join(dir, "agents_md_snapshot.md"), readFileSync(agentsPath, "utf8"), "utf8");
    }
    const claudePath = join(input.project_path, "CLAUDE.md");
    if (existsSync(claudePath)) {
      writeFileSync(join(dir, "claude_md_snapshot.md"), readFileSync(claudePath, "utf8"), "utf8");
    }
  } catch (err) {
    log.warn({ err }, "AGENTS.md/CLAUDE.md snapshot failed at start_run");
  }

  const headSha = await tryGitCommand(input.project_path, ["rev-parse", "HEAD"]);
  const dirty = await tryGitCommand(input.project_path, ["status", "--porcelain"]);
  const treeDirtyHash = dirty
    ? createHash("sha256").update(dirty).digest("hex").slice(0, 16)
    : null;

  const cliVersions = await captureCliVersions();

  // v7: lift Hydra context fields off the input. parseHydraContext returns
  // null when no workflow_id is set (standalone runs), in which case all
  // hydra_* columns persist as NULL and downstream behavior is unchanged.
  const hydraCtx = parseHydraContext(input);

  // T2: record the constitution SHA active at run-start, if any. Replays
  // bind to this SHA — they refuse to re-run a run if the constitution has
  // been amended since. Absence (no CONSTITUTION.md) is fine.
  const constitutionShaAtStart = constitutionSha(input.project_path);

  try {
    txImmediate(() => {
      db()
        .prepare(
          `INSERT INTO runs(
            id, session_id, project_path, request_text, team, mode, forum, n,
            status, profile_snapshot_json, taxonomy_mapping_json,
            head_sha, tree_dirty_hash, cli_versions_json, started_at,
            hydra_workflow_id, hydra_envelope_id, hydra_origin_squad, hydra_envelope_type,
            constitution_sha
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          id,
          input.session_id ?? null,
          input.project_path,
          input.request_text,
          input.team ?? null,
          input.mode,
          input.forum ?? null,
          input.n ?? null,
          "running" satisfies RunStatus,
          profileSnapshotJson,
          null,
          headSha,
          treeDirtyHash,
          JSON.stringify(cliVersions),
          startedAt,
          hydraCtx?.workflow_id ?? null,
          hydraCtx?.envelope_id ?? null,
          hydraCtx?.origin_squad ?? null,
          hydraCtx?.envelope_type ?? null,
          constitutionShaAtStart,
        );
    });
  } catch (err) {
    // Roll back the lock if the row never persisted.
    try { lock.release(); } catch { /* ignore */ }
    throw err;
  }

  // Fire-and-forget: record an episode in TheEights. Graceful-degradation
  // contract: this returns null silently when TheEights is offline, so we
  // don't await and pp never blocks on the ecosystem peer.
  void writeRunStartEpisode({
    run_id: id,
    project_path: input.project_path,
    request_text: input.request_text,
    mode: input.mode,
    team: input.team ?? null,
    forum: input.forum ?? null,
    hydra_workflow_id: hydraCtx?.workflow_id ?? null,
    hydra_origin_squad: hydraCtx?.origin_squad ?? null,
  });

  log.info(
    {
      run_id: id,
      project_path: input.project_path,
      mode: input.mode,
      profile: !!profileSnapshotJson,
      hydra: hydraContextSummary(hydraCtx),
    },
    "run started"
  );
  return { run_id: id, artifact_dir: dir, started_at: startedAt };
}

// ─── ensure_run ──────────────────────────────────────────────────────────
//
// P2: sub-agent run-context contract.
//
// Hydra dispatches generator sub-agents (architect, data-modeler,
// security-reviewer, release-planner, …) directly via Task. Those agents
// can call generate / archive_artifact / record_attempt against this MCP
// server but have no `run_id` of their own — `ensureRunOpen` rejects every
// persistence call.
//
// `ensureRun` gives the dispatcher a single idempotent entrypoint: pass
// project_path + request_text + optional kind, get back a run_id the
// dispatcher then forwards to its sub-agents in their prompt. If a run is
// already open on this project_path with the same kind (treated as the
// `team` column for storage), reuse it. Otherwise allocate a minimal
// "single"-mode run via startRun() so the lock + lifecycle bookkeeping is
// identical to /pp:run.

export type EnsureRunInput = {
  project_path: string;
  request_text: string;
  /** Logical bucket for the dispatcher's sub-agent fan-out. Stored on the
   *  `team` column so existing finalize/list machinery keeps working. */
  kind?: string;
};

export type EnsureRunOutput = {
  run_id: string;
  created: boolean;
  artifact_dir: string;
};

export async function ensureRun(input: EnsureRunInput): Promise<EnsureRunOutput> {
  const kind = input.kind ?? "ad-hoc";

  // Look for a still-open run on this project_path with matching team/kind.
  // Order by started_at DESC so we pick the most recent open run if there
  // happen to be multiple (which would itself be a lifecycle bug, but we
  // don't compound it by spawning more).
  const existing = db()
    .prepare(
      `SELECT id, project_path FROM runs
       WHERE project_path = ? AND team = ? AND status IN ('running','pending')
       ORDER BY started_at DESC LIMIT 1`
    )
    .get(input.project_path, kind) as { id: string; project_path: string } | undefined;

  if (existing) {
    const dir = projectArtifactDir(existing.project_path, existing.id);
    log.info(
      { run_id: existing.id, project_path: input.project_path, kind },
      "ensure_run: reusing open run"
    );
    return { run_id: existing.id, created: false, artifact_dir: dir };
  }

  // No open run for this (project_path, kind) — spin one up. We route through
  // startRun() so the project lock is acquired, the artifact dir is created,
  // and lifecycle hooks (eights episode write, etc.) fire just like /pp:run.
  const out = await startRun({
    request_text: input.request_text,
    project_path: input.project_path,
    mode: "single",
    team: kind,
  });
  log.info(
    { run_id: out.run_id, project_path: input.project_path, kind },
    "ensure_run: created minimal single-mode run for dispatched sub-agents"
  );
  return { run_id: out.run_id, created: true, artifact_dir: out.artifact_dir };
}

export type StartStageInput = {
  run_id: string;
  kind: string;
  gate_type: string;
};
export type StartStageOutput = { stage_id: string };

export function startStage(input: StartStageInput): StartStageOutput {
  ensureRunOpen(input.run_id);
  const id = `stage_${nanoid(10)}`;
  txImmediate(() => {
    db()
      .prepare(
        `INSERT INTO stages(id, run_id, kind, gate_type, status, started_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(id, input.run_id, input.kind, input.gate_type, "open" satisfies StageStatus, now());
  });
  return { stage_id: id };
}

/**
 * Engineer self-verification surface (R3-tail post-mortem, 2026-05-21).
 * The engineer agent's step-4.5 block produces these on Path A so the
 * cross-vendor judge in Fix 1.4 can reconcile self-claims against the
 * on-disk diff. All fields optional; legacy / non-engineer producers
 * omit the whole `notes` field.
 */
export type AttemptNotes = {
  /** Findings the engineer claims to have closed in this attempt. The
   * cross-vendor judge reads each entry's `lines` and confirms the cited
   * file:lines actually closes the named finding. Hallucinated entries
   * are caught by Fix 1.4's findings-provenance block. */
  findings_closed?: Array<{
    id: string;
    file: string;
    lines: string;
    claim: string;
  }>;
  /** Findings from the dispatch prompt the engineer did NOT close,
   * with the reason. Honest empty-handed report is better than a
   * fabricated `findings_closed` entry. */
  findings_unaddressed?: Array<{ id: string; reason: string }>;
  /** Anti-pattern matches the engineer self-grep caught in step 4.5(a).
   * If non-empty AND status !== "needs_review", the engineer lied —
   * the cross-vendor judge will catch it. */
  anti_pattern_hits?: Array<{ file: string; line: number; pattern: string }>;
  /** Path to a sha256 file produced in step 4.5(c), relative to project
   * root. The judge re-hashes the same files on read and flags drift. */
  touched_hashes_path?: string;
};

export type RecordAttemptInput = {
  stage_id: string;
  producer: string;
  model_id: string;
  prompt_hash?: string;
  artifact_path?: string;
  tokens_in?: number;
  tokens_out?: number;
  cost_usd?: number;
  wall_ms?: number;
  retry_index?: number;
  parent_attempt_id?: string;
  status?: AttemptStatus;
  attempt_slot_id?: string;
  /**
   * Resolved Claude tier for this attempt. Only meaningful when
   * producer === "claude"; ignored otherwise (the driver still records it
   * for Codex/Gemini attempts as `null` so the column is uniform).
   */
  attempted_tier?: ClaudeTier;
  /** Engineer self-verification surface; see AttemptNotes. */
  notes?: AttemptNotes;
  /**
   * Claude Code subagent_type the parent driver used to spawn the agent that
   * authored this attempt (e.g. "engineer", "spec-author", "designer"). Free
   * form so new typed agents don't require a schema change. The strict-mode
   * guard below rejects "general-purpose" unless PP_STRICT_AGENT_TYPE=0,
   * closing eights prop_885cc22f (2026-05-23 Hydra dispatch fix).
   */
  agent_type?: string;
};
export type RecordAttemptOutput = { attempt_id: string };

export function recordAttempt(input: RecordAttemptInput): RecordAttemptOutput {
  const stage = db()
    .prepare(`SELECT run_id FROM stages WHERE id = ?`)
    .get(input.stage_id) as { run_id: string } | undefined;
  if (!stage) throw new Error(`stage ${input.stage_id} not found`);

  // If an attempt_slot_id was pre-allocated by start_best_of_stage, use it
  // as the row id so the slot and the attempt share an identifier (which
  // makes downstream lookups by slot trivial). Re-calling record_attempt
  // for the same slot is idempotent — the existing row is returned without
  // double-counting budget tallies.
  const id = input.attempt_slot_id ?? `attempt_${nanoid(10)}`;

  if (input.attempt_slot_id) {
    const existing = db()
      .prepare(`SELECT id, model_id, tokens_in, tokens_out, cost_usd FROM attempts WHERE id = ?`)
      .get(id) as { id: string; model_id: string; tokens_in: number | null; tokens_out: number | null; cost_usd: number | null } | undefined;
    if (existing) {
      log.debug({ attempt_slot_id: id }, "record_attempt idempotent re-call on existing slot");
      return { attempt_id: existing.id };
    }
  }

  // attempted_tier is opt-in; reject obviously-wrong values rather than
  // silently dropping them, because cost-by-tier analytics depend on it.
  const tier = input.attempted_tier;
  if (tier !== undefined && !isClaudeTier(tier)) {
    throw new Error(
      `record_attempt: attempted_tier="${tier}" is not a valid ClaudeTier. Use "opus" | "sonnet" | "haiku" or omit.`
    );
  }

  // 2026-05-23 Hydra dispatch fix (eights prop_885cc22f). Reject
  // agent_type="general-purpose" by default. Production stages MUST be
  // authored by a typed agent — the "general-purpose" subagent has no
  // archival/record contract with the harness, so accepting it here would
  // silently erase replay provenance and disable evolution proposals
  // tied to agent-type behavior. Set PP_STRICT_AGENT_TYPE=0 in the
  // environment to opt out (e.g. for exploratory non-stage runs).
  if (
    input.agent_type === "general-purpose" &&
    process.env.PP_STRICT_AGENT_TYPE !== "0"
  ) {
    throw new Error(
      `record_attempt: agent_type="general-purpose" is rejected by strict mode. ` +
      `Production stages MUST be authored by a typed Claude Code subagent ` +
      `(engineer, spec-author, architect, designer, api-designer, ` +
      `security-reviewer, data-modeler, ops-author, governance-author, ` +
      `release-planner, retirement-planner, ai-controls-author, ` +
      `design-system-curator, strategy-author, discovery-researcher, ` +
      `docs-author, test-strategist, …). The "general-purpose" subagent ` +
      `has no harness contract — recording it erases replay provenance ` +
      `and disables agent-type-tied evolution proposals. ` +
      `If the typed agent appears to lack a required tool, surface an ` +
      `HITL with reason="agent_tool_surface_mismatch" instead of ` +
      `downgrading. To opt out (exploratory only), set ` +
      `PP_STRICT_AGENT_TYPE=0. Closes eights prop_885cc22f.`
    );
  }

  txImmediate(() => {
    db()
      .prepare(
        `INSERT INTO attempts(
          id, stage_id, producer, model_id, prompt_hash, artifact_path,
          tokens_in, tokens_out, cost_usd, wall_ms,
          retry_index, parent_attempt_id, status, attempted_tier, notes_json, agent_type, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        input.stage_id,
        input.producer,
        input.model_id,
        input.prompt_hash ?? null,
        input.artifact_path ?? null,
        input.tokens_in ?? null,
        input.tokens_out ?? null,
        input.cost_usd ?? null,
        input.wall_ms ?? null,
        input.retry_index ?? 0,
        input.parent_attempt_id ?? null,
        (input.status ?? "ok") satisfies AttemptStatus,
        tier ?? null,
        input.notes ? JSON.stringify(input.notes) : null,
        input.agent_type ?? null,
        now()
      );

    if (input.tokens_in || input.tokens_out || input.cost_usd) {
      tallyBudgets(
        stage.run_id,
        input.model_id,
        tier ?? null,
        input.tokens_in ?? 0,
        input.tokens_out ?? 0,
        input.cost_usd ?? 0,
      );
    }
  });

  return { attempt_id: id };
}

/**
 * R3-tail post-mortem Fix 1.4 (2026-05-21): validate that every finding the
 * judge cited in `score_json.findings_provenance` quotes text that ACTUALLY
 * appears in the cited file. Drift = the judge fabricated the citation.
 *
 * The check is best-effort and read-only — it doesn't block the verdict
 * insert (the operator can still see the critique and decide), but it
 * sets `hallucination_suspected = 1` on the verdict row so downstream
 * gates can surface the smell.
 */
function validateFindingsProvenance(args: {
  score_json: unknown;
  attempt_id: string;
}): { hallucination_suspected: boolean; details_json: string | null } {
  const score = args.score_json;
  if (!score || typeof score !== "object") {
    return { hallucination_suspected: false, details_json: null };
  }
  const provenance = (score as { findings_provenance?: unknown }).findings_provenance;
  if (!Array.isArray(provenance) || provenance.length === 0) {
    return { hallucination_suspected: false, details_json: null };
  }

  // Resolve project_path via the attempt → stage → run join. Best-effort:
  // if the lookup misses, we skip validation (don't fail the verdict).
  const projectRow = db()
    .prepare(
      `SELECT runs.project_path AS project_path
         FROM attempts
         JOIN stages ON stages.id = attempts.stage_id
         JOIN runs   ON runs.id   = stages.run_id
        WHERE attempts.id = ?`,
    )
    .get(args.attempt_id) as { project_path: string } | undefined;
  if (!projectRow) {
    return { hallucination_suspected: false, details_json: null };
  }

  const misses: Array<{
    id: string;
    file: string;
    line?: number;
    quoted_text: string;
    reason: string;
  }> = [];

  for (const entry of provenance) {
    if (!entry || typeof entry !== "object") continue;
    const e = entry as {
      id?: unknown; file?: unknown; line?: unknown;
      quoted_text?: unknown; claim?: unknown;
    };
    const id = typeof e.id === "string" ? e.id : "<unknown-id>";
    const file = typeof e.file === "string" ? e.file : null;
    const line = typeof e.line === "number" ? e.line : undefined;
    const quoted = typeof e.quoted_text === "string" ? e.quoted_text : null;

    if (!file || !quoted) {
      misses.push({
        id, file: file ?? "<missing>", line, quoted_text: quoted ?? "",
        reason: "entry missing file or quoted_text",
      });
      continue;
    }
    if (quoted.trim().length < 8) {
      // Too-short quotes match too much by chance; reject as smell.
      misses.push({ id, file, line, quoted_text: quoted, reason: "quoted_text shorter than 8 chars" });
      continue;
    }
    // Reject obvious path-traversal in `file` — judge agents must cite
    // project-relative paths.
    if (file.includes("..") || file.startsWith("/") || /^[A-Za-z]:[\\\/]/.test(file)) {
      misses.push({ id, file, line, quoted_text: quoted, reason: "file is not project-relative" });
      continue;
    }
    let text = "";
    try {
      const abs = join(projectRow.project_path, file);
      if (existsSync(abs)) text = readFileSync(abs, "utf8");
    } catch {
      misses.push({ id, file, line, quoted_text: quoted, reason: "file read failed" });
      continue;
    }
    if (!text) {
      misses.push({ id, file, line, quoted_text: quoted, reason: "file empty or unreadable" });
      continue;
    }
    if (!text.includes(quoted)) {
      misses.push({
        id, file, line, quoted_text: quoted,
        reason: "quoted_text not found in file (substring miss)",
      });
    }
  }

  if (misses.length === 0) {
    return { hallucination_suspected: false, details_json: null };
  }
  return {
    hallucination_suspected: true,
    details_json: JSON.stringify({
      total_provenance_entries: provenance.length,
      misses,
    }),
  };
}

export type RecordVerdictInput = {
  attempt_id: string;
  judge_producer: string;
  judge_model_id: string;
  rubric_id?: string;
  outcome: VerdictOutcome;
  critique_md?: string;
  score_json?: unknown;
};
export type RecordVerdictOutput = { verdict_id: string; cross_vendor: boolean };

export function recordVerdict(input: RecordVerdictInput): RecordVerdictOutput {
  const id = `verdict_${nanoid(10)}`;
  const att = db()
    .prepare(`SELECT producer, model_id FROM attempts WHERE id = ?`)
    .get(input.attempt_id) as { producer: string; model_id: string } | undefined;
  if (!att) throw new Error(`attempt ${input.attempt_id} not found`);

  const CODEX_CRITIQUE_ALLOWED = new Set<string>([
    DEFAULT_MODELS.codex_critique,
    DEFAULT_MODELS.codex_critique_escalated,
  ]);
  if (input.judge_producer === "codex" && !CODEX_CRITIQUE_ALLOWED.has(input.judge_model_id)) {
    throw new Error(
      `judge_producer=codex must record judge_model_id in ` +
      `{${[...CODEX_CRITIQUE_ALLOWED].join(", ")}} ` +
      `because pp_codex.critique is pinned to those models (default or escalated)`
    );
  }
  if (input.judge_producer === "gemini" && input.judge_model_id !== DEFAULT_MODELS.gemini_critique) {
    throw new Error(
      `judge_producer=gemini must record judge_model_id="${DEFAULT_MODELS.gemini_critique}" ` +
      `because pp_gemini.critique is hard-pinned to that model`
    );
  }
  if (att.producer === input.judge_producer && att.model_id === input.judge_model_id && att.producer !== "gemini") {
    throw new Error(
      `same-vendor verdict requires different model ids for producer=${att.producer}: ` +
      `generator=${att.model_id}, judge=${input.judge_model_id}`
    );
  }

  const genVendor = vendorFor(att.producer);
  const judgeVendor = vendorFor(input.judge_producer);
  const crossVendor = !!(genVendor && judgeVendor && genVendor !== judgeVendor);

  // R3-tail post-mortem Fix 1.4 (2026-05-21): validate findings_provenance.
  // The judge agent emits `findings_provenance: [{id, file, line, quoted_text, claim}]`
  // inside score_json. For each entry, we re-load the cited file from the
  // attempt's project root and confirm `quoted_text` appears verbatim. Any
  // miss = the judge fabricated a citation. We don't auto-retract — the
  // operator can choose via Fix 1.3 — but we flag the verdict so downstream
  // gates can surface it.
  const provenanceCheck = validateFindingsProvenance({
    score_json: input.score_json,
    attempt_id: input.attempt_id,
  });

  txImmediate(() => {
    db()
      .prepare(
        `INSERT INTO verdicts(
          id, attempt_id, judge_producer, judge_model_id, rubric_id,
          outcome, critique_md, score_json, cross_vendor,
          hallucination_suspected, hallucination_details,
          created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        input.attempt_id,
        input.judge_producer,
        input.judge_model_id,
        input.rubric_id ?? null,
        input.outcome,
        input.critique_md ?? null,
        input.score_json ? JSON.stringify(input.score_json) : null,
        crossVendor ? 1 : 0,
        provenanceCheck.hallucination_suspected ? 1 : 0,
        provenanceCheck.details_json,
        now()
      );
  });

  // Fire-and-forget: record the verdict as an evaluation memory. The
  // wrapper joins back to stage_kind + project_path so cross-run reflexion
  // searches (list_prior_critiques) can scope by stage type.
  const stageJoin = db()
    .prepare(
      `SELECT stages.kind AS stage_kind, runs.project_path AS project_path, runs.id AS run_id
         FROM attempts
         JOIN stages ON stages.id = attempts.stage_id
         JOIN runs   ON runs.id   = stages.run_id
        WHERE attempts.id = ?`
    )
    .get(input.attempt_id) as
    | { stage_kind: string; project_path: string; run_id: string }
    | undefined;
  if (stageJoin) {
    void writeVerdictMemory({
      run_id: stageJoin.run_id,
      verdict_id: id,
      attempt_id: input.attempt_id,
      stage_kind: stageJoin.stage_kind,
      project_path: stageJoin.project_path,
      judge_producer: input.judge_producer,
      judge_model_id: input.judge_model_id,
      rubric_id: input.rubric_id ?? null,
      outcome: input.outcome,
      critique_md: input.critique_md ?? null,
      cross_vendor: crossVendor,
    });
  }

  return { verdict_id: id, cross_vendor: crossVendor };
}

/**
 * R3-tail post-mortem Fix 1.3 (2026-05-21). Mark a prior verdict as
 * retracted because subsequent evidence (typically another cross-vendor
 * judge or operator review) showed it was wrong. The verdict row stays
 * in the DB for audit, but its outcome is no longer considered by:
 *   - finalize_stage's latest-verdict-fail check
 *   - replay queries that walk verdicts in time order
 *   - the cross-vendor re-judge gate (Fix 0.2) when looking up
 *     "is there already a cross-vendor verdict on this attempt"
 *
 * Typical R3-tail cases this addresses:
 *   - Codex flagged optional Idempotency-Key as wrong (HTTP-standard-
 *     reading bias; Stripe / GitHub / Square treat it as optional too).
 *   - Gemini hallucinated 5 missing baseline fixes that were never
 *     scoped in the dispatch prompt.
 * Both verdicts were permanently recorded with no path to mark them
 * wrong. This function provides that path.
 */
export type RetractVerdictInput = {
  verdict_id: string;
  reason: string;                                      // operator-readable rationale
  superseded_by?: string;                              // verdict_id of the replacement
};
export type RetractVerdictOutput = { verdict_id: string; retracted_at: string };

export class VerdictNotFound extends Error {
  constructor(message: string, public readonly verdict_id: string) {
    super(message);
    this.name = "VerdictNotFound";
  }
}

export class VerdictAlreadyRetracted extends Error {
  constructor(message: string, public readonly verdict_id: string, public readonly prior_reason: string) {
    super(message);
    this.name = "VerdictAlreadyRetracted";
  }
}

export function retractVerdict(input: RetractVerdictInput): RetractVerdictOutput {
  const existing = db()
    .prepare(`SELECT id, retracted_at, retracted_reason FROM verdicts WHERE id = ?`)
    .get(input.verdict_id) as
      | { id: string; retracted_at: string | null; retracted_reason: string | null }
      | undefined;
  if (!existing) {
    throw new VerdictNotFound(`verdict ${input.verdict_id} not found`, input.verdict_id);
  }
  if (existing.retracted_at) {
    // Idempotent: re-retracting with the same reason is a no-op. Different
    // reason is an error so the audit trail stays clean.
    if (existing.retracted_reason === input.reason) {
      return { verdict_id: existing.id, retracted_at: existing.retracted_at };
    }
    throw new VerdictAlreadyRetracted(
      `verdict ${input.verdict_id} was already retracted with reason "${existing.retracted_reason}". ` +
      `Refusing to overwrite with a different reason. Add a follow-up record instead.`,
      input.verdict_id,
      existing.retracted_reason ?? "",
    );
  }
  if (!input.reason || input.reason.trim().length < 8) {
    throw new Error(
      `retract_verdict requires a non-empty reason (>= 8 chars). ` +
      `R3-tail post-mortem: retractions without rationale are how the audit trail rots.`,
    );
  }
  const ts = now();
  txImmediate(() => {
    db()
      .prepare(
        `UPDATE verdicts
            SET retracted_at = ?, retracted_reason = ?, superseded_by = ?
          WHERE id = ?`,
      )
      .run(ts, input.reason, input.superseded_by ?? null, input.verdict_id);
  });
  return { verdict_id: input.verdict_id, retracted_at: ts };
}

export type FinalizeStageInput = {
  stage_id: string;
  winner_attempt_id?: string;
  status: StageStatus;
};

export type StageFinalizeNextAction =
  | "finalize_passed"
  | "run_tdd_pre_check"
  | "run_tdd_post_check"
  | "run_artifact_validate"
  | "retry_with_critique"
  | "retry_or_surface"
  | "surface_stage"
  | "dispatch_cross_vendor_rejudge";

export type StageFinalizeTddBlocker = {
  gate: "tdd";
  phase: "pre" | "post";
  status: "missing" | "violation" | "execution_error";
  next_action: "run_tdd_pre_check" | "run_tdd_post_check" | "retry_or_surface" | "surface_stage";
  message: string;
  check: TddCheckRow | null;
  prior_stage_id?: string;
};

export type StageFinalizeArtifactBlocker = {
  gate: "artifact_validation";
  validator_kind: ValidatorKind;
  status: "missing" | "violation" | "execution_error";
  next_action: "run_artifact_validate" | "retry_or_surface" | "surface_stage";
  message: string;
  artifact_id: string;
  artifact_kind: string | null;
  artifact_path: string;
  check: ArtifactValidationRow | null;
};

export type StageFinalizeVerdictBlocker = {
  gate: "verdict";
  next_action: "retry_with_critique" | "surface_stage";
  message: string;
  attempt_id: string;
  verdict_id: string;
  outcome: VerdictOutcome;
};

/**
 * Mandatory cross-vendor re-judge gate (R3-tail post-mortem, Fix 0.2).
 * Surfaced when an engineer self-reports closure of named findings
 * (`notes.findings_closed` non-empty in record_attempt) AND no
 * cross-vendor verdict exists on that attempt yet. Forces an independent
 * re-judge before finalize_passed is allowed — the R3-tail incident
 * shipped `void idempotencyKey; // explicit no-op` because the engineer's
 * self-report was never independently verified.
 */
export type StageFinalizeRejudgeBlocker = {
  gate: "findings_closure_rejudge";
  next_action: "dispatch_cross_vendor_rejudge" | "surface_stage";
  message: string;
  attempt_id: string;
  finding_ids: string[];
};

/**
 * PP-VG-3: Browser validation persisted severity="errors" on this stage —
 * unexpected 4xx/5xx network errors or fail-status findings were recorded.
 */
export type StageFinalizeBrowserValidationBlocker = {
  gate: "browser_validation";
  next_action: "surface_stage";
  message: string;
  severity: "errors";
};

/**
 * PP-VG-6: A verdict on an attempt for this stage has hallucination_suspected=1
 * but lacks a linked cross-vendor resolution. Same-vendor clean verdicts do NOT
 * clear the suspicion — only a retraction of the suspect verdict or a subsequent
 * cross_vendor=1 non-fail verdict on the SAME attempt clears it.
 */
export type StageFinalizeHallucinationBlocker = {
  gate: "hallucination";
  next_action: "dispatch_cross_vendor_rejudge";
  message: string;
  attempt_id: string;
  verdict_id: string;
};

export type StageFinalizeBlocker =
  | StageFinalizeTddBlocker
  | StageFinalizeArtifactBlocker
  | StageFinalizeVerdictBlocker
  | StageFinalizeRejudgeBlocker
  | StageFinalizeBrowserValidationBlocker
  | StageFinalizeHallucinationBlocker;

export type StageFinalizeReadiness = {
  stage_id: string;
  stage_kind: string;
  can_pass: boolean;
  recommended_status: "passed" | "surfaced";
  next_action: StageFinalizeNextAction;
  blockers: StageFinalizeBlocker[];
  summary: string;
};

export class TddGateViolation extends Error {
  constructor(
    message: string,
    public readonly stage_id: string,
    public readonly phase: "pre" | "post",
    public readonly check: ReturnType<typeof getLatestTddCheck>,
  ) {
    super(message);
    this.name = "TddGateViolation";
  }
}

export class VerdictGateViolation extends Error {
  constructor(
    message: string,
    public readonly stage_id: string,
    public readonly attempt_id: string,
    public readonly verdict_id: string,
    public readonly outcome: VerdictOutcome,
  ) {
    super(message);
    this.name = "VerdictGateViolation";
  }
}

export class ValidatorGateViolation extends Error {
  constructor(
    message: string,
    public readonly stage_id: string,
    public readonly validator_kind: ValidatorKind,
    public readonly artifact_id: string | null,
    public readonly check: ArtifactValidationRow | null,
  ) {
    super(message);
    this.name = "ValidatorGateViolation";
  }
}

/**
 * PP-VG-2: A required artifact kind had zero archived rows RUN-WIDE when
 * finalizing as "complete". Required kinds are resolved from the run's
 * persisted taxonomy_mapping_json and profile_snapshot_json (NOT from the
 * live filesystem). Missing/malformed snapshots are treated as fail-closed.
 */
export class ArtifactAvailabilityGateViolation extends Error {
  constructor(
    message: string,
    public readonly run_id: string,
    public readonly required_kind: string,
  ) {
    super(message);
    this.name = "ArtifactAvailabilityGateViolation";
  }
}

/**
 * R3-tail post-mortem Fix 0.2: mandatory cross-vendor re-judge after
 * any engineer attempt that self-reports findings_closed. Without an
 * independent verdict from a different vendor, finalize_passed is
 * refused. The R3-tail δ envelope shipped a literal
 * `void idempotencyKey; // explicit no-op` claimed as "Idempotency-Key
 * support implemented" because no judge cross-checked the engineer's
 * self-report. This gate makes that escape mode unreachable.
 */
export class FindingsClosureRejudgeRequired extends Error {
  constructor(
    message: string,
    public readonly stage_id: string,
    public readonly attempt_id: string,
    public readonly finding_ids: string[],
  ) {
    super(message);
    this.name = "FindingsClosureRejudgeRequired";
  }
}

export function getStageFinalizeReadiness(stage_id: string): StageFinalizeReadiness {
  const stageRow = db()
    .prepare(`SELECT id, kind FROM stages WHERE id = ?`)
    .get(stage_id) as { id: string; kind: string } | undefined;
  if (!stageRow) throw new Error(`stage ${stage_id} not found`);

  const blockers: StageFinalizeBlocker[] = [];

  if (stageRow.kind === "tests_pre") {
    const check = getLatestTddCheck(stage_id, "pre");
    if (!check || check.status !== "verified") {
      blockers.push(buildTddFinalizeBlocker({ stage_id, phase: "pre", check }));
    }
  } else if (stageRow.kind === "code") {
    const prior = findPriorTestsPreStage(stage_id);
    if (prior) {
      const check = getLatestTddCheck(stage_id, "post");
      if (!check || check.status !== "verified") {
        blockers.push(buildTddFinalizeBlocker({ stage_id, phase: "post", check, prior_stage_id: prior.stage_id }));
      }
    }
  }

  const reqs = requiredValidatorsForStage(stage_id);
  for (const req of reqs) {
    for (const vk of req.validators) {
      const av = getLatestArtifactValidation(stage_id, vk, req.artifact_id);
      if (!av || av.status === "violation" || av.status === "execution_error") {
        blockers.push(buildArtifactFinalizeBlocker({
          stage_id,
          validator_kind: vk,
          requirement: req,
          check: av,
        }));
      }
    }
  }

  // Verdict gate. Prior to this check, getStageFinalizeReadiness could
  // greenlight finalize_passed on a stage whose judge had returned
  // outcome='fail' as long as no required validator blocked. That allowed
  // failed judgments to be silently buried under "passed". Refuse to mark a
  // stage 'passed' when the most recent verdict on the stage is a fail,
  // unless a subsequent Reflexion retry attempt produced a pass.
  const latestVerdict = db()
    .prepare(
      `SELECT v.id AS verdict_id, v.outcome AS outcome, a.id AS attempt_id, v.created_at AS created_at
         FROM verdicts v
         JOIN attempts a ON a.id = v.attempt_id
        WHERE a.stage_id = ?
          AND v.retracted_at IS NULL
        ORDER BY v.created_at DESC LIMIT 1`,
    )
    .get(stage_id) as
      | { verdict_id: string; outcome: VerdictOutcome; attempt_id: string; created_at: number }
      | undefined;

  if (latestVerdict && latestVerdict.outcome === "fail") {
    blockers.push(buildVerdictFinalizeBlocker({
      stage_id,
      verdict_id: latestVerdict.verdict_id,
      attempt_id: latestVerdict.attempt_id,
      outcome: latestVerdict.outcome,
    }));
  }

  // R3-tail post-mortem Fix 0.2: mandatory cross-vendor re-judge gate.
  // Any engineer attempt whose self-report claims to close named findings
  // (notes_json.findings_closed non-empty) requires an independent
  // cross-vendor verdict before finalize_passed is allowed. Same-vendor
  // verdicts don't count — that's the exact path the R3-tail δ envelope
  // took to ship `void idempotencyKey; // explicit no-op` as "Idempotency-
  // Key implemented". Status="needs_review" (engineer caught its own
  // anti-pattern) also forces the gate so the judge can verify the
  // operator-acceptable resolution.
  const claimedAttempts = db()
    .prepare(
      `SELECT id, notes_json, status
         FROM attempts
        WHERE stage_id = ?
          AND notes_json IS NOT NULL
        ORDER BY created_at DESC`,
    )
    .all(stage_id) as Array<{ id: string; notes_json: string; status: AttemptStatus }>;

  for (const att of claimedAttempts) {
    let parsed: AttemptNotes | null = null;
    try {
      parsed = JSON.parse(att.notes_json) as AttemptNotes;
    } catch {
      // Malformed notes_json — treat as no claim; downstream judge will
      // catch via the raw column read. Don't block finalize on a parser
      // bug, but log so the operator can investigate.
      log.warn({ attempt_id: att.id }, "attempt notes_json failed to parse — skipping rejudge gate check");
      continue;
    }
    const findings = parsed?.findings_closed ?? [];
    const antiPatternHits = parsed?.anti_pattern_hits ?? [];
    const needsReview = att.status === "needs_review";
    // Trigger the gate when EITHER the engineer claimed closures OR
    // self-flagged anti-patterns OR was downgraded to needs_review.
    const gateRequired = findings.length > 0 || antiPatternHits.length > 0 || needsReview;
    if (!gateRequired) continue;

    const crossVendorVerdict = db()
      .prepare(
        `SELECT id FROM verdicts
          WHERE attempt_id = ?
            AND cross_vendor = 1
            AND retracted_at IS NULL
          ORDER BY created_at DESC LIMIT 1`,
      )
      .get(att.id) as { id: string } | undefined;

    if (crossVendorVerdict) continue;  // already re-judged independently (non-retracted)

    const findingIds = findings.map(f => f.id);
    const summary = needsReview
      ? `attempt ${att.id} was self-flagged needs_review (engineer caught anti-pattern)`
      : antiPatternHits.length > 0
        ? `attempt ${att.id} self-reported ${antiPatternHits.length} anti-pattern hit(s)`
        : `attempt ${att.id} self-reported closure of ${findingIds.length} finding(s): ${findingIds.slice(0, 6).join(", ")}${findingIds.length > 6 ? ` +${findingIds.length - 6} more` : ""}`;

    blockers.push({
      gate: "findings_closure_rejudge",
      next_action: "dispatch_cross_vendor_rejudge",
      message:
        `finalize_stage refused: ${summary} but no independent cross-vendor verdict exists on attempt ${att.id}. ` +
        `R3-tail post-mortem Fix 0.2 requires an independent cross-vendor judge pass after any engineer "all closed" self-report. ` +
        `Dispatch the judge-cross-vendor agent against this attempt before retrying finalize_passed, or finalize with status='surfaced' to accept the unreviewed self-report.`,
      attempt_id: att.id,
      finding_ids: findingIds.length > 0 ? findingIds : ["<anti-pattern-only>"],
    });
    break;  // surface the most recent claiming attempt only; one is enough to block
  }

  // ── PP-VG-6: hallucination gate ───────────────────────────────────────────────
  // If any attempt for this stage has a non-retracted verdict with
  // hallucination_suspected=1, it must be cleared by a LINKED cross-vendor
  // resolution before finalize_passed is allowed. Clearance = EITHER:
  //   a) the suspect verdict itself was retracted, OR
  //   b) a SUBSEQUENT verdict on the SAME attempt has cross_vendor=1 AND
  //      outcome != 'fail' (an independent cross-vendor pass).
  // A later same-vendor clean verdict on the same attempt does NOT clear it.
  // (Mirrors the findings_closure_rejudge pattern at ~1028-1062 which selects
  //  verdicts WHERE cross_vendor=1.)
  {
    // Find all non-retracted suspect verdicts for attempts on this stage.
    // Select rowid alongside created_at so we can use insertion order as the
    // tiebreak for "subsequent" (fixes same-ms resolution — issue #4).
    const suspectVerdicts = db()
      .prepare(
        `SELECT v.id AS verdict_id, v.attempt_id AS attempt_id,
                v.created_at AS created_at, v.rowid AS row_id
           FROM verdicts v
           JOIN attempts a ON a.id = v.attempt_id
          WHERE a.stage_id = ?
            AND v.hallucination_suspected = 1
            AND v.retracted_at IS NULL
          ORDER BY v.created_at ASC, v.rowid ASC`,
      )
      .all(stage_id) as Array<{ verdict_id: string; attempt_id: string; created_at: string; row_id: number }>;

    for (const suspect of suspectVerdicts) {
      // Check for a cross-vendor resolution: a verdict on the SAME attempt with
      // cross_vendor=1 AND outcome != 'fail', inserted AFTER the suspect verdict.
      // "After" is determined by rowid (insertion order) as the primary ordering
      // within the same millisecond — created_at alone fails on same-ms ties.
      // A verdict at the same rowid is the suspect itself; we want strictly later.
      const cvResolution = db()
        .prepare(
          `SELECT id FROM verdicts
            WHERE attempt_id = ?
              AND cross_vendor = 1
              AND outcome != 'fail'
              AND retracted_at IS NULL
              AND rowid > ?
            LIMIT 1`,
        )
        .get(suspect.attempt_id, suspect.row_id) as { id: string } | undefined;

      if (cvResolution) continue; // cleared by a cross-vendor pass

      // No cross-vendor resolution exists — block finalize(passed).
      blockers.push({
        gate: "hallucination",
        next_action: "dispatch_cross_vendor_rejudge",
        attempt_id: suspect.attempt_id,
        verdict_id: suspect.verdict_id,
        message:
          `finalize_stage refused: attempt ${suspect.attempt_id} has a verdict (${suspect.verdict_id}) ` +
          `with hallucination_suspected=1 that has not been cleared by a cross-vendor resolution. ` +
          `PP-VG-6 requires either: (a) retracting the suspect verdict via retract_verdict, or ` +
          `(b) recording a new cross_vendor=1 non-fail verdict on the same attempt (dispatch_cross_vendor_rejudge). ` +
          `A same-vendor clean verdict does NOT clear hallucination suspicion. ` +
          `Alternatively, finalize with status='surfaced' to accept the unresolved suspicion.`,
      } satisfies StageFinalizeHallucinationBlocker);
      break; // surface the first unresolved suspect; one is enough to block
    }
  }

  // ── PP-VG-3: browser validation severity gate ─────────────────────────────
  // Read the append-only browser_validation_severity field from stage notes.
  // Any "errors" result persisted by browserValidationFinalize blocks
  // finalize(passed). A JSON parse failure on notes_json is treated as
  // "errors" (fail-closed). Missing notes_json (null) = no BV run = no block.
  {
    const bvNotesRow = db()
      .prepare(`SELECT notes_json FROM stages WHERE id = ?`)
      .get(stage_id) as { notes_json: string | null } | undefined;
    const rawNotes = bvNotesRow?.notes_json;
    if (rawNotes) {
      let bvSeverity: string | undefined;
      let bvReportPath: string | undefined;
      let parseOk = false;
      try {
        const parsed = JSON.parse(rawNotes);
        // Must be a plain object to be trustworthy. An array or primitive
        // is a non-object notes_json — treat as unknown/fail-closed (same as
        // a parse failure) so a corrupted notes row can never let errors pass.
        if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
          const n = parsed as {
            browser_validation_severity?: string;
            browser_validation_report_path?: string;
          };
          bvSeverity = n.browser_validation_severity;
          bvReportPath = n.browser_validation_report_path;
          parseOk = true;
        }
        // else: parsed OK but wrong type — parseOk stays false → fail-closed below
      } catch { /* intentional fail-closed below */ }

      // Block when: parse failed / wrong type with existing notes (unknown state = fail-closed)
      // OR severity explicitly "errors".
      const isBvError = !parseOk || bvSeverity === "errors";
      if (isBvError) {
        blockers.push({
          gate: "browser_validation",
          next_action: "surface_stage",
          severity: "errors",
          message:
            `finalize_stage refused: stage ${stage_id} has a browser validation report with ` +
            `severity='errors' (fail findings, console errors, or unexpected 4xx/5xx network errors ` +
            `outside the per-route expected_statuses allowlist). ` +
            `Review the report at ${bvReportPath ?? "<.harness/<run_id>/browser-validation/report-*.md>"} ` +
            `and fix the issues, or finalize with status='surfaced' to accept the errors.`,
        } satisfies StageFinalizeBrowserValidationBlocker);
      }
    }
  }

  const can_pass = blockers.length === 0;
  return {
    stage_id,
    stage_kind: stageRow.kind,
    can_pass,
    recommended_status: can_pass ? "passed" : "surfaced",
    next_action: can_pass ? "finalize_passed" : blockers[0]!.next_action,
    blockers,
    summary: can_pass
      ? `stage ${stage_id} is ready to finalize as 'passed'`
      : blockers.map(blocker => blocker.message).join(" "),
  };
}

export async function finalizeStage(input: FinalizeStageInput): Promise<void> {
  // TDD execution gate. The harness has TDD-shaped team pipelines (refactor,
  // bug-fix, feature-tdd) where a `tests_pre` stage runs before the `code`
  // stage. To make the red/green property uncircumventable we refuse to mark
  // either stage `passed` unless tdd-gate.runTddCheck has recorded a verified
  // row. Surfacing/skipping is always allowed — that's how a TDD violation
  // gets reported up rather than swept under the rug.
  if (input.status === "passed") {
    // Auto-run any required validators that haven't been recorded yet, so
    // the operator doesn't have to call mcp__pp_harness__artifact_validate
    // manually before finalize. This makes adr_structure_lint, contracts_lint,
    // tokens_build, mermaid_render and c4_render apply automatically on the
    // most recently archived artifact of the bound kind. Validators that
    // error out still surface as blockers below — the auto-run does NOT
    // mask failures, it only removes the "missing row" speed bump.
    const reqs = requiredValidatorsForStage(input.stage_id);
    for (const req of reqs) {
      for (const vk of req.validators) {
        const existing = getLatestArtifactValidation(input.stage_id, vk, req.artifact_id);
        if (existing) continue;
        try {
          await runArtifactValidator({
            stage_id: input.stage_id,
            kind: vk,
            artifact_path: req.artifact_path,
          });
        } catch (err) {
          // Swallow — the readiness check below will surface a precise
          // ValidatorGateViolation with a next_action the operator can
          // act on. Logging the dispatch failure here makes the chain
          // debuggable without crashing the finalize call.
          log.warn(
            { err: (err as Error).message, stage_id: input.stage_id, validator: vk, artifact_path: req.artifact_path },
            "finalizeStage auto-run validator failed",
          );
        }
      }
    }
    const readiness = getStageFinalizeReadiness(input.stage_id);
    if (!readiness.can_pass) {
      const blocker = readiness.blockers[0]!;
      if (blocker.gate === "tdd") {
        throw new TddGateViolation(
          blocker.message,
          input.stage_id,
          blocker.phase,
          blocker.check,
        );
      }
      if (blocker.gate === "verdict") {
        throw new VerdictGateViolation(
          blocker.message,
          input.stage_id,
          blocker.attempt_id,
          blocker.verdict_id,
          blocker.outcome,
        );
      }
      if (blocker.gate === "findings_closure_rejudge") {
        throw new FindingsClosureRejudgeRequired(
          blocker.message,
          input.stage_id,
          blocker.attempt_id,
          blocker.finding_ids,
        );
      }
      // PP-VG-3: browser validation errors block finalize(passed).
      if (blocker.gate === "browser_validation") {
        throw new Error(blocker.message);
      }
      // PP-VG-6: hallucination suspicion without cross-vendor resolution.
      if (blocker.gate === "hallucination") {
        throw new Error(blocker.message);
      }
      throw new ValidatorGateViolation(
        blocker.message,
        input.stage_id,
        blocker.validator_kind,
        blocker.artifact_id,
        blocker.check,
      );
    }
  }

  txImmediate(() => {
    db()
      .prepare(
        `UPDATE stages SET status = ?, winner_attempt_id = ?, finished_at = ? WHERE id = ?`
      )
      .run(input.status, input.winner_attempt_id ?? null, now(), input.stage_id);
  });
}

function buildTddFinalizeBlocker(opts: {
  stage_id: string;
  phase: "pre" | "post";
  check: TddCheckRow | null;
  prior_stage_id?: string;
}): StageFinalizeTddBlocker {
  const status: StageFinalizeTddBlocker["status"] = !opts.check
    ? "missing"
    : opts.check.status === "violation"
      ? "violation"
      : "execution_error";
  const next_action: StageFinalizeTddBlocker["next_action"] =
    status === "missing"
      ? opts.phase === "pre"
        ? "run_tdd_pre_check"
        : "run_tdd_post_check"
      : status === "violation"
        ? "retry_or_surface"
        : "surface_stage";

  const message = opts.phase === "pre"
    ? `finalize_stage refused: tests_pre stage ${opts.stage_id} cannot be marked 'passed' without a verified tdd_check (phase='pre'). ` +
      (opts.check
        ? `Latest check: status=${opts.check.status}, expected=${opts.check.expected}, actual=${opts.check.actual}, reason=${opts.check.reason ?? "n/a"}, output=${opts.check.output_path ?? "n/a"}.`
        : `No tdd_check recorded yet. Call mcp__pp_harness__tdd_pre_check after the stage's judge passes.`) +
      ` To accept the violation, finalize the stage with status='surfaced' instead.`
    : `finalize_stage refused: code stage ${opts.stage_id} cannot be marked 'passed' because its immediate predecessor was tests_pre stage ${opts.prior_stage_id} and no verified tdd_check (phase='post') exists. ` +
      (opts.check
        ? `Latest check: status=${opts.check.status}, expected=${opts.check.expected}, actual=${opts.check.actual}, reason=${opts.check.reason ?? "n/a"}, output=${opts.check.output_path ?? "n/a"}.`
        : `No tdd_check recorded yet. Call mcp__pp_harness__tdd_post_check after the code stage's judge passes.`) +
      ` To accept the violation, finalize the stage with status='surfaced' instead.`;

  return {
    gate: "tdd",
    phase: opts.phase,
    status,
    next_action,
    message,
    check: opts.check,
    prior_stage_id: opts.prior_stage_id,
  };
}

function buildVerdictFinalizeBlocker(opts: {
  stage_id: string;
  verdict_id: string;
  attempt_id: string;
  outcome: VerdictOutcome;
}): StageFinalizeVerdictBlocker {
  return {
    gate: "verdict",
    next_action: "retry_with_critique",
    attempt_id: opts.attempt_id,
    verdict_id: opts.verdict_id,
    outcome: opts.outcome,
    message:
      `finalize_stage refused: stage ${opts.stage_id} cannot be marked 'passed' ` +
      `because the most recent verdict on the stage is outcome='${opts.outcome}' ` +
      `(verdict_id=${opts.verdict_id}, attempt_id=${opts.attempt_id}). ` +
      `Call mcp__pp_harness__retry_with_critique to run the Reflexion ×1 retry, ` +
      `or finalize the stage with status='surfaced' to ship the failure intact.`,
  };
}

function buildArtifactFinalizeBlocker(opts: {
  stage_id: string;
  validator_kind: ValidatorKind;
  requirement: ReturnType<typeof requiredValidatorsForStage>[number];
  check: ArtifactValidationRow | null;
}): StageFinalizeArtifactBlocker {
  const status: StageFinalizeArtifactBlocker["status"] = !opts.check
    ? "missing"
    : opts.check.status === "violation"
      ? "violation"
      : "execution_error";
  const next_action: StageFinalizeArtifactBlocker["next_action"] =
    status === "missing"
      ? "run_artifact_validate"
      : status === "violation"
        ? "retry_or_surface"
        : "surface_stage";

  return {
    gate: "artifact_validation",
    validator_kind: opts.validator_kind,
    status,
    next_action,
    message:
      `finalize_stage refused: artifact ${opts.requirement.artifact_id} (kind=${opts.requirement.artifact_kind ?? "n/a"}) requires validator '${opts.validator_kind}' but ` +
      (opts.check
        ? `latest row is status=${opts.check.status}, reason=${opts.check.reason ?? "n/a"}, output=${opts.check.output_path ?? "n/a"}.`
        : `no artifact_validations row exists yet. Call mcp__pp_harness__artifact_validate({stage_id: '${opts.stage_id}', kind: '${opts.validator_kind}'}) after the judge passes.`) +
      ` To accept the violation, finalize the stage with status='surfaced' instead.`,
    artifact_id: opts.requirement.artifact_id,
    artifact_kind: opts.requirement.artifact_kind,
    artifact_path: opts.requirement.artifact_path,
    check: opts.check,
  };
}

/**
 * PP-VG-4: finalizeRun(complete) blocked because one or more REQUIRED
 * missability checks have status='fail'. Required check ids are the UNION
 * of profile-, team-, and forum-declared required sets. Advisory (non-required)
 * failures do NOT block. Resolves required sets from persisted run-row
 * snapshots (profile_snapshot_json, team, forum) — does NOT re-run checks.
 */
export class MissabilityGateViolation extends Error {
  constructor(
    message: string,
    public readonly run_id: string,
    public readonly failed_required_check_ids: string[],
  ) {
    super(message);
    this.name = "MissabilityGateViolation";
  }
}

export type FinalizeRunInput = {
  run_id: string;
  status: Extract<RunStatus, "complete" | "surfaced" | "aborted">;
  summary_md?: string;
};

/**
 * PP-VG-7: structured return from finalizeRun so callers can observe
 * a silent downgrade from "complete" to "surfaced".
 */
export type FinalizeRunOutput = {
  /** The status actually written to the DB. */
  effective_status: Extract<RunStatus, "complete" | "surfaced" | "aborted">;
  /** The status the caller requested. */
  requested_status: Extract<RunStatus, "complete" | "surfaced" | "aborted">;
  /**
   * True when finalize_run(complete) was downgraded to "surfaced" because
   * one or more child stages have status="surfaced". A silent downgrade
   * is a false success and breaks operator trust — always check this field.
   */
  downgraded: boolean;
  /** Number of surfaced child stages that triggered the downgrade (0 when not downgraded). */
  surfaced_stage_count: number;
};

export function finalizeRun(input: FinalizeRunInput): FinalizeRunOutput {
  const run = db()
    .prepare(`SELECT project_path FROM runs WHERE id = ?`)
    .get(input.run_id) as { project_path: string } | undefined;
  if (!run) throw new Error(`run ${input.run_id} not found`);

  // ── PP-VG-7: surfaced-stages downgrade gate ────────────────────────────────
  // A run requested as "complete" is silently downgraded to "surfaced" when
  // child stages are in the "surfaced" state. Rather than throwing (which
  // would break all "complete" paths), we return a structured result so the
  // MCP caller can observe the gate firing. ALL downstream writes use
  // effectiveStatus, preserving the invariant.
  let effectiveStatus: Extract<RunStatus, "complete" | "surfaced" | "aborted"> = input.status;
  let surfacedStageCount = 0;
  if (input.status === "complete") {
    surfacedStageCount = (db()
      .prepare(`SELECT COUNT(*) AS n FROM stages WHERE run_id = ? AND status = 'surfaced'`)
      .get(input.run_id) as { n: number }).n;
    if (surfacedStageCount > 0) {
      effectiveStatus = "surfaced";
      log.warn(
        { run_id: input.run_id, surfaced_stage_count: surfacedStageCount },
        `PP-VG-7: finalize_run downgraded from 'complete' to 'surfaced' — ${surfacedStageCount} stage(s) surfaced`,
      );
    }
  }

  // ── PP-VG-2: run-level artifact availability gate ─────────────────────────
  // Only fires on finalize(complete) — surfaced/aborted are not blocked.
  // Resolves required artifact kinds EXCLUSIVELY from the persisted run-row
  // snapshots (taxonomy_mapping_json + profile_snapshot_json). Do NOT call
  // loadProjectProfile or read .harness/profile.yaml — the snapshot is the
  // source of truth for what was declared when the run started.
  // Fail-closed policy: if the snapshot columns exist but are malformed
  // (JSON parse failure, unexpected shape), block with a clear message rather
  // than silently skipping. Missing columns (NULL) are treated as no-op.
  if (input.status === "complete") {
    const snapshotRow = db()
      .prepare(`SELECT taxonomy_mapping_json, profile_snapshot_json FROM runs WHERE id = ?`)
      .get(input.run_id) as
      | { taxonomy_mapping_json: string | null; profile_snapshot_json: string | null }
      | undefined;

    const requiredKinds = new Set<string>();

    // Parse taxonomy_mapping_json: sections[].required_artifacts
    // Treat null AND empty/whitespace-only strings as ABSENT (no required kinds).
    // A truthy-but-blank string ("" / "  ") would otherwise either silently
    // bypass validation (falsy "") or spuriously fail with a parse error ("  ").
    // Both are the same "no snapshot" case and must behave identically to null.
    if (snapshotRow?.taxonomy_mapping_json?.trim()) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(snapshotRow.taxonomy_mapping_json);
      } catch (e) {
        throw new ArtifactAvailabilityGateViolation(
          `PP-VG-2: finalize_run(complete) blocked — runs.taxonomy_mapping_json for run ${input.run_id} ` +
          `failed JSON parse: ${(e as Error).message}. Fix or clear the snapshot before finalizing.`,
          input.run_id,
          "<parse_error>",
        );
      }
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        throw new ArtifactAvailabilityGateViolation(
          `PP-VG-2: finalize_run(complete) blocked — runs.taxonomy_mapping_json for run ${input.run_id} ` +
          `is not an object. Unexpected shape; fix the snapshot before finalizing.`,
          input.run_id,
          "<malformed>",
        );
      }
      // Strict shape: sections must be present and be an array.
      // An empty object {}, a missing sections key, or sections=null all indicate
      // a malformed snapshot that should fail closed rather than silently yielding
      // zero required kinds.
      const mapping = parsed as { sections?: unknown };
      if (!Array.isArray(mapping.sections)) {
        throw new ArtifactAvailabilityGateViolation(
          `PP-VG-2: finalize_run(complete) blocked — runs.taxonomy_mapping_json for run ${input.run_id} ` +
          `has a malformed shape: 'sections' must be an array (got ${
            mapping.sections === undefined ? "undefined" :
            mapping.sections === null      ? "null"      :
            Array.isArray(mapping.sections) ? "array"   :
            typeof mapping.sections
          }). Fix or clear the snapshot before finalizing.`,
          input.run_id,
          "<malformed_sections>",
        );
      }
      for (const sec of mapping.sections as Array<unknown>) {
        // Each entry in sections must be a plain object (not an array, not a primitive).
        if (typeof sec !== "object" || sec === null || Array.isArray(sec)) {
          throw new ArtifactAvailabilityGateViolation(
            `PP-VG-2: finalize_run(complete) blocked — runs.taxonomy_mapping_json for run ${input.run_id} ` +
            `contains a section entry that is not an object. Fix or clear the snapshot before finalizing.`,
            input.run_id,
            "<malformed_section_entry>",
          );
        }
        const s = sec as { required_artifacts?: unknown };
        if (s.required_artifacts !== undefined) {
          // If required_artifacts is present it MUST be an array of strings.
          if (!Array.isArray(s.required_artifacts)) {
            throw new ArtifactAvailabilityGateViolation(
              `PP-VG-2: finalize_run(complete) blocked — runs.taxonomy_mapping_json for run ${input.run_id} ` +
              `has a section whose required_artifacts is not an array. Fix or clear the snapshot before finalizing.`,
              input.run_id,
              "<malformed_required_artifacts>",
            );
          }
          for (const k of s.required_artifacts as Array<unknown>) {
            if (typeof k !== "string") {
              throw new ArtifactAvailabilityGateViolation(
                `PP-VG-2: finalize_run(complete) blocked — runs.taxonomy_mapping_json for run ${input.run_id} ` +
                `has a section whose required_artifacts contains a non-string entry. Fix or clear the snapshot before finalizing.`,
                input.run_id,
                "<malformed_required_artifacts_entry>",
              );
            }
            requiredKinds.add(k);
          }
        }
      }
    }

    // Parse profile_snapshot_json: .required_artifacts
    // Same empty/whitespace normalization as taxonomy_mapping_json above.
    if (snapshotRow?.profile_snapshot_json?.trim()) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(snapshotRow.profile_snapshot_json);
      } catch (e) {
        throw new ArtifactAvailabilityGateViolation(
          `PP-VG-2: finalize_run(complete) blocked — runs.profile_snapshot_json for run ${input.run_id} ` +
          `failed JSON parse: ${(e as Error).message}. Fix or clear the snapshot before finalizing.`,
          input.run_id,
          "<parse_error>",
        );
      }
      // Top-level must be a plain object — not an array, not a primitive, not null.
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        throw new ArtifactAvailabilityGateViolation(
          `PP-VG-2: finalize_run(complete) blocked — runs.profile_snapshot_json for run ${input.run_id} ` +
          `has a malformed shape: top-level must be an object (got ${
            parsed === null ? "null" : Array.isArray(parsed) ? "array" : typeof parsed
          }). Fix or clear the snapshot before finalizing.`,
          input.run_id,
          "<malformed_profile>",
        );
      }
      const profile = parsed as { required_artifacts?: unknown };
      if (profile.required_artifacts !== undefined) {
        // If required_artifacts is present it MUST be an array of strings.
        if (!Array.isArray(profile.required_artifacts)) {
          throw new ArtifactAvailabilityGateViolation(
            `PP-VG-2: finalize_run(complete) blocked — runs.profile_snapshot_json for run ${input.run_id} ` +
            `has required_artifacts that is not an array. Fix or clear the snapshot before finalizing.`,
            input.run_id,
            "<malformed_required_artifacts>",
          );
        }
        for (const k of profile.required_artifacts as Array<unknown>) {
          if (typeof k !== "string") {
            throw new ArtifactAvailabilityGateViolation(
              `PP-VG-2: finalize_run(complete) blocked — runs.profile_snapshot_json for run ${input.run_id} ` +
              `has required_artifacts containing a non-string entry. Fix or clear the snapshot before finalizing.`,
              input.run_id,
              "<malformed_required_artifacts_entry>",
            );
          }
          requiredKinds.add(k);
        }
      }
    }

    // For each required kind, verify at least ONE artifact exists RUN-WIDE
    // (across any stage of this run — the kind can live in a dedicated stage).
    if (requiredKinds.size > 0) {
      const archivedKinds = new Set<string>(
        (db()
          .prepare(
            `SELECT DISTINCT a.kind FROM artifacts a
               JOIN stages s ON s.id = a.stage_id
              WHERE s.run_id = ? AND a.kind IS NOT NULL`
          )
          .all(input.run_id) as Array<{ kind: string }>)
          .map(r => r.kind),
      );
      for (const kind of requiredKinds) {
        if (!archivedKinds.has(kind)) {
          throw new ArtifactAvailabilityGateViolation(
            `PP-VG-2: finalize_run(complete) blocked — required artifact kind '${kind}' has zero ` +
            `archived rows run-wide for run ${input.run_id}. ` +
            `The kind is declared in runs.taxonomy_mapping_json or runs.profile_snapshot_json. ` +
            `Archive at least one '${kind}' artifact (via archive_artifact) before finalizing as complete, ` +
            `or finalize with status='surfaced' to accept the gap.`,
            input.run_id,
            kind,
          );
        }
      }
    }
  }

  // ── PP-VG-4: missability gate ─────────────────────────────────────────────
  // finalizeRun(complete) MUST query the persisted missability_checks rows and
  // BLOCK when any REQUIRED check has status='fail'. The required check-id set
  // is the UNION of: profile-required + team-required + forum-required.
  //
  // Sources:
  //   - profile: profile_snapshot_json.required_missability_checks (from the
  //     snapshot persisted at run-start — not the live filesystem).
  //   - team:    getTeam(run.team) → team.missability_required
  //   - forum:   getForum(run.forum) → forum.required_missability_checks
  //
  // Fail-closed on malformed required-source (parse/shape error) — do NOT
  // silently treat as "no required checks".
  // Advisory (non-required) failed checks do NOT block.
  // Only fires on finalize(complete); surfaced/aborted are not blocked.
  if (input.status === "complete") {
    // Read all three sources for the required check set.
    const vg4Row = db()
      .prepare(`SELECT profile_snapshot_json, team, forum, project_path FROM runs WHERE id = ?`)
      .get(input.run_id) as
      | { profile_snapshot_json: string | null; team: string | null; forum: string | null; project_path: string }
      | undefined;
    if (!vg4Row) throw new Error(`run ${input.run_id} not found during VG-4 resolution`);

    const requiredCheckIds = new Set<string>();

    // Source 1: profile_snapshot_json.required_missability_checks
    if (vg4Row.profile_snapshot_json?.trim()) {
      let profileParsed: unknown;
      try {
        profileParsed = JSON.parse(vg4Row.profile_snapshot_json);
      } catch (e) {
        throw new MissabilityGateViolation(
          `PP-VG-4: finalize_run(complete) blocked — runs.profile_snapshot_json for run ${input.run_id} ` +
          `failed JSON parse while resolving required missability checks: ${(e as Error).message}. ` +
          `Fix or clear the snapshot before finalizing.`,
          input.run_id,
          [],
        );
      }
      if (typeof profileParsed !== "object" || profileParsed === null || Array.isArray(profileParsed)) {
        throw new MissabilityGateViolation(
          `PP-VG-4: finalize_run(complete) blocked — runs.profile_snapshot_json for run ${input.run_id} ` +
          `has a malformed shape (top-level must be an object) while resolving required missability checks. ` +
          `Fix or clear the snapshot before finalizing.`,
          input.run_id,
          [],
        );
      }
      const profileObj = profileParsed as { required_missability_checks?: unknown };
      if (profileObj.required_missability_checks !== undefined) {
        if (!Array.isArray(profileObj.required_missability_checks)) {
          throw new MissabilityGateViolation(
            `PP-VG-4: finalize_run(complete) blocked — runs.profile_snapshot_json for run ${input.run_id} ` +
            `has required_missability_checks that is not an array. Fix or clear the snapshot before finalizing.`,
            input.run_id,
            [],
          );
        }
        for (const id of profileObj.required_missability_checks as Array<unknown>) {
          if (typeof id !== "string") {
            throw new MissabilityGateViolation(
              `PP-VG-4: finalize_run(complete) blocked — runs.profile_snapshot_json for run ${input.run_id} ` +
              `has required_missability_checks containing a non-string entry. Fix or clear the snapshot before finalizing.`,
              input.run_id,
              [],
            );
          }
          requiredCheckIds.add(id);
        }
      }
    }

    // Source 2: team.missability_required
    // Resolution order (resolve-first, sentinel-fallback):
    //   1. NULL → no team source declared; skip silently.
    //   2. present-but-blank ("" / whitespace) → malformed identifier; fail closed.
    //   3. present non-blank → call getTeam FIRST.
    //      a. Resolves (yaml exists, even if named "ad-hoc") → use its required checks.
    //      b. Does NOT resolve AND name is a known ensureRun sentinel ("ad-hoc") →
    //         treat as no-team-source (legit ensureRun with no user-provided team).
    //      c. Does NOT resolve AND name is NOT a sentinel → malformed source; fail closed.
    // This means a real .claude/teams/ad-hoc.yaml is fully honored; the sentinel
    // exemption only fires when the name can't be resolved AND is the known placeholder.
    const VG4_TEAM_SENTINELS = new Set(["ad-hoc"]);
    const rawTeam = vg4Row.team;
    if (rawTeam !== null) {
      const trimmedTeam = rawTeam.trim();
      if (trimmedTeam === "") {
        throw new MissabilityGateViolation(
          `PP-VG-4: finalize_run(complete) blocked — run ${input.run_id} has a blank team value. ` +
          `A blank team identifier is malformed. Fix the runs.team column before finalizing.`,
          input.run_id,
          [],
        );
      }
      // Resolve first — a real yaml (including "ad-hoc.yaml") takes precedence.
      const teamResult = getTeam({ name: trimmedTeam, project_path: vg4Row.project_path });
      if (teamResult) {
        // Real team found: use its required missability checks.
        for (const id of teamResult.team.missability_required ?? []) {
          requiredCheckIds.add(id);
        }
      } else if (VG4_TEAM_SENTINELS.has(trimmedTeam)) {
        // No yaml for this name AND it's the known ensureRun no-team sentinel →
        // treat as no-team-source; continue silently.
      } else {
        // No yaml AND not a sentinel → malformed source; fail closed.
        throw new MissabilityGateViolation(
          `PP-VG-4: finalize_run(complete) blocked — run ${input.run_id} references team '${trimmedTeam}' ` +
          `but it could not be loaded. Fix the team yaml before finalizing.`,
          input.run_id,
          [],
        );
      }
    }

    // Source 3: forum.required_missability_checks
    // NULL = no forum declared (no source). Present-but-blank = malformed: fail closed.
    // Unknown forum id = malformed: fail closed.
    const rawForum = vg4Row.forum;
    if (rawForum !== null) {
      const trimmedForum = rawForum.trim();
      if (trimmedForum === "") {
        throw new MissabilityGateViolation(
          `PP-VG-4: finalize_run(complete) blocked — run ${input.run_id} has a blank forum value. ` +
          `A blank forum identifier is malformed. Fix the runs.forum column before finalizing.`,
          input.run_id,
          [],
        );
      }
      const forumObj = getForum(trimmedForum);
      if (!forumObj) {
        throw new MissabilityGateViolation(
          `PP-VG-4: finalize_run(complete) blocked — run ${input.run_id} references forum '${trimmedForum}' ` +
          `but it is not a recognised forum id. Fix the forum reference before finalizing.`,
          input.run_id,
          [],
        );
      }
      for (const id of forumObj.required_missability_checks ?? []) {
        requiredCheckIds.add(id);
      }
    }

    // Query the latest persisted row per check_id using rowid as the insertion
    // tiebreak so same-millisecond ties are broken deterministically by insertion
    // order (the truly-last-inserted row wins). Uses a correlated subquery rather
    // than GROUP BY / HAVING which can pick a non-last row on ties.
    // Re-use persisted rows — do NOT re-run runMissabilityChecks.
    if (requiredCheckIds.size > 0) {
      const latestChecks = db()
        .prepare(
          `SELECT check_id, status
             FROM missability_checks m
            WHERE run_id = ?
              AND check_id IN (${[...requiredCheckIds].map(() => "?").join(", ")})
              AND rowid = (
                SELECT rowid FROM missability_checks
                 WHERE run_id = m.run_id AND check_id = m.check_id
                 ORDER BY created_at DESC, rowid DESC
                 LIMIT 1
              )`,
        )
        .all(input.run_id, ...[...requiredCheckIds]) as Array<{ check_id: string; status: string }>;

      // Build a map of latest status per check_id.
      const latestStatusById = new Map<string, string>(
        latestChecks.map(r => [r.check_id, r.status]),
      );

      const failedRequired: string[] = [];
      for (const checkId of requiredCheckIds) {
        const status = latestStatusById.get(checkId);
        // A required check with no persisted row counts as 'fail' (hasn't run = unknown = fail-closed).
        if (!status || status === "fail") {
          failedRequired.push(checkId);
        }
      }

      if (failedRequired.length > 0) {
        throw new MissabilityGateViolation(
          `PP-VG-4: finalize_run(complete) blocked — ${failedRequired.length} required missability check(s) ` +
          `have status='fail' (or are missing) for run ${input.run_id}: ${failedRequired.join(", ")}. ` +
          `Required checks are the union of profile-, team-, and forum-declared sets. ` +
          `Advisory (non-required) failures do not block. Run mcp__pp_harness__run_missability_checks ` +
          `to re-evaluate and re-persist, then retry finalize. ` +
          `Or finalize with status='surfaced' to accept the failures.`,
          input.run_id,
          failedRequired,
        );
      }
    }
  }

  if (input.summary_md) {
    const dir = projectArtifactDir(run.project_path, input.run_id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "run.summary.md"), input.summary_md, "utf8");
  }

  txImmediate(() => {
    db()
      .prepare(`UPDATE runs SET status = ?, finished_at = ? WHERE id = ?`)
      .run(effectiveStatus, now(), input.run_id);
  });

  // Release the per-project advisory lock. Best-effort — janitor will clean
  // up if the daemon crashed before we got here.
  try {
    new ProjectLock(run.project_path).release();
  } catch { /* ignore */ }

  // On `complete` (using effectiveStatus — VG-7 may have downgraded to surfaced),
  // patch PROJECT_MASTER.md with the run's contributions as a safety net.
  // Idempotent: re-applying the same content does not duplicate sections.
  if (effectiveStatus === "complete") {
    try {
      autoPatchMasterPlan(input.run_id, run.project_path);
    } catch (err) {
      log.warn({ run_id: input.run_id, err }, "autoPatchMasterPlan failed (non-fatal)");
    }
  } else {
    // Record an audit row so the user can see the run was intentionally not patched.
    try {
      txImmediate(() => {
        db()
          .prepare(
            `INSERT INTO master_plan_patches(id, run_id, section, kind, prev_sha, new_sha, applied_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)`
          )
          .run(`mpp_skip_${nanoid(8)}`, input.run_id, "(skipped)", "surfaced_skip", null, "", now());
      });
    } catch { /* ignore */ }
  }

  // Fire-and-forget: record the final summary in TheEights. Supersedes
  // the pp:run:<id> partial episodes written during the run.
  void writeRunSummary({
    run_id: input.run_id,
    project_path: run.project_path,
    status: effectiveStatus,
    summary_md: input.summary_md ?? null,
  });

  // T6: materialize the audit BOM for this run and back-write the handle
  // onto the runs row. Used by /pp:replay to verify the audit chain
  // hasn't been broken by external tampering since the original run.
  if (effectiveStatus === "complete") {
    void materializeAuditBom(input.run_id).then(bom => {
      if (bom?.bom_handle) {
        try {
          db().prepare(`UPDATE runs SET audit_bom_handle = ? WHERE id = ?`)
            .run(bom.bom_handle, input.run_id);
        } catch (err) {
          log.debug({ err, run_id: input.run_id }, "back-write audit_bom_handle failed");
        }
      }
    });
  }

  // T3: when the run was invoked by Hydra (hydra_workflow_id set on the
  // runs row), emit a DECISION_RECORD envelope back upstream.
  try {
    const ctxRow = db()
      .prepare(
        `SELECT hydra_workflow_id, hydra_envelope_id, hydra_origin_squad, request_text
           FROM runs WHERE id = ?`
      )
      .get(input.run_id) as
      | {
          hydra_workflow_id: string | null;
          hydra_envelope_id: string | null;
          hydra_origin_squad: string | null;
          request_text: string;
        }
      | undefined;
    if (ctxRow?.hydra_workflow_id) {
      const artifactCount = (db()
        .prepare(`SELECT COUNT(*) AS n FROM artifacts WHERE run_id = ?`)
        .get(input.run_id) as { n: number }).n;
      void emitDecisionRecord({
        run_id: input.run_id,
        project_path: run.project_path,
        workflow_id: ctxRow.hydra_workflow_id,
        origin_squad: ctxRow.hydra_origin_squad,
        request_text: ctxRow.request_text,
        status: effectiveStatus,
        summary_md: input.summary_md ?? null,
        artifact_count: artifactCount,
        hydra_envelope_id_in: ctxRow.hydra_envelope_id,
      });
    }
  } catch (err) {
    log.debug({ err, run_id: input.run_id }, "emitDecisionRecord dispatch skipped");
  }

  // T2: when the run touched a release (4.11) or retirement (4.16) section
  // AND had a constitution active at start, submit an attestation to
  // TheEights' audit graph.
  if (effectiveStatus === "complete") {
    const runRow = db()
      .prepare(`SELECT taxonomy_mapping_json, constitution_sha FROM runs WHERE id = ?`)
      .get(input.run_id) as
      | { taxonomy_mapping_json: string | null; constitution_sha: string | null }
      | undefined;
    if (runRow?.constitution_sha && runRow.taxonomy_mapping_json) {
      try {
        const mapping = JSON.parse(runRow.taxonomy_mapping_json) as { sections?: Array<{ id: string }> };
        const sections = (mapping.sections ?? []).map(s => s.id);
        if (sections.includes("4.11") || sections.includes("4.16")) {
          const artifactShas = (db()
            .prepare(`SELECT sha256 FROM artifacts WHERE run_id = ?`)
            .all(input.run_id) as Array<{ sha256: string }>).map(r => r.sha256);
          const sha = runRow.constitution_sha;
          void attestConstitution({
            run_id: input.run_id,
            project_path: run.project_path,
            constitution_sha: sha,
            artifact_shas: artifactShas,
          }).then(result => {
            if (result?.attestation_id) {
              try {
                db().prepare(`UPDATE runs SET constitution_attestation_id = ? WHERE id = ?`)
                  .run(result.attestation_id, input.run_id);
              } catch (err) {
                log.debug({ err, run_id: input.run_id }, "back-write constitution_attestation_id failed");
              }
            }
          });
        }
      } catch (err) {
        log.debug({ err, run_id: input.run_id }, "attestConstitution dispatch skipped");
      }
    }
  }

  // T4: sweep for recurring drift patterns and propose evolutions.
  if (effectiveStatus === "complete" || effectiveStatus === "surfaced") {
    try {
      void analyzeAndPropose({
        run_id: input.run_id,
        project_path: run.project_path,
      }).then(proposals => {
        if (proposals.length > 0) {
          log.info(
            { run_id: input.run_id, proposals: proposals.length },
            "autogenesis-analyzer surfaced drift proposals"
          );
        }
      });
    } catch (err) {
      log.debug({ err, run_id: input.run_id }, "autogenesis-analyzer dispatch skipped");
    }
  }

  log.info(
    { run_id: input.run_id, requested_status: input.status, effective_status: effectiveStatus, downgraded: effectiveStatus !== input.status },
    "run finalized",
  );

  return {
    effective_status: effectiveStatus,
    requested_status: input.status,
    downgraded: effectiveStatus !== input.status,
    surfaced_stage_count: surfacedStageCount,
  };
}

/**
 * Walk a run's artifacts grouped by taxonomy_section, fold each group into
 * the corresponding PROJECT_MASTER.md section via applyMasterPlanPatch.
 * Idempotent — if the run-id block already appears in the section, the
 * patch is appended again only if its content changed.
 */
function autoPatchMasterPlan(runId: string, projectPath: string): void {
  ensureMasterPlan(projectPath);

  const artifacts = db()
    .prepare(
      `SELECT id, taxonomy_section, kind, path FROM artifacts
        WHERE run_id = ? AND taxonomy_section IS NOT NULL
        ORDER BY taxonomy_section ASC, created_at ASC`
    )
    .all(runId) as Array<{ id: string; taxonomy_section: string; kind: string | null; path: string }>;

  if (artifacts.length === 0) return;

  const grouped = new Map<string, Array<{ kind: string | null; path: string }>>();
  for (const a of artifacts) {
    const arr = grouped.get(a.taxonomy_section) ?? [];
    arr.push({ kind: a.kind, path: a.path });
    grouped.set(a.taxonomy_section, arr);
  }

  const runRow = db()
    .prepare(`SELECT request_text, started_at, status, mode, team, forum FROM runs WHERE id = ?`)
    .get(runId) as
    | { request_text: string; started_at: string; status: string; mode: string; team: string | null; forum: string | null }
    | undefined;
  if (!runRow) return;

  const summary = runRow.request_text.slice(0, 80).replaceAll("\n", " ");
  const dateStr = runRow.started_at.slice(0, 10);

  // Canonical map lives on TaxonomySection.master_plan_section in taxonomy.ts.
  // Validate every target exists in MASTER_PLAN_SECTIONS so a typo in the
  // registry can't silently misroute a patch.
  const masterSet = new Set(MASTER_PLAN_SECTIONS);

  for (const [section4x, files] of grouped) {
    const def = TAXONOMY_BY_ID[section4x];
    const masterSection = def?.master_plan_section;
    if (!masterSection) {
      log.warn({ run_id: runId, section4x }, "no master_plan_section in taxonomy registry — skipping");
      continue;
    }
    if (!masterSet.has(masterSection)) {
      log.warn({ run_id: runId, section4x, masterSection }, "master_plan_section not in MASTER_PLAN_SECTIONS — skipping");
      continue;
    }
    const block =
      `### Run \`${runId}\` — ${summary}\n\n` +
      `- Date: ${dateStr}\n` +
      `- Mode: ${runRow.mode}${runRow.team ? ` (${runRow.team})` : ""}${runRow.forum ? ` (${runRow.forum})` : ""}\n` +
      `- Status: ${runRow.status}\n` +
      `- Artifacts:\n` +
      files.map(f => `  - \`${f.path}\`${f.kind ? ` (${f.kind})` : ""}`).join("\n") +
      "\n";
    try {
      applyMasterPlanPatch({
        run_id: runId,
        project_path: projectPath,
        section: masterSection,
        kind: "append",
        content_md: block,
      });
    } catch (err) {
      log.warn({ run_id: runId, section: masterSection, err }, "applyMasterPlanPatch failed");
    }
  }
}

export type ArchiveArtifactInput = {
  run_id: string;
  stage_id?: string;
  taxonomy_section?: string;
  kind?: string;
  relative_path: string;       // relative to <project>/.harness/<run_id>/
  bytes: string;               // utf-8 text content (default), or base64 when encoding='base64'
  encoding?: "utf8" | "base64"; // declare base64 explicitly; omitting triggers smell-reject heuristic
  force_overwrite?: boolean;   // allow clobber when manual edits would otherwise block
  /**
   * R3-tail post-mortem Fix 1.2 (2026-05-21): when the substantive intent
   * of this artifact lives at a DIFFERENT path in the project tree (e.g.,
   * a DR document, a section of AGENTS.md, an existing OpenAPI file the
   * patch was merged into), set evidence_ref to that project-relative
   * path. The missability check library will load THAT file's content
   * and run its regex against it, instead of the patch under .harness/
   * — which would otherwise silently fail the check despite the intent
   * being met. R3-tail finalize surfaced as 5 false-fail because of this
   * exact mismatch (patches archived under .harness, intent lived in
   * docs/decisions/DR-2026-018.md).
   */
  evidence_ref?: string;
};
export type ArchiveArtifactOk = {
  status: "ok";
  artifact_id: string;
  absolute_path: string;
  sha256: string;
};
export type ArchiveArtifactManualEdit = {
  status: "manual_edit_detected";
  absolute_path: string;
  stored_sha: string;
  current_sha: string;
  message: string;
};
export type ArchiveArtifactOutput = ArchiveArtifactOk | ArchiveArtifactManualEdit;

export class ArchiveArtifactPathError extends Error {
  constructor(message: string, public readonly absolute: string, public readonly worktree: string) {
    super(message);
    this.name = "ArchiveArtifactPathError";
  }
}

export class ArchiveArtifactEncodingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ArchiveArtifactEncodingError";
  }
}

const BASE64_STRICT_RE = /^[A-Za-z0-9+/]+={0,2}$/;

/** Heuristic: returns true if `s` looks like base64-encoded text that the
 * caller forgot to flag with encoding='base64'. We deliberately err toward
 * false positives only when the evidence is strong — long, strictly base64
 * alphabet, length divisible by 4, AND a high share of the decoded bytes
 * are non-printable. False negatives are fine (they archive intact); false
 * positives that wrongly reject legitimate UTF-8 text are not. */
function smellsLikeBase64(s: string): boolean {
  const stripped = s.replace(/\s+/g, "");
  if (stripped.length < 200) return false;
  if (stripped.length % 4 !== 0) return false;
  if (!BASE64_STRICT_RE.test(stripped)) return false;
  // Decode the first chunk and look at byte printability.
  let decoded: Buffer;
  try {
    decoded = Buffer.from(stripped.slice(0, 1024), "base64");
  } catch {
    return false;
  }
  if (decoded.length === 0) return false;
  let nonPrintable = 0;
  for (const b of decoded) {
    // Tab, LF, CR are fine; otherwise printable ASCII range 0x20..0x7e.
    if (b === 0x09 || b === 0x0a || b === 0x0d) continue;
    if (b < 0x20 || b > 0x7e) nonPrintable++;
  }
  // If >15% of decoded bytes are non-printable, it's probably not innocent
  // UTF-8 text that happened to look base64-shaped.
  return nonPrintable / decoded.length > 0.15;
}

/** Returns absolute paths of all candidate worktrees referenced by any
 * open stage of `run_id`. Inlined here (instead of imported from
 * best-of-n.ts) to avoid a circular dependency. */
function activeCandidateWorktrees(run_id: string): string[] {
  const rows = db()
    .prepare(`SELECT notes_json FROM stages WHERE run_id = ? AND status = 'open'`)
    .all(run_id) as Array<{ notes_json: string | null }>;
  const out: string[] = [];
  for (const r of rows) {
    if (!r.notes_json) continue;
    try {
      const parsed = JSON.parse(r.notes_json) as { best_of?: { candidate_paths?: string[] } };
      const paths = parsed.best_of?.candidate_paths;
      if (Array.isArray(paths)) {
        for (const p of paths) {
          if (typeof p === "string" && p.length > 0) out.push(p);
        }
      }
    } catch { /* ignore malformed notes */ }
  }
  return out;
}

function isInside(child: string, parent: string): boolean {
  const norm = (s: string) => s.replaceAll("\\", "/").replace(/\/$/, "");
  const c = norm(child).toLowerCase();
  const p = norm(parent).toLowerCase();
  return c === p || c.startsWith(p + "/");
}

export function archiveArtifact(input: ArchiveArtifactInput): ArchiveArtifactOutput {
  // Encoding handling. Default is utf8 — write `input.bytes` verbatim. When
  // encoding='base64' is set, decode first. When encoding is omitted, run a
  // smell heuristic and refuse rather than silently corrupting the artifact:
  // historical bug — Claude sub-agents would base64-encode payloads without
  // declaring it, and the daemon wrote the literal base64 string to disk.
  let payload: string | Buffer = input.bytes;
  if (input.encoding === "base64") {
    const stripped = input.bytes.replace(/\s+/g, "");
    if (!BASE64_STRICT_RE.test(stripped) || stripped.length % 4 !== 0) {
      throw new ArchiveArtifactEncodingError(
        `archive_artifact: encoding='base64' but bytes is not valid base64 ` +
        `(non-base64 characters or length not a multiple of 4).`,
      );
    }
    payload = Buffer.from(stripped, "base64");
  } else if (smellsLikeBase64(input.bytes)) {
    throw new ArchiveArtifactEncodingError(
      `archive_artifact: bytes appears to be base64-encoded but encoding was not declared. ` +
      `Pass encoding='base64' explicitly to decode before writing, or send plain UTF-8 ` +
      `as bytes. (This guard prevents the prior data-corruption bug where sub-agents ` +
      `base64-encoded markdown payloads and the daemon wrote the literal base64 string.)`,
    );
  }

  // Secrets scan runs against the actual payload (decoded if base64).
  const scanInput = typeof payload === "string"
    ? payload
    : payload.toString("utf8");
  const matches = scanForSecrets(scanInput);
  if (matches.length > 0) {
    throw new SecretsFoundError(matches);
  }

  const run = db()
    .prepare(`SELECT project_path FROM runs WHERE id = ?`)
    .get(input.run_id) as { project_path: string } | undefined;
  if (!run) throw new Error(`run ${input.run_id} not found`);

  const dir = projectArtifactDir(run.project_path, input.run_id);
  const absolute = join(dir, input.relative_path);
  const relPath = relative(run.project_path, absolute).replaceAll("\\", "/");

  // Path guard: refuse archives that resolve INSIDE an active candidate
  // worktree. Doing so caused the 2026-05-05 data-loss incident — the
  // engineer wrote registered artifacts inside candidate-3, then teardown
  // deleted the worktree and took the bytes with it. The candidate's
  // deliverable is the worktree contents (delivered via git merge);
  // archive_artifact is for run-level metadata only.
  const worktrees = activeCandidateWorktrees(input.run_id);
  for (const wt of worktrees) {
    if (isInside(absolute, wt)) {
      throw new ArchiveArtifactPathError(
        `archive_artifact rejected: relative_path "${input.relative_path}" resolves to ${absolute}, which is inside candidate worktree ${wt}. ` +
        `Archive paths must live under .harness/<run_id>/ but OUTSIDE any candidate worktree. ` +
        `The candidate's source belongs in the worktree itself (delivered via git merge); archive only run-level metadata (run.summary.md, INDEX.md, code/winner.diff, code/losers/*).`,
        absolute,
        wt,
      );
    }
  }

  // Manual-edit detection: if a prior artifact row exists for the same
  // (run_id, path) and the on-disk file's hash differs from the stored
  // hash, refuse to overwrite unless the caller passed force_overwrite.
  if (!input.force_overwrite && existsSync(absolute)) {
    const prior = db()
      .prepare(`SELECT sha256 FROM artifacts WHERE run_id = ? AND path = ? ORDER BY created_at DESC LIMIT 1`)
      .get(input.run_id, relPath) as { sha256: string } | undefined;
    if (prior) {
      const onDisk = readFileSync(absolute);
      const currentSha = createHash("sha256").update(onDisk).digest("hex");
      if (currentSha !== prior.sha256) {
        return {
          status: "manual_edit_detected",
          absolute_path: absolute,
          stored_sha: prior.sha256,
          current_sha: currentSha,
          message:
            `${relPath} was edited outside the harness since its last archive ` +
            `(stored=${prior.sha256.slice(0, 12)}…, current=${currentSha.slice(0, 12)}…). ` +
            `Pass force_overwrite=true to clobber, or merge the changes manually first.`,
        };
      }
    }
  }

  mkdirSync(join(absolute, "..").replace(/\\$/, ""), { recursive: true });
  if (typeof payload === "string") {
    writeFileSync(absolute, payload, "utf8");
  } else {
    writeFileSync(absolute, payload);
  }

  const sha256 = createHash("sha256").update(payload).digest("hex");
  const size = statSync(absolute).size;

  const id = `artifact_${nanoid(10)}`;
  txImmediate(() => {
    db()
      .prepare(
        `INSERT INTO artifacts(id, run_id, stage_id, taxonomy_section, kind, path, sha256, bytes, evidence_ref, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        input.run_id,
        input.stage_id ?? null,
        input.taxonomy_section ?? null,
        input.kind ?? null,
        relPath,
        sha256,
        size,
        input.evidence_ref ?? null,
        now()
      );
  });

  // T6: derive parent artifact ids and the generator agent/model for the
  // audit trace. Parents are the immediately preceding artifacts of this
  // stage (or the most recent artifacts of this run if no stage is set).
  // Best-effort — empty arrays are fine; this is provenance enrichment.
  let parentArtifactIds: string[] = [];
  let generatorAgent: string | null = null;
  let generatorModelId: string | null = null;
  try {
    if (input.stage_id) {
      parentArtifactIds = (db()
        .prepare(
          `SELECT id FROM artifacts
            WHERE run_id = ? AND stage_id = ? AND id != ?
            ORDER BY created_at DESC LIMIT 5`
        )
        .all(input.run_id, input.stage_id, id) as Array<{ id: string }>).map(r => r.id);
      const latestAttempt = db()
        .prepare(
          `SELECT producer, model_id FROM attempts
            WHERE stage_id = ?
            ORDER BY created_at DESC LIMIT 1`
        )
        .get(input.stage_id) as { producer: string; model_id: string } | undefined;
      if (latestAttempt) {
        generatorAgent = latestAttempt.producer;
        generatorModelId = latestAttempt.model_id;
      }
    }
  } catch { /* best-effort enrichment */ }

  // Fire-and-forget: classify the artifact's cell, record it as a memory,
  // and submit an audit-trace edge. The wrapper does its own DB back-write
  // to set artifacts.cell / .eights_memory_id / .eights_handle once
  // classification returns.
  void writeArtifactMemory({
    run_id: input.run_id,
    artifact_id: id,
    project_path: run.project_path,
    relative_path: relPath,
    taxonomy_section: input.taxonomy_section ?? null,
    kind: input.kind ?? null,
    sha256,
    content_for_classification: scanInput,
    parent_artifact_ids: parentArtifactIds,
    generator_agent: generatorAgent,
    model_id: generatorModelId,
  });

  return { status: "ok", artifact_id: id, absolute_path: absolute, sha256 };
}

export function listRuns(filter: { project_path?: string; status?: RunStatus; limit?: number }): unknown[] {
  const where: string[] = [];
  const params: unknown[] = [];
  if (filter.project_path) { where.push("project_path = ?"); params.push(filter.project_path); }
  if (filter.status)       { where.push("status = ?");       params.push(filter.status); }
  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const limit = Math.max(1, Math.min(filter.limit ?? 50, 500));
  return db()
    .prepare(`SELECT id, project_path, request_text, team, mode, status, started_at, finished_at FROM runs ${whereSql} ORDER BY started_at DESC LIMIT ?`)
    .all(...params, limit);
}

export function getRun(run_id: string): unknown {
  const run = db().prepare(`SELECT * FROM runs WHERE id = ?`).get(run_id);
  if (!run) return null;
  const stages = db().prepare(`SELECT * FROM stages WHERE run_id = ? ORDER BY started_at ASC`).all(run_id);
  const stageIds = (stages as Array<{ id: string }>).map(s => s.id);
  const attempts = stageIds.length
    ? db()
        .prepare(`SELECT * FROM attempts WHERE stage_id IN (${stageIds.map(() => "?").join(",")}) ORDER BY created_at ASC`)
        .all(...stageIds)
    : [];
  const attemptIds = (attempts as Array<{ id: string }>).map(a => a.id);
  const verdicts = attemptIds.length
    ? db()
        .prepare(`SELECT * FROM verdicts WHERE attempt_id IN (${attemptIds.map(() => "?").join(",")}) ORDER BY created_at ASC`)
        .all(...attemptIds)
    : [];
  const artifacts = db().prepare(`SELECT * FROM artifacts WHERE run_id = ? ORDER BY created_at ASC`).all(run_id);
  return { run, stages, attempts, verdicts, artifacts };
}

export type RecordTaxonomyMappingInput = {
  run_id: string;
  scope: "trivial" | "standard" | "major";
  signals: string[];
  sections: Array<{ id: string; title: string; rationale: string; required_artifacts: string[] }>;
  missability_required: string[];
};

export function recordTaxonomyMapping(input: RecordTaxonomyMappingInput): { ok: true } {
  ensureRunOpen(input.run_id);
  const json = JSON.stringify(input);
  txImmediate(() => {
    db().prepare(`UPDATE runs SET taxonomy_mapping_json = ? WHERE id = ?`).run(json, input.run_id);
  });
  // Also write a per-run artifact for human inspection.
  const run = db().prepare(`SELECT project_path FROM runs WHERE id = ?`).get(input.run_id) as { project_path: string };
  const dir = projectArtifactDir(run.project_path, input.run_id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "taxonomy_mapping.json"), JSON.stringify(input, null, 2), "utf8");
  return { ok: true };
}

export function budgetStatus(scope?: string): unknown {
  if (scope) {
    return db().prepare(`SELECT * FROM budgets WHERE scope = ?`).get(scope) ?? null;
  }
  return db().prepare(`SELECT * FROM budgets ORDER BY updated_at DESC LIMIT 100`).all();
}

// ─── helpers ─────────────────────────────────────────────────────────────

function ensureRunOpen(run_id: string): void {
  const run = db().prepare(`SELECT status FROM runs WHERE id = ?`).get(run_id) as
    | { status: RunStatus }
    | undefined;
  if (!run) throw new Error(`run ${run_id} not found`);
  if (run.status !== "running" && run.status !== "pending") {
    throw new Error(`run ${run_id} is not open (status=${run.status})`);
  }
}

function tallyBudgets(
  run_id: string,
  model_id: string,
  tier: ClaudeTier | null,
  tokens_in: number,
  tokens_out: number,
  cost_usd: number,
): void {
  const day = new Date().toISOString().slice(0, 10);
  const stmt = db().prepare(
    `INSERT INTO budgets(scope, tokens_in, tokens_out, cost_usd, updated_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(scope) DO UPDATE SET
       tokens_in  = tokens_in  + excluded.tokens_in,
       tokens_out = tokens_out + excluded.tokens_out,
       cost_usd   = cost_usd   + excluded.cost_usd,
       updated_at = excluded.updated_at`
  );
  stmt.run(`run:${run_id}`,    tokens_in, tokens_out, cost_usd, now());
  stmt.run(`day:${day}`,       tokens_in, tokens_out, cost_usd, now());
  stmt.run(`model:${model_id}`,tokens_in, tokens_out, cost_usd, now());
  if (tier) {
    stmt.run(`tier:${tier}`,   tokens_in, tokens_out, cost_usd, now());
  }
}

async function tryGitCommand(cwd: string, args: string[]): Promise<string | null> {
  try {
    const { stdout } = await execa("git", args, { cwd });
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

async function captureCliVersions(): Promise<Record<string, string | null>> {
  const out: Record<string, string | null> = {};
  for (const cli of ["codex", "gemini", "claude", "git", "node"]) {
    out[cli] = (await tryCmd(cli, ["--version"])) ?? null;
  }
  return out;
}

async function tryCmd(cmd: string, args: string[]): Promise<string | null> {
  try {
    // trackedExeca so doctor's CLI-version probes are registered in
    // ACTIVE_CHILDREN and aborted on shutdown (PP-RS-3 issue 1).
    const { stdout } = await trackedExeca(cmd, args);
    return (stdout ?? "").trim();
  } catch {
    return null;
  }
}

export type DoctorOptions = {
  /**
   * When true, exercise each configured vendor's `--model` resolution by
   * invoking the CLI with a tiny prompt and a short timeout. Catches the
   * "creds present but model id not served by installed CLI version" failure
   * mode (the bug behind run_vW1XuL7ko2SX where `gpt-5.5` resolved fine in
   * older CLIs but the locally-installed Codex couldn't reach it). Adds
   * 10–60s of wall-clock per vendor; opt-in by the user-facing /pp:doctor
   * skill, NOT by internal hook callers that need a fast doctor.
   */
  smoke?: boolean;
};

export async function doctor(opts: DoctorOptions = {}): Promise<unknown> {
  const cliVersions = await captureCliVersions();
  const dbReachable = (() => {
    try { db().prepare("SELECT 1").get(); return true; } catch { return false; }
  })();

  // Vendor configured = CLI installed AND a credential present (env var or
  // logged-in session detectable on disk). Pure binary presence is too
  // permissive — a freshly-installed CLI without an API key cannot serve
  // requests, so reporting "configured" would mislead /pp:doctor consumers
  // and hide cross-vendor outages until the first runtime call.
  const vendors: Record<string, boolean> = {
    openai:    cliVersions.codex  !== null && hasOpenAiCreds(),
    google:    cliVersions.gemini !== null && hasGoogleCreds(),
    anthropic: cliVersions.claude !== null && hasAnthropicCreds(),
  };
  const vendor_credentials: Record<string, { cli: boolean; api_key: boolean; logged_in: boolean }> = {
    openai: {
      cli: cliVersions.codex !== null,
      api_key: !!process.env.OPENAI_API_KEY,
      logged_in: codexLoggedIn(),
    },
    google: {
      cli: cliVersions.gemini !== null,
      api_key: !!process.env.GEMINI_API_KEY || !!process.env.GOOGLE_API_KEY,
      logged_in: geminiLoggedIn(),
    },
    anthropic: {
      cli: cliVersions.claude !== null,
      api_key: !!process.env.ANTHROPIC_API_KEY,
      logged_in: claudeLoggedIn(),
    },
  };
  const vendorCount = Object.values(vendors).filter(Boolean).length;

  // Critique smoke: opt-in. Exercises model resolution end-to-end so we catch
  // the gpt-5.5-not-served failure class before a real run hits it.
  type SmokeResult = {
    status: "ok" | "fail" | "skipped";
    model: string;
    exit_code?: number;
    stderr_tail?: string;
    wall_ms?: number;
    reason?: string;
  };
  const critique_smoke: Record<string, SmokeResult> = {
    codex:  { status: "skipped", model: DEFAULT_MODELS.codex_critique },
    gemini: { status: "skipped", model: DEFAULT_MODELS.gemini_critique },
  };
  if (opts.smoke) {
    if (vendors.openai)  critique_smoke.codex  = await codexCritiqueSmoke();
    if (vendors.google)  critique_smoke.gemini = await geminiCritiqueSmoke();
  }

  // Degraded = creds say "configured" but smoke reveals broken bridge.
  const vendor_degraded: Record<string, boolean> = {
    openai:    !!vendors.openai && critique_smoke.codex?.status  === "fail",
    google:    !!vendors.google && critique_smoke.gemini?.status === "fail",
    anthropic: false, // no smoke for in-process Claude judge
  };

  const browser_engines = await probeBrowserEngines();

  return {
    cli_versions: cliVersions,
    db_reachable: dbReachable,
    vendors_configured: vendors,
    vendor_credentials,
    judge_capabilities: describeJudgeCapabilities(),
    vendor_degraded,
    cross_vendor_ready: vendorCount >= 2,
    critique_smoke,
    browser_engines,
    db_path: (await import("../util/paths.js")).DB_PATH,
  };
}

/**
 * Probe browser-validation engine availability.
 *
 * `playwright` is daemon-side: we can dynamic-import @playwright/test and
 * try a no-op chromium launch. `chrome-mcp` is Claude-Code-side: the daemon
 * cannot reach across to Claude Code's MCP connection table, so we just
 * report "agent-side detection" and let the browser-validator agent probe
 * `mcp__claude-in-chrome__tabs_context_mcp` at runtime. This matches the
 * unavailable-fallback pattern used by visual-regression.ts.
 */
async function probeBrowserEngines(): Promise<{
  playwright: { status: "ok" | "missing_module" | "missing_chromium" | "launch_failed"; reason?: string };
  chrome_mcp: { status: "agent_probed_at_runtime"; note: string };
}> {
  let chromium: typeof import("playwright").chromium;
  try {
    ({ chromium } = await import("playwright"));
  } catch (err) {
    return {
      playwright: {
        status: "missing_module",
        reason: `@playwright/test not installed in daemon. Run: cd daemon && npm install`,
      },
      chrome_mcp: {
        status: "agent_probed_at_runtime",
        note: "browser-validator agent calls mcp__claude-in-chrome__tabs_context_mcp; if reachable, chrome-mcp is preferred over Playwright.",
      },
    };
  }
  let browser: import("playwright").Browser | null = null;
  try {
    browser = await chromium.launch({ headless: true });
    await browser.close();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      playwright: {
        status: /Executable doesn't exist|chromium/.test(msg) ? "missing_chromium" : "launch_failed",
        reason: `${msg.slice(0, 160)}. Try: cd daemon && npx playwright install chromium`,
      },
      chrome_mcp: {
        status: "agent_probed_at_runtime",
        note: "browser-validator agent calls mcp__claude-in-chrome__tabs_context_mcp at runtime.",
      },
    };
  }
  return {
    playwright: { status: "ok" },
    chrome_mcp: {
      status: "agent_probed_at_runtime",
      note: "browser-validator agent calls mcp__claude-in-chrome__tabs_context_mcp; if reachable, chrome-mcp is preferred over Playwright.",
    },
  };
}

const SMOKE_TIMEOUT_MS = 90 * 1000;
const SMOKE_ARTIFACT = "Smoke artifact: a tiny placeholder used to confirm the critique bridge returns a structured verdict.";
const SMOKE_RUBRIC =
  "Score 0..1 on correctness and minimality.\n" +
  "Return pass, fail, or revise according to the rubric and include a concise critique.";

async function codexCritiqueSmoke(): Promise<{
  status: "ok" | "fail" | "skipped";
  model: string;
  exit_code?: number;
  stderr_tail?: string;
  wall_ms?: number;
  reason?: string;
}> {
  const cwd = tmpdir();
  try {
    const run = await codexCritique({
      artifact_text: SMOKE_ARTIFACT,
      rubric_md: SMOKE_RUBRIC,
      cwd,
      model: DEFAULT_MODELS.codex_critique,
      timeout_ms: SMOKE_TIMEOUT_MS,
    }, {
      skip_git_repo_check: true,
    });
    if (run.exit_code === 0) {
      return { status: "ok", model: run.model, exit_code: 0, wall_ms: run.wall_ms };
    }
    const stderr_tail = run.attempts?.[run.attempts.length - 1]?.stderr_tail;
    return {
      status: "fail",
      model: run.model,
      exit_code: run.exit_code,
      stderr_tail,
      wall_ms: run.wall_ms,
      reason: run.reason ?? classifySmokeFailure(stderr_tail ?? ""),
    };
  } catch (err) {
    return {
      status: "fail",
      model: DEFAULT_MODELS.codex_critique,
      reason: `exception: ${(err as Error).message}`,
    };
  }
}

async function geminiCritiqueSmoke(): Promise<{
  status: "ok" | "fail" | "skipped";
  model: string;
  exit_code?: number;
  stderr_tail?: string;
  wall_ms?: number;
  reason?: string;
}> {
  const cwd = tmpdir();
  try {
    const run = await geminiCritique({
      artifact_text: SMOKE_ARTIFACT,
      rubric_md: SMOKE_RUBRIC,
      cwd,
      model: DEFAULT_MODELS.gemini_critique,
      timeout_ms: SMOKE_TIMEOUT_MS,
    });
    if (run.exit_code === 0) {
      return { status: "ok", model: run.model, exit_code: 0, wall_ms: run.wall_ms };
    }
    const stderr_tail = run.attempts?.[run.attempts.length - 1]?.stderr_tail;
    return {
      status: "fail",
      model: run.model,
      exit_code: run.exit_code,
      stderr_tail,
      wall_ms: run.wall_ms,
      reason: run.reason ?? classifySmokeFailure(stderr_tail ?? ""),
    };
  } catch (err) {
    return {
      status: "fail",
      model: DEFAULT_MODELS.gemini_critique,
      reason: `exception: ${(err as Error).message}`,
    };
  }
}

function classifySmokeFailure(stderr: string): string {
  if (!stderr) return "empty stderr (likely timeout or silent crash)";
  if (/model[^\n]{0,80}not found|unsupported model|no such model/i.test(stderr)) return "model not served by installed CLI";
  if (/authentication failed|invalid api key|not logged in/i.test(stderr)) return "auth failure";
  if (/command line is too long/i.test(stderr)) return "command-line too long (Windows ARG_MAX)";
  if (/enoent|not found|eacces/i.test(stderr)) return "binary missing or not executable";
  if (/timeout|timed out/i.test(stderr)) return "timeout";
  return "unknown error";
}

function hasOpenAiCreds(): boolean {
  return !!process.env.OPENAI_API_KEY || codexLoggedIn();
}

function hasGoogleCreds(): boolean {
  return !!process.env.GEMINI_API_KEY || !!process.env.GOOGLE_API_KEY || geminiLoggedIn();
}

function hasAnthropicCreds(): boolean {
  return !!process.env.ANTHROPIC_API_KEY || claudeLoggedIn();
}

/**
 * Best-effort detection of a logged-in Codex session. The Codex CLI stores
 * auth state under `~/.codex/auth.json` (or similar). We only need to know
 * whether a non-empty credential file exists — not validate it — because
 * any subsequent CLI call will fail loudly if the credential is bad.
 */
function codexLoggedIn(): boolean {
  try {
    const home = (process.env.USERPROFILE ?? process.env.HOME) ?? "";
    if (!home) return false;
    const candidates = [`${home}/.codex/auth.json`, `${home}/.codex/credentials.json`];
    for (const p of candidates) {
      try {
        const stat = statSync(p);
        if (stat.size > 0) return true;
      } catch { /* file missing */ }
    }
    return false;
  } catch { return false; }
}

/**
 * Detection of a Gemini logged-in session. The Gemini CLI persists OAuth
 * state at `~/.gemini/oauth_creds.json`. Same caveat — we only check
 * presence + non-empty, not validity.
 */
function geminiLoggedIn(): boolean {
  try {
    const home = (process.env.USERPROFILE ?? process.env.HOME) ?? "";
    if (!home) return false;
    const candidates = [`${home}/.gemini/oauth_creds.json`, `${home}/.gemini/credentials.json`];
    for (const p of candidates) {
      try {
        const stat = statSync(p);
        if (stat.size > 0) return true;
      } catch { /* file missing */ }
    }
    return false;
  } catch { return false; }
}

/**
 * Detection of a Claude Code logged-in session. The Claude CLI persists
 * credentials at `~/.claude/.credentials.json`. Same caveat — we only check
 * presence + non-empty, not validity.
 */
function claudeLoggedIn(): boolean {
  try {
    const home = (process.env.USERPROFILE ?? process.env.HOME) ?? "";
    if (!home) return false;
    const candidates = [`${home}/.claude/.credentials.json`, `${home}/.claude/credentials.json`];
    for (const p of candidates) {
      try {
        const stat = statSync(p);
        if (stat.size > 0) return true;
      } catch { /* file missing */ }
    }
    return false;
  } catch { return false; }
}
