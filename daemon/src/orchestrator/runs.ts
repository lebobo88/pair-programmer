import { nanoid } from "nanoid";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync, statSync, existsSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { execa } from "execa";
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
import { ProjectLock } from "../util/lock.js";
import { runCliWithRetry } from "../mcp/cli-runner.js";
import { tmpdir } from "node:os";
import { DEFAULT_MODELS } from "../config.js";
import { findPriorTestsPreStage, getLatestTddCheck } from "./tdd-gate.js";
import {
  requiredValidatorsForStage,
  type ValidatorKind,
} from "./artifact-validators/validator-policy.js";
import {
  getLatestArtifactValidation,
  type ArtifactValidationRow,
} from "./artifact-validators/index.js";

const now = () => new Date().toISOString();

export type StartRunInput = {
  request_text: string;
  project_path: string;
  mode: RunMode;
  team?: string;
  forum?: string;
  n?: number;
  session_id?: string;
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
    lock.acquire();
  } catch (err) {
    const e = err as { code?: string; message?: string };
    if (e.code === "EEXIST") {
      throw new Error(
        `another pp-daemon run already holds the project lock at ` +
        `${input.project_path}/.harness/.lock — wait for it to finish, or remove the file if no run is active.`
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

  const headSha = await tryGitCommand(input.project_path, ["rev-parse", "HEAD"]);
  const dirty = await tryGitCommand(input.project_path, ["status", "--porcelain"]);
  const treeDirtyHash = dirty
    ? createHash("sha256").update(dirty).digest("hex").slice(0, 16)
    : null;

  const cliVersions = await captureCliVersions();

  try {
    txImmediate(() => {
      db()
        .prepare(
          `INSERT INTO runs(
            id, session_id, project_path, request_text, team, mode, forum, n,
            status, profile_snapshot_json, taxonomy_mapping_json,
            head_sha, tree_dirty_hash, cli_versions_json, started_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
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
          startedAt
        );
    });
  } catch (err) {
    // Roll back the lock if the row never persisted.
    try { lock.release(); } catch { /* ignore */ }
    throw err;
  }

  log.info(
    { run_id: id, project_path: input.project_path, mode: input.mode, profile: !!profileSnapshotJson },
    "run started"
  );
  return { run_id: id, artifact_dir: dir, started_at: startedAt };
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

  txImmediate(() => {
    db()
      .prepare(
        `INSERT INTO attempts(
          id, stage_id, producer, model_id, prompt_hash, artifact_path,
          tokens_in, tokens_out, cost_usd, wall_ms,
          retry_index, parent_attempt_id, status, attempted_tier, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
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
    .prepare(`SELECT producer FROM attempts WHERE id = ?`)
    .get(input.attempt_id) as { producer: string } | undefined;
  if (!att) throw new Error(`attempt ${input.attempt_id} not found`);

  const genVendor = vendorFor(att.producer);
  const judgeVendor = vendorFor(input.judge_producer);
  const crossVendor = !!(genVendor && judgeVendor && genVendor !== judgeVendor);

  txImmediate(() => {
    db()
      .prepare(
        `INSERT INTO verdicts(
          id, attempt_id, judge_producer, judge_model_id, rubric_id,
          outcome, critique_md, score_json, cross_vendor, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
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
        now()
      );
  });

  return { verdict_id: id, cross_vendor: crossVendor };
}

export type FinalizeStageInput = {
  stage_id: string;
  winner_attempt_id?: string;
  status: StageStatus;
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

export function finalizeStage(input: FinalizeStageInput): void {
  // TDD execution gate. The harness has TDD-shaped team pipelines (refactor,
  // bug-fix, feature-tdd) where a `tests_pre` stage runs before the `code`
  // stage. To make the red/green property uncircumventable we refuse to mark
  // either stage `passed` unless tdd-gate.runTddCheck has recorded a verified
  // row. Surfacing/skipping is always allowed — that's how a TDD violation
  // gets reported up rather than swept under the rug.
  if (input.status === "passed") {
    const stageRow = db()
      .prepare(`SELECT id, kind FROM stages WHERE id = ?`)
      .get(input.stage_id) as { id: string; kind: string } | undefined;
    if (!stageRow) throw new Error(`stage ${input.stage_id} not found`);

    if (stageRow.kind === "tests_pre") {
      const check = getLatestTddCheck(input.stage_id, "pre");
      if (!check || check.status !== "verified") {
        throw new TddGateViolation(
          `finalize_stage refused: tests_pre stage ${input.stage_id} cannot be marked 'passed' without a verified tdd_check (phase='pre'). ` +
          (check
            ? `Latest check: status=${check.status}, expected=${check.expected}, actual=${check.actual}, reason=${check.reason ?? "n/a"}, output=${check.output_path ?? "n/a"}.`
            : `No tdd_check recorded yet. Call mcp__pp_harness__tdd_pre_check after the stage's judge passes.`) +
          ` To accept the violation, finalize the stage with status='surfaced' instead.`,
          input.stage_id,
          "pre",
          check,
        );
      }
    } else if (stageRow.kind === "code") {
      const prior = findPriorTestsPreStage(input.stage_id);
      if (prior) {
        const check = getLatestTddCheck(input.stage_id, "post");
        if (!check || check.status !== "verified") {
          throw new TddGateViolation(
            `finalize_stage refused: code stage ${input.stage_id} cannot be marked 'passed' because its immediate predecessor was tests_pre stage ${prior.stage_id} and no verified tdd_check (phase='post') exists. ` +
            (check
              ? `Latest check: status=${check.status}, expected=${check.expected}, actual=${check.actual}, reason=${check.reason ?? "n/a"}, output=${check.output_path ?? "n/a"}.`
              : `No tdd_check recorded yet. Call mcp__pp_harness__tdd_post_check after the code stage's judge passes.`) +
            ` To accept the violation, finalize the stage with status='surfaced' instead.`,
            input.stage_id,
            "post",
            check,
          );
        }
      }
    }

    // Artifact-validator gate. For every archived artifact on this stage,
    // walk the policy table (built-in defaults ∪ profile.required_validators)
    // and refuse 'passed' if any required validator has no row, a 'violation',
    // or an 'execution_error'. 'skipped' is allowed unless promoted to
    // 'execution_error' by profile.required_validators_strict (handled inside
    // runArtifactValidator). Surfacing always succeeds.
    const reqs = requiredValidatorsForStage(input.stage_id);
    for (const req of reqs) {
      for (const vk of req.validators) {
        const av = getLatestArtifactValidation(input.stage_id, vk, req.artifact_id);
        if (!av || av.status === "violation" || av.status === "execution_error") {
          throw new ValidatorGateViolation(
            `finalize_stage refused: artifact ${req.artifact_id} (kind=${req.artifact_kind ?? "n/a"}) requires validator '${vk}' but ` +
            (av
              ? `latest row is status=${av.status}, reason=${av.reason ?? "n/a"}, output=${av.output_path ?? "n/a"}.`
              : `no artifact_validations row exists yet. Call mcp__pp_harness__artifact_validate({stage_id: '${input.stage_id}', kind: '${vk}'}) after the judge passes.`) +
            ` To accept the violation, finalize the stage with status='surfaced' instead.`,
            input.stage_id,
            vk,
            req.artifact_id,
            av,
          );
        }
      }
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

export type FinalizeRunInput = {
  run_id: string;
  status: Extract<RunStatus, "complete" | "surfaced" | "aborted">;
  summary_md?: string;
};

export function finalizeRun(input: FinalizeRunInput): void {
  const run = db()
    .prepare(`SELECT project_path FROM runs WHERE id = ?`)
    .get(input.run_id) as { project_path: string } | undefined;
  if (!run) throw new Error(`run ${input.run_id} not found`);

  if (input.summary_md) {
    const dir = projectArtifactDir(run.project_path, input.run_id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "run.summary.md"), input.summary_md, "utf8");
  }

  txImmediate(() => {
    db()
      .prepare(`UPDATE runs SET status = ?, finished_at = ? WHERE id = ?`)
      .run(input.status, now(), input.run_id);
  });

  // Release the per-project advisory lock. Best-effort — janitor will clean
  // up if the daemon crashed before we got here.
  try {
    new ProjectLock(run.project_path).release();
  } catch { /* ignore */ }

  // On `complete`, patch PROJECT_MASTER.md with the run's contributions as a
  // safety net. The run-finalizer agent normally drives this in-band, but
  // running it here too means a finalize_run that bypassed the agent (e.g. a
  // direct daemon-tool call) still updates the master plan. The patcher is
  // idempotent: re-applying the same content does not duplicate sections.
  if (input.status === "complete") {
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

  log.info({ run_id: input.run_id, status: input.status }, "run finalized");
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
  bytes: string;               // utf-8 text content
  force_overwrite?: boolean;   // allow clobber when manual edits would otherwise block
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
  const matches = scanForSecrets(input.bytes);
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
      const onDisk = readFileSync(absolute, "utf8");
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
  writeFileSync(absolute, input.bytes, "utf8");

  const sha256 = createHash("sha256").update(input.bytes).digest("hex");
  const size = statSync(absolute).size;

  const id = `artifact_${nanoid(10)}`;
  txImmediate(() => {
    db()
      .prepare(
        `INSERT INTO artifacts(id, run_id, stage_id, taxonomy_section, kind, path, sha256, bytes, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
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
        now()
      );
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
    const { stdout } = await execa(cmd, args);
    return stdout.trim();
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
const SMOKE_PROMPT = "Reply with the single word OK and nothing else.";

async function codexCritiqueSmoke(): Promise<{
  status: "ok" | "fail" | "skipped";
  model: string;
  exit_code?: number;
  stderr_tail?: string;
  wall_ms?: number;
  reason?: string;
}> {
  const cwd = tmpdir();
  const cliArgs = [
    "exec", "--json", "--cd", cwd, "--sandbox", "read-only",
    // codex 0.128.0 requires cwd to be a git repo AND trusted unless this
    // flag is passed. tmpdir is neither — and shouldn't be (security). The
    // smoke is a 1-token ping with --sandbox read-only, so the trust check
    // is redundant here. Real /pp:run flows use the project cwd, which the
    // user trusts via ~/.codex/config.toml.
    "--skip-git-repo-check",
    "--model", DEFAULT_MODELS.codex_critique, "-",
  ];
  try {
    const run = await runCliWithRetry({
      bin: "codex",
      cliArgs,
      cwd,
      vendor: "codex",
      input: SMOKE_PROMPT,
      timeout_ms: SMOKE_TIMEOUT_MS,
    });
    if (run.exit_code === 0) {
      return { status: "ok", model: DEFAULT_MODELS.codex_critique, exit_code: 0, wall_ms: run.wall_ms };
    }
    return {
      status: "fail",
      model: DEFAULT_MODELS.codex_critique,
      exit_code: run.exit_code,
      stderr_tail: run.stderr.slice(-512),
      wall_ms: run.wall_ms,
      reason: classifySmokeFailure(run.stderr),
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
  const cliArgs = [
    "--model", DEFAULT_MODELS.gemini_critique,
    "--prompt", SMOKE_PROMPT,
    "--output-format", "json",
  ];
  try {
    const run = await runCliWithRetry({
      bin: "gemini",
      cliArgs,
      cwd,
      vendor: "gemini",
      timeout_ms: SMOKE_TIMEOUT_MS,
    });
    if (run.exit_code === 0) {
      return { status: "ok", model: DEFAULT_MODELS.gemini_critique, exit_code: 0, wall_ms: run.wall_ms };
    }
    return {
      status: "fail",
      model: DEFAULT_MODELS.gemini_critique,
      exit_code: run.exit_code,
      stderr_tail: run.stderr.slice(-512),
      wall_ms: run.wall_ms,
      reason: classifySmokeFailure(run.stderr),
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
