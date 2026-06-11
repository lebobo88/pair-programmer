/**
 * Best-of-N orchestration helpers. The daemon allocates N candidate
 * worktrees, computes diff entropy across candidate outputs to flag
 * low-diversity warnings, runs the Borda count for ranking when N>=3,
 * and archives losers when a winner is picked.
 *
 * Data-loss safeguards (post-incident-2026-05-05):
 *  1. archiveWinnerAndLosers auto-commits any uncommitted changes inside the
 *     winner's worktree before diffing, so `git diff HEAD <branch>` is real.
 *  2. An empty diff with HEAD == branch is treated as `merge_status="empty"`
 *     instead of being silently written as a 0-byte winner.diff.
 *  3. teardownCandidates queries the artifacts table for any rows whose path
 *     lies inside a candidate worktree, copies them to a sibling
 *     `preserved/candidate-N/` tree, and rewrites the DB paths BEFORE removing
 *     the worktree. If preservation fails, teardown aborts for that candidate
 *     unless the caller passed allow_data_loss=true.
 *  4. startBestOfStage refuses to open a stage when no non-Claude vendor is
 *     reachable, since cross-vendor judging is impossible in that state and
 *     /pp:best-of would burn candidate tokens with no path to a winner.
 */

import { mkdirSync, writeFileSync, readFileSync, existsSync, cpSync, rmSync, statSync, copyFileSync } from "node:fs";
import { join, dirname, relative, sep, isAbsolute, resolve as resolvePath } from "node:path";
import { trackedExeca, trackedExecaNoRefuse, SpawnRefusedError, isShuttingDown, enterCriticalOp, exitCriticalOp } from "../mcp/cli-runner.js";
import { nanoid } from "nanoid";
import { db, txImmediate } from "../db/database.js";
import { createWorktree } from "./worktree.js";
import { projectArtifactDir } from "../util/paths.js";
import { log } from "../util/logger.js";
import { doctor } from "./runs.js";

export type CandidateSlot = {
  candidate_index: number;       // 1..N (logical slot id, stable for the user-facing report)
  judge_position: number;        // 1..N (shuffled position used for judge prompts; mitigates position bias)
  attempt_slot_id: string;        // pre-allocated nanoid the driver passes to record_attempt
  worktree_path: string;
  worktree_mode: "git-worktree" | "copy" | "in-place";
};

export async function startBestOfStage(opts: {
  run_id: string;
  kind: string;
  gate_type: string;
  n: number;
}): Promise<{ stage_id: string; candidates: CandidateSlot[]; shuffle_seed: number }> {
  if (opts.n < 2 || opts.n > 8) throw new Error(`n must be in [2, 8], got ${opts.n}`);

  // Precondition: best-of-N now runs all candidates as Claude, so judging
  // requires at least one non-Claude vendor (codex OR gemini) reachable.
  // Without that, every cross-vendor gate would refuse and the run can never
  // pick a winner. Fail fast before candidates burn tokens.
  if (process.env.PP_ALLOW_BEST_OF_WITHOUT_JUDGE !== "1") {
    const report = (await doctor()) as { vendors_configured?: Record<string, boolean> };
    const vendors = report.vendors_configured ?? {};
    const nonClaudeReachable = !!vendors.openai || !!vendors.google;
    if (!nonClaudeReachable) {
      throw new Error(
        "best-of-N refused: candidates run as Claude, so judging needs at least one non-Claude vendor (openai or google) reachable. " +
        "Configure codex (openai) or gemini (google) credentials, then retry. " +
        "Override with PP_ALLOW_BEST_OF_WITHOUT_JUDGE=1 (same-vendor Claude judging only — cross-vendor gates will refuse).",
      );
    }
  }

  const run = db()
    .prepare(`SELECT project_path, status FROM runs WHERE id = ?`)
    .get(opts.run_id) as { project_path: string; status: string } | undefined;
  if (!run) throw new Error(`run ${opts.run_id} not found`);
  if (run.status !== "running" && run.status !== "pending") {
    throw new Error(`run ${opts.run_id} is not open (status=${run.status})`);
  }

  const stage_id = `stage_${nanoid(10)}`;
  const nowIso = new Date().toISOString();

  // Seeded Fisher-Yates shuffle of judge positions. Logical candidate_index
  // (1..N) is stable for user-facing reporting; judge_position is the
  // randomized order judges see. Persist the seed so a replay can
  // reconstruct the exact shuffle.
  const seed = Math.floor(Math.random() * 0xffffffff);
  const judgeOrder = seededShuffle([...Array(opts.n).keys()].map(i => i + 1), seed);

  const baseDir = join(projectArtifactDir(run.project_path, opts.run_id), opts.kind);
  mkdirSync(baseDir, { recursive: true });

  const candidates: CandidateSlot[] = [];
  for (let i = 1; i <= opts.n; i++) {
    const wtPath = join(baseDir, `candidate-${i}`);
    const wt = await createWorktree({
      projectPath: run.project_path,
      workdirPath: wtPath,
      branch: `pp/${opts.run_id}/${opts.kind}/c${i}`,
    });
    candidates.push({
      candidate_index: i,
      judge_position: judgeOrder.indexOf(i) + 1,
      attempt_slot_id: `attempt_${nanoid(10)}`,
      worktree_path: wt.path,
      worktree_mode: wt.mode,
    });
  }

  // Persist candidate paths in stage notes_json so archive_artifact and the
  // path-guard can detect when a caller tries to write inside an active
  // candidate worktree.
  txImmediate(() => {
    db()
      .prepare(
        `INSERT INTO stages(id, run_id, kind, gate_type, status, started_at, notes_json)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        stage_id,
        opts.run_id,
        opts.kind,
        opts.gate_type,
        "open",
        nowIso,
        JSON.stringify({
          best_of: {
            n: opts.n,
            shuffle_seed: seed,
            judge_order: judgeOrder,
            candidate_paths: candidates.map(c => c.worktree_path),
          },
        }),
      );
  });

  return { stage_id, candidates, shuffle_seed: seed };
}

/**
 * Returns the absolute paths of every candidate worktree in any open stage of
 * the given run. archive_artifact uses this to reject writes that resolve
 * inside one of these paths.
 */
export function activeCandidatePaths(run_id: string): string[] {
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
    } catch {
      // Ignore malformed notes_json — older stages may predate the schema.
    }
  }
  return out;
}

// ─── Runtime smoke-test gate (post-incident-2026-05-05 sonnet-crash) ─────
//
// The engineer sub-agent runs a runtime smoke test (boot dev server, curl /,
// scan logs for crash patterns) before commit on UI projects. The result is
// persisted here as a stage-level field so archiveWinnerAndLosers can refuse
// to merge a candidate that compiled but crashes at runtime — even if the
// driver-level instructions in best-of.md are bypassed.

export type SmokeStatus = "pass" | "fail" | "infra_error" | "skipped";

export type SmokeResult = {
  status: SmokeStatus;
  reason: string | null;
  recorded_at: string;
};

export function recordSmokeStatus(opts: {
  stage_id: string;
  candidate_index: number;
  status: SmokeStatus;
  reason?: string;
}): { ok: true } {
  txImmediate(() => {
    const row = db()
      .prepare(`SELECT notes_json FROM stages WHERE id = ?`)
      .get(opts.stage_id) as { notes_json: string | null } | undefined;
    if (!row) throw new Error(`stage ${opts.stage_id} not found`);
    const notes = (row.notes_json ? JSON.parse(row.notes_json) : {}) as {
      smoke_results?: Record<string, SmokeResult>;
      [k: string]: unknown;
    };
    notes.smoke_results = notes.smoke_results ?? {};
    notes.smoke_results[String(opts.candidate_index)] = {
      status: opts.status,
      reason: opts.reason ?? null,
      recorded_at: new Date().toISOString(),
    };
    db()
      .prepare(`UPDATE stages SET notes_json = ? WHERE id = ?`)
      .run(JSON.stringify(notes), opts.stage_id);
  });
  return { ok: true };
}

export function getSmokeResults(stage_id: string): Record<number, SmokeResult> {
  const row = db()
    .prepare(`SELECT notes_json FROM stages WHERE id = ?`)
    .get(stage_id) as { notes_json: string | null } | undefined;
  if (!row?.notes_json) return {};
  try {
    const notes = JSON.parse(row.notes_json) as { smoke_results?: Record<string, SmokeResult> };
    const raw = notes.smoke_results ?? {};
    const out: Record<number, SmokeResult> = {};
    for (const [k, v] of Object.entries(raw)) out[Number(k)] = v;
    return out;
  } catch {
    return {};
  }
}

/** Seeded Fisher-Yates. Same seed produces same permutation. */
function seededShuffle<T>(arr: T[], seed: number): T[] {
  const out = arr.slice();
  let s = seed >>> 0;
  const next = () => {
    // xorshift32 — deterministic, 32-bit, good enough for shuffle.
    s ^= s << 13; s >>>= 0;
    s ^= s >>> 17; s >>>= 0;
    s ^= s << 5;  s >>>= 0;
    return s / 0x100000000;
  };
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(next() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

/**
 * Compute pairwise text similarity for the candidate artifact bytes.
 * Returns the maximum pairwise similarity (0..1). Used for the
 * "low-diversity warning" — if max_similarity > 0.9, the driver should
 * surface a warning that all candidates converged on the same answer.
 */
export function diffEntropy(opts: {
  candidate_texts: string[];
}): { max_similarity: number; pairwise: number[][]; warning: string | null } {
  const texts = opts.candidate_texts;
  const n = texts.length;
  const matrix: number[][] = Array.from({ length: n }, () => Array(n).fill(0));
  let maxSim = 0;

  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const sim = jaccardLines(texts[i] ?? "", texts[j] ?? "");
      matrix[i]![j] = sim;
      matrix[j]![i] = sim;
      if (sim > maxSim) maxSim = sim;
    }
  }
  const warning = maxSim > 0.9
    ? `low-diversity warning: max pairwise similarity ${maxSim.toFixed(3)} > 0.9. Consider adding a failing test before generating, or invoke /pp:best-of with a devil's-advocate seed.`
    : null;
  return { max_similarity: maxSim, pairwise: matrix, warning };
}

function jaccardLines(a: string, b: string): number {
  const aLines = new Set(a.split(/\r?\n/).map(s => s.trim()).filter(Boolean));
  const bLines = new Set(b.split(/\r?\n/).map(s => s.trim()).filter(Boolean));
  if (aLines.size === 0 && bLines.size === 0) return 1;
  let intersect = 0;
  for (const line of aLines) if (bLines.has(line)) intersect++;
  const union = aLines.size + bLines.size - intersect;
  return union === 0 ? 0 : intersect / union;
}

/**
 * Borda count over judges' rankings. Each ranking is an ordered list of
 * candidate ids (best first). Each candidate gets `(N - position)` points
 * per ranking. The candidate with the highest total wins; ties are broken
 * by lower mean position, then by id (deterministic).
 */
export function bordaCount(opts: {
  candidate_ids: string[];
  rankings: string[][];        // each is an ordered list (best first) of candidate ids
}): {
  winner: string;
  scores: Array<{ candidate_id: string; total_points: number; mean_position: number }>;
} {
  const N = opts.candidate_ids.length;
  if (N === 0) throw new Error("no candidates");

  const points = new Map<string, { total: number; positions: number[] }>();
  for (const id of opts.candidate_ids) points.set(id, { total: 0, positions: [] });

  for (const ranking of opts.rankings) {
    for (let pos = 0; pos < ranking.length; pos++) {
      const id = ranking[pos];
      if (!id) continue;
      const cell = points.get(id);
      if (!cell) continue;       // unknown candidate — skip
      cell.total += N - pos;
      cell.positions.push(pos);
    }
  }

  const scores = opts.candidate_ids
    .map(id => {
      const cell = points.get(id)!;
      const mean = cell.positions.length ? cell.positions.reduce((a, b) => a + b, 0) / cell.positions.length : N;
      return { candidate_id: id, total_points: cell.total, mean_position: mean };
    })
    .sort((a, b) => {
      if (b.total_points !== a.total_points) return b.total_points - a.total_points;
      if (a.mean_position !== b.mean_position) return a.mean_position - b.mean_position;
      return a.candidate_id.localeCompare(b.candidate_id);
    });

  return { winner: scores[0]!.candidate_id, scores };
}

/**
 * Auto-commit any uncommitted changes inside the candidate worktree so that
 * `git diff HEAD <branch>` reflects the engineer's actual output. Idempotent
 * — if the worktree is already clean we still attempt an --allow-empty no-op
 * commit so HEAD advances past the base. Errors are logged but not thrown:
 * the caller will detect via the empty-diff check downstream.
 */
async function autoCommitCandidate(opts: {
  cwd: string;
  run_id: string;
  candidate_index: number;
}): Promise<{ committed: boolean; was_dirty: boolean; reason?: string }> {
  try {
    const { stdout: _porcelain } = await trackedExeca("git", ["status", "--porcelain"], { cwd: opts.cwd, windowsHide: true });
    const porcelain = (_porcelain ?? "") as string;
    const dirty = porcelain.trim().length > 0;
    if (!dirty) {
      // Worktree is clean -- do NOT commit. A --allow-empty commit would
      // advance HEAD past the base and defeat the empty-diff detector
      // downstream. Leaving the branch tip equal to base lets the detector
      // correctly classify this as merge_status="empty".
      return { committed: false, was_dirty: false };
    }
    await trackedExeca("git", ["add", "-A"], { cwd: opts.cwd, windowsHide: true });
    await trackedExeca(
      "git",
      [
        "-c", "user.email=harness@pp",
        "-c", "user.name=pp-harness",
        "commit",
        "-m", `pp(${opts.run_id}): auto-snapshot candidate-${opts.candidate_index}`,
      ],
      { cwd: opts.cwd, windowsHide: true },
    );
    return { committed: true, was_dirty: true };
  } catch (err) {
    const e = err as { stderr?: string; stdout?: string };
    log.warn(
      { err: `${e.stderr ?? ""}\n${e.stdout ?? ""}`.slice(0, 512), cwd: opts.cwd },
      "auto-commit failed for candidate",
    );
    return { committed: false, was_dirty: false, reason: (e.stderr ?? e.stdout ?? "unknown").toString().slice(0, 256) };
  }
}

/**
 * Merge the winning candidate's worktree back into the project tree.
 *
 * git mode:
 *   1. Auto-commit any uncommitted changes in the winner's worktree (new in v2).
 *   2. Archive `winner.diff` for audit (HEAD..branch). If empty AND
 *      HEAD == branch, return merge_status="empty" — do NOT write a 0-byte
 *      winner.diff and do NOT proceed to merge.
 *   3. `git merge --no-ff <branch>` onto the current HEAD.
 *   4. On conflict, leave conflict markers in place, record `merge_status:
 *      "conflict"` and the conflicting paths so the driver can flip the run
 *      to `surfaced`.
 *
 * copy-mode (non-git):
 *   1. Compute a path-list diff between project and candidate.
 *   2. Copy candidate files over the project tree directly. There is no
 *      conflict detection — the project root snapshot was taken at run
 *      start, so this is best-effort.
 *
 * Losers are archived under `<run_id>/<stage_kind>/losers/candidate-N/` either way.
 */
export async function archiveWinnerAndLosers(opts: {
  run_id: string;
  stage_id: string;
  stage_kind: string;
  winner_candidate_index: number;
  candidate_paths: string[];        // absolute paths in candidate-{1..N} order
}): Promise<{
  winner_diff_path: string | null;
  losers_archived: number;
  merge_status: "merged" | "conflict" | "copy" | "skipped" | "empty" | "smoke_failed";
  conflict_paths?: string[];
  empty_reason?: string;
  smoke_failed_reason?: string;
}> {
  const run = db()
    .prepare(`SELECT project_path FROM runs WHERE id = ?`)
    .get(opts.run_id) as { project_path: string } | undefined;
  if (!run) throw new Error(`run ${opts.run_id} not found`);

  // Smoke gate: refuse to merge a winner that crashed at runtime. The engineer
  // records smoke status via recordSmokeStatus; if the chosen winner has
  // status="fail", we still archive losers (so the user can inspect them) but
  // skip the winner's auto-commit / diff / merge. The driver treats the
  // returned merge_status="smoke_failed" as a surfaced run.
  const smokeAll = getSmokeResults(opts.stage_id);
  const winnerSmoke = smokeAll[opts.winner_candidate_index];
  const smokeBypass = process.env.PP_ALLOW_SMOKE_FAILED_WINNER === "1";
  if (winnerSmoke?.status === "fail" && !smokeBypass) {
    log.warn(
      { stage_id: opts.stage_id, winner: opts.winner_candidate_index, reason: winnerSmoke.reason },
      "best-of-N winner smoke-failed; refusing merge",
    );
    const stageDirEarly = join(projectArtifactDir(run.project_path, opts.run_id), opts.stage_kind);
    const losersDirEarly = join(stageDirEarly, "losers");
    mkdirSync(losersDirEarly, { recursive: true });
    let losers_archived_early = 0;
    for (let i = 0; i < opts.candidate_paths.length; i++) {
      const idx = i + 1;
      if (idx === opts.winner_candidate_index) continue;
      const candPath = opts.candidate_paths[i]!;
      const dest = join(losersDirEarly, `candidate-${idx}`);
      if (existsSync(candPath)) {
        try {
          mkdirSync(dest, { recursive: true });
          // Point-of-action guard: smoke-failed path can execute during shutdown.
          if (isShuttingDown()) throw new SpawnRefusedError("shutdown in progress — aborting smoke-failed loser cpSync");
          cpSync(candPath, dest, { recursive: true, force: true });
          losers_archived_early++;
        } catch (err) {
          if (err instanceof SpawnRefusedError) throw err;
          log.warn({ err, src: candPath, dest }, "archive loser failed (smoke-gated path)");
        }
      }
    }
    return {
      winner_diff_path: null,
      losers_archived: losers_archived_early,
      merge_status: "smoke_failed",
      smoke_failed_reason:
        `winner candidate-${opts.winner_candidate_index} failed runtime smoke test: ${winnerSmoke.reason ?? "(no reason recorded)"}. ` +
        `Set PP_ALLOW_SMOKE_FAILED_WINNER=1 to override.`,
    };
  }

  const stageDir = join(projectArtifactDir(run.project_path, opts.run_id), opts.stage_kind);
  const losersDir = join(stageDir, "losers");
  mkdirSync(losersDir, { recursive: true });

  let winner_diff_path: string | null = null;
  let losers_archived = 0;
  let merge_status: "merged" | "conflict" | "copy" | "skipped" | "empty" = "skipped";
  let conflict_paths: string[] | undefined;
  let empty_reason: string | undefined;

  for (let i = 0; i < opts.candidate_paths.length; i++) {
    const idx = i + 1;
    const candPath = opts.candidate_paths[i]!;

    if (idx === opts.winner_candidate_index) {
      const branch = `pp/${opts.run_id}/${opts.stage_kind}/c${idx}`;

      // Step 1: auto-commit anything still uncommitted in the winner branch.
      // Without this, `git diff HEAD <branch>` returns empty for engineers
      // that wrote files but never committed (the bug from run_vW1XuL7ko2SX).
      if (existsSync(candPath) && existsSync(join(candPath, ".git"))) {
        await autoCommitCandidate({ cwd: candPath, run_id: opts.run_id, candidate_index: idx });
      }

      // Step 2: archive the diff for audit, regardless of merge outcome.
      let diffStdout = "";
      let gitDiffOk = false;
      try {
        const result = await trackedExeca("git", ["diff", "HEAD", branch], { cwd: run.project_path, windowsHide: true });
        diffStdout = (result.stdout ?? "") as string;
        gitDiffOk = true;
      } catch (err) {
        // Abort if refused-before-spawn OR killed-mid-flight during shutdown.
        // Copying over the project root during shutdown would be destructive.
        if (err instanceof SpawnRefusedError || isShuttingDown()) throw err;
        log.warn({ err }, "git diff failed for winner; falling back to candidate-tree archive");
        const fallback = join(stageDir, "winner.tree");
        if (existsSync(candPath)) {
          // Point-of-action guard: shutdown may have started while we awaited git.
          if (isShuttingDown()) throw new SpawnRefusedError("shutdown in progress — aborting winner-tree cpSync");
          mkdirSync(fallback, { recursive: true });
          cpSync(candPath, fallback, { recursive: true, force: true });
          winner_diff_path = relative(run.project_path, fallback).replaceAll("\\", "/");
          // Non-git path: copy the winner tree directly over the project.
          // CRITICAL SECTION: once cpSync begins writing into project_path, a
          // SIGKILL mid-write leaves a partial tree.  enterCriticalOp() signals
          // abortAllInFlightChildren to use the extended ABORT_CRITICAL_GRACE_MS
          // so this copy can complete atomically in the common case.
          // SIGKILL after the critical grace cap is still the final backstop;
          // the catch block below emits a recovery note if that happens.
          let copyMergeStarted = false;
          enterCriticalOp();
          try {
            // Pre-action guard: do not start IF shutdown already in progress.
            if (isShuttingDown()) throw new SpawnRefusedError("shutdown in progress — aborting copy-mode merge-back");
            copyMergeStarted = true;
            cpSync(candPath, run.project_path, { recursive: true, force: true });
            merge_status = "copy";
          } catch (copyErr) {
            if (copyErr instanceof SpawnRefusedError) {
              // Interrupted during shutdown.  Log recovery note regardless of
              // whether the copy had started (partial write is possible only if
              // copyMergeStarted=true).
              if (copyMergeStarted) {
                const recoveryNote =
                  `winner copy-mode merge-back into ${run.project_path} was interrupted by shutdown; ` +
                  `the project directory may contain a partially-copied tree. ` +
                  `Recovery: inspect the directory, restore from git, or re-run the workflow. ` +
                  `Note: copy-mode is used only for non-git project directories.`;
                log.error(
                  { run_id: opts.run_id, project_path: run.project_path, recovery_note: recoveryNote },
                  "SHUTDOWN INTERRUPTED copy-mode merge-back — manual recovery may be required",
                );
                // Annotate the run record so /pp:doctor and operators can see it.
                try {
                  txImmediate(() => {
                    db()
                      .prepare(`UPDATE runs SET notes_json = json_patch(COALESCE(notes_json, '{}'), ?) WHERE id = ?`)
                      .run(JSON.stringify({ merge_interrupted: true, recovery_note: recoveryNote }), opts.run_id);
                  });
                } catch { /* best-effort — we are shutting down */ }
              }
              throw copyErr;
            }
            log.warn({ err: copyErr }, "copy-mode merge-back failed");
          } finally {
            exitCriticalOp();
          }
          continue;  // skip the git merge attempt below for non-git
        }
      }

      if (gitDiffOk) {
        // Empty-diff detection: if the diff is empty AND HEAD already points
        // at the branch tip (or the branch has no commits ahead of HEAD),
        // treat as a hard error rather than silently writing 0 bytes.
        if (diffStdout.length === 0) {
          let baseSame = false;
          try {
            const a = ((await trackedExeca("git", ["rev-parse", "HEAD"], { cwd: run.project_path, windowsHide: true })).stdout ?? "").toString().trim();
            const b = ((await trackedExeca("git", ["rev-parse", branch], { cwd: run.project_path, windowsHide: true })).stdout ?? "").toString().trim();
            baseSame = a === b;
          } catch (err) {
            // Propagate on shutdown — killed mid-flight means we can't trust the
            // result; continuing to a merge during shutdown is unsafe.
            if (err instanceof SpawnRefusedError || isShuttingDown()) throw err;
            // If rev-parse fails the branch likely has no commits; treat as empty too.
            baseSame = true;
          }
          if (baseSame) {
            merge_status = "empty";
            empty_reason =
              `winner candidate-${idx} produced no committed changes (HEAD == ${branch}). ` +
              `The engineer either wrote nothing or wrote files without committing them. ` +
              `Auto-commit was attempted; if it also produced no diff, the worktree was empty.`;
            log.warn({ branch, candPath }, empty_reason);
            // Skip writing winner.diff and skip the merge step.
            continue;
          }
        }

        // Real, non-empty diff — write it for audit.
        // Point-of-action guard: shutdown may have begun while awaiting git calls above.
        if (isShuttingDown()) throw new SpawnRefusedError("shutdown in progress — aborting winner.diff writeFileSync");
        const diffPath = join(stageDir, "winner.diff");
        writeFileSync(diffPath, diffStdout, "utf8");
        winner_diff_path = relative(run.project_path, diffPath).replaceAll("\\", "/");
      }

      // Step 3: merge the winner branch into HEAD.
      //
      // CRITICAL SECTION: git merge writes into the user's project_path.  Once
      // it has started, a SIGKILL mid-write leaves an in-progress merge state
      // (MERGE_HEAD, partial index).  enterCriticalOp() signals the drain loop
      // to use ABORT_CRITICAL_GRACE_MS (10 s) instead of ABORT_GRACEFUL_MS (2 s)
      // so a small merge can finish atomically in the common case.
      //
      // Residual: if the critical grace cap is exceeded, SIGKILL is sent and git
      // leaves a RECOVERABLE (not corrupt) state — MERGE_HEAD + index are intact
      // and the user can run `git merge --abort` or `git reset --hard` to recover.
      // The catch block below detects this case and emits a recovery note.
      //
      // Pre-spawn guard: do not start if shutdown already in progress.
      if (isShuttingDown()) throw new SpawnRefusedError("shutdown in progress — aborting git merge before spawn");
      let mergeSpawned = false;
      enterCriticalOp();
      try {
        mergeSpawned = true;
        await trackedExeca(
          "git",
          ["merge", "--no-ff", "-m", `pp(${opts.run_id}): apply best-of-N winner ${branch}`, branch],
          { cwd: run.project_path, windowsHide: true },
        );
        merge_status = "merged";
      } catch (err) {
        // Abort if refused-before-spawn OR killed-mid-flight during shutdown.
        // A shutdown-killed merge must not be misread as a real conflict — that
        // would trigger status/porcelain/cpSync archiving during shutdown.
        if (err instanceof SpawnRefusedError || isShuttingDown()) {
          // Recovery note: if the merge had already spawned (mergeSpawned=true),
          // the git process may have been killed mid-write.  git leaves a
          // recoverable MERGE_HEAD/index state — NOT silent corruption.  Emit
          // a recovery note so the operator knows exactly what to do.
          if (mergeSpawned) {
            const recoveryNote =
              `winner merge-back into ${run.project_path} was interrupted by shutdown; ` +
              `the repo may have an in-progress merge — run \`git merge --abort\` or ` +
              `\`git status\` / \`git reset --hard\` to recover. ` +
              `git leaves a recoverable MERGE_HEAD/index state, not silent corruption.`;
            log.error(
              { run_id: opts.run_id, project_path: run.project_path, recovery_note: recoveryNote },
              "SHUTDOWN INTERRUPTED git merge — manual recovery may be required (git merge --abort)",
            );
            // Annotate the run record so /pp:doctor and operators can see it.
            try {
              txImmediate(() => {
                db()
                  .prepare(`UPDATE runs SET notes_json = json_patch(COALESCE(notes_json, '{}'), ?) WHERE id = ?`)
                  .run(JSON.stringify({ merge_interrupted: true, recovery_note: recoveryNote }), opts.run_id);
              });
            } catch { /* best-effort — we are shutting down */ }
          }
          throw err;
        }
        const e = err as { stdout?: string; stderr?: string };
        const text = `${e.stdout ?? ""}\n${e.stderr ?? ""}`;
        // Detect conflicts via `git status --porcelain` in case the merge errored mid-way.
        try {
          const { stdout: _conflictOut } = await trackedExeca("git", ["status", "--porcelain"], { cwd: run.project_path, windowsHide: true });
          const conflictOut = (_conflictOut ?? "") as string;
          conflict_paths = conflictOut
            .split(/\r?\n/)
            .map((l: string) => l.trim())
            .filter((l: string) => /^(UU|AA|DD|AU|UA|DU|UD)\b/.test(l))
            .map((l: string) => l.replace(/^[A-Z]{2}\s+/, ""));
        } catch (statusErr) {
          // Inner status killed during shutdown — propagate rather than silently
          // continuing to conflict archiving with unknown repository state.
          if (statusErr instanceof SpawnRefusedError || isShuttingDown()) throw statusErr;
          /* genuine status failure: proceed with empty conflict_paths */
        }
        // Point-of-action guard: shutdown may have begun while awaiting status.
        if (isShuttingDown()) throw new SpawnRefusedError("shutdown in progress — aborting conflict archiving");
        merge_status = "conflict";
        log.warn({ err: text.slice(0, 512), conflict_paths }, "best-of-N winner merge failed");
        // Leave conflict markers in place — driver will surface the run.
      } finally {
        exitCriticalOp();
      }
    } else {
      const dest = join(losersDir, `candidate-${idx}`);
      if (existsSync(candPath)) {
        try {
          mkdirSync(dest, { recursive: true });
          // Point-of-action guard: skip loser archiving if shutdown began mid-loop.
          if (isShuttingDown()) throw new SpawnRefusedError("shutdown in progress — aborting loser cpSync");
          cpSync(candPath, dest, { recursive: true, force: true });
          losers_archived++;
        } catch (err) {
          if (err instanceof SpawnRefusedError) throw err;
          log.warn({ err, src: candPath, dest }, "archive loser failed");
        }
      }
    }
  }

  return { winner_diff_path, losers_archived, merge_status, conflict_paths, empty_reason };
}

/**
 * Tear down a candidate worktree (post-archive). Safety: if the worktree
 * contains files referenced by the artifacts table, those files are first
 * copied to `<run_id>/<stage_kind>/preserved/candidate-N/<rest>` and the DB
 * row's path is rewritten. If preservation fails for any file, teardown for
 * that candidate ABORTS and the worktree is left in place — the caller must
 * inspect `teardown_status` and surface to the user. To bypass preservation
 * (the rare case where the user explicitly wants destruction), pass
 * `allow_data_loss: true`.
 */
export async function teardownCandidates(opts: {
  project_path: string;
  candidate_paths: string[];
  run_id: string;
  stage_kind: string;
  allow_data_loss?: boolean;
}): Promise<{
  teardown_status: "ok" | "preserve_failed" | "partial";
  preserved: Array<{ candidate_index: number; from: string; to: string; artifact_id: string }>;
  not_torn_down: number[];
}> {
  const allowDataLoss = !!opts.allow_data_loss;
  const preserved: Array<{ candidate_index: number; from: string; to: string; artifact_id: string }> = [];
  const notTornDown: number[] = [];
  const baseHarnessDir = projectArtifactDir(opts.project_path, opts.run_id);

  for (let i = 0; i < opts.candidate_paths.length; i++) {
    const idx = i + 1;
    const path = opts.candidate_paths[i]!;
    const branch = `pp/${opts.run_id}/${opts.stage_kind}/c${idx}`;

    // Compute the relative-path prefix used by archive_artifact for this
    // candidate worktree. Paths in `artifacts.path` are stored relative to
    // <project>/.harness/<run_id>/, so a candidate at
    // <project>/.harness/<run_id>/code/candidate-1/<rest> stores rows whose
    // path starts with `code/candidate-1/`.
    const relCandidate = relative(baseHarnessDir, path).replaceAll("\\", "/");
    const pathPrefix = `${relCandidate}/`;

    const rows = db()
      .prepare(`SELECT id, path FROM artifacts WHERE run_id = ? AND path LIKE ?`)
      .all(opts.run_id, `${pathPrefix}%`) as Array<{ id: string; path: string }>;

    let preserveFailed = false;
    if (rows.length > 0) {
      if (allowDataLoss) {
        log.warn(
          { candidate_index: idx, path, count: rows.length },
          "teardown: allow_data_loss=true — destroying candidate worktree even though artifacts reference it",
        );
      } else {
        const preservedRel = `${opts.stage_kind}/preserved/candidate-${idx}`;
        const preservedAbs = join(baseHarnessDir, preservedRel);
        for (const row of rows) {
          const fromAbs = join(baseHarnessDir, row.path);
          const restRel = row.path.slice(pathPrefix.length);
          const toRel = `${preservedRel}/${restRel}`;
          const toAbs = join(baseHarnessDir, toRel);
          try {
            if (!existsSync(fromAbs)) {
              // File registered but already missing on disk — record as
              // preserve_failed so the user knows the artifact is unrecoverable.
              log.warn({ artifact_id: row.id, fromAbs }, "teardown: artifact path missing on disk before preservation");
              preserveFailed = true;
              continue;
            }
            mkdirSync(dirname(toAbs), { recursive: true });
            // Point-of-action guard: skip preserve copy if shutdown began mid-loop.
            if (isShuttingDown()) throw new SpawnRefusedError("shutdown in progress — aborting preserve copyFileSync");
            copyFileSync(fromAbs, toAbs);
            db().prepare(`UPDATE artifacts SET path = ? WHERE id = ?`).run(toRel, row.id);
            preserved.push({ candidate_index: idx, from: row.path, to: toRel, artifact_id: row.id });
          } catch (err) {
            if (err instanceof SpawnRefusedError) throw err;
            log.warn(
              { err, artifact_id: row.id, fromAbs, toAbs },
              "teardown: preserve copy failed",
            );
            preserveFailed = true;
          }
        }
        // Make sure the preserved directory exists even if it ends up empty
        // (so the run summary can list it without races).
        try { mkdirSync(preservedAbs, { recursive: true }); } catch { /* ignore */ }
      }
    }

    if (preserveFailed && !allowDataLoss) {
      // Leave the worktree in place. The caller must surface this and either
      // re-run after fixing the cause, or call again with allow_data_loss=true.
      notTornDown.push(idx);
      continue;
    }

    // Intentionally runs during shutdown via trackedExecaNoRefuse — removes only
    // the throwaway candidate worktree/branch (never the user's project); janitor
    // is the sync backstop.  Do NOT guard with isShuttingDown() here.
    //
    // trackedExecaNoRefuse skips the _spawnRefused gate so shutdown does NOT
    // orphan these directories; it still registers in ACTIVE_CHILDREN so
    // abortAllInFlightChildren can terminate the child if the overall cap fires.
    // The _sealTeardown() gate (set after drain completes) stops any new spawn
    // from either variant once the drain loop is finished.
    try {
      await trackedExecaNoRefuse("git", ["worktree", "remove", "--force", path], { cwd: opts.project_path, windowsHide: true });
    } catch (err) {
      // Rethrow if the daemon drained and sealed before this call landed
      // (SpawnRefusedError), or if the child was killed during drain (isShuttingDown).
      // In either case do NOT rmSync — the janitor is the last-resort cleaner for
      // worktree dirs that survive a hard shutdown.
      if (err instanceof SpawnRefusedError || isShuttingDown()) throw err;
      // Point-of-action guard: shutdown may have begun while awaiting git.
      if (isShuttingDown()) throw new SpawnRefusedError("shutdown in progress — aborting worktree rmSync");
      try { if (existsSync(path)) rmSync(path, { recursive: true, force: true }); } catch { /* ignore */ }
    }
    try {
      await trackedExecaNoRefuse("git", ["branch", "-D", branch], { cwd: opts.project_path, windowsHide: true });
    } catch (err) {
      // Rethrow on refused/killed; swallow genuine git errors (branch already gone).
      if (err instanceof SpawnRefusedError || isShuttingDown()) throw err;
      /* branch may already be gone */
    }
  }

  let teardown_status: "ok" | "preserve_failed" | "partial" = "ok";
  if (notTornDown.length === opts.candidate_paths.length) teardown_status = "preserve_failed";
  else if (notTornDown.length > 0) teardown_status = "partial";

  return { teardown_status, preserved, not_torn_down: notTornDown };
}

void statSync; void readFileSync; void isAbsolute; void resolvePath; void sep; void dirname;
