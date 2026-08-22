/**
 * Startup janitor: marks orphaned `running` runs as `crashed`, sweeps
 * stale candidate worktrees, removes orphan project locks, and surfaces
 * them on the next /pp:status. Idempotent — safe to call on every daemon
 * start and via /pp:doctor.
 */

import { execFileSync } from "node:child_process";
import { rmSync, existsSync, statSync, readdirSync, readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { db, txImmediate } from "../db/database.js";
import { projectLockPath } from "../util/paths.js";
import { readLockMetadata, isPidAlive } from "../util/lock.js";
import { log } from "../util/logger.js";

const STALE_RUN_HOURS = 6;
const STALE_LOCK_HOURS = 6;

export function runJanitor(): {
  crashed_runs: string[];
  swept_worktrees: string[];
  swept_branches: string[];
  swept_locks: string[];
} {
  const cutoff = new Date(Date.now() - STALE_RUN_HOURS * 60 * 60 * 1000).toISOString();

  // 1. Mark stale `running` rows as `crashed`.
  const stale = db()
    .prepare(`SELECT id FROM runs WHERE status IN ('running', 'pending') AND started_at < ?`)
    .all(cutoff) as Array<{ id: string }>;

  const crashed: string[] = [];
  if (stale.length) {
    txImmediate(() => {
      const stmt = db().prepare(`UPDATE runs SET status = 'crashed', finished_at = ? WHERE id = ?`);
      const now = new Date().toISOString();
      for (const r of stale) {
        stmt.run(now, r.id);
        crashed.push(r.id);
      }
    });
    log.info({ count: crashed.length }, "janitor marked stale runs as crashed");
  }

  // 2. Sweep stale candidate worktrees and 3. orphan project locks across every known project.
  //
  // DELIBERATE SCOPE, DO NOT WIDEN: the branch-name filter below
  // (`refs/heads/pp/...`) means this sweep only ever considers pp's own
  // best-of-N / team candidate worktrees. It never matches Hydra's
  // `attended/*` worktrees, and that's intentional, not an oversight —
  // an attended run legitimately sits idle for days while paused on a
  // HITL gate upstream in Hydra, with a cursor that is non-terminal the
  // entire time. Sweeping it here on mtime staleness would destroy live,
  // in-progress work that this daemon has no way to know is still active.
  // If a future change needs to reap abandoned attended worktrees, that
  // policy belongs in Hydra (which owns the cursor's lifecycle and can
  // tell "paused" apart from "abandoned"), not in this daemon-local sweep.
  const swept_worktrees: string[] = [];
  const swept_branches: string[] = [];
  const swept_locks: string[] = [];

  const projects = db()
    .prepare(
      // Include every project that has *any* row, not just finished runs —
      // a project whose only run is currently `crashed` should still get
      // its stale lock cleaned up.
      `SELECT DISTINCT project_path FROM runs`,
    )
    .all() as Array<{ project_path: string }>;

  for (const { project_path } of projects) {
    // Worktree sweep
    try {
      const stdout = execFileGit(["worktree", "list", "--porcelain"], project_path);
      const wtBlocks = stdout.split(/\n\n/);
      for (const block of wtBlocks) {
        const wtMatch = /^worktree\s+(\S.+)/m.exec(block);
        const branchMatch = /^branch\s+refs\/heads\/(pp\/[\w./-]+)/m.exec(block);
        if (!wtMatch || !branchMatch) continue;
        const wtPath = wtMatch[1]!;
        const branch = branchMatch[1]!;
        if (!existsSync(wtPath)) {
          pruneSingleWorktreeAdminDir(project_path, wtPath);
          continue;
        }
        const stat = statSync(wtPath);
        const ageMs = Date.now() - stat.mtime.getTime();
        if (ageMs > STALE_RUN_HOURS * 60 * 60 * 1000) {
          try {
            execFileGit(["worktree", "remove", "--force", wtPath], project_path);
            swept_worktrees.push(wtPath);
            try {
              execFileGit(["branch", "-D", branch], project_path);
              swept_branches.push(branch);
            } catch { /* branch may already be gone */ }
          } catch (err) {
            log.warn({ err, wtPath }, "worktree remove failed during sweep");
            try { rmSync(wtPath, { recursive: true, force: true }); } catch { /* ignore */ }
          }
        }
      }
    } catch { /* not a git project or other error */ }

    // Project-lock sweep — remove `<project>/.harness/.lock` if older than
    // STALE_LOCK_HOURS. The lock file is created at start_run via
    // ProjectLock.acquire() and deleted at finalize_run via release().
    // A leftover lock means the daemon crashed mid-run.
    try {
      const lockPath = projectLockPath(project_path);
      if (existsSync(lockPath)) {
        const stat = statSync(lockPath);
        const ageMs = Date.now() - stat.mtime.getTime();
        const meta = readLockMetadata(lockPath);
        const deadPid = meta && !isPidAlive(meta.pid);
        const ageExceeded = ageMs > STALE_LOCK_HOURS * 60 * 60 * 1000;
        if (deadPid || ageExceeded) {
          try {
            rmSync(lockPath, { force: true });
            swept_locks.push(lockPath);
            log.info(
              { lockPath, reason: deadPid ? `dead_pid=${meta!.pid}` : `age=${Math.round(ageMs / 1000)}s` },
              "janitor removed stale project lock",
            );
          } catch (err) {
            log.warn({ err, lockPath }, "stale lock removal failed");
          }
        }
      }
    } catch { /* ignore */ }
  }

  return { crashed_runs: crashed, swept_worktrees, swept_branches, swept_locks };
}

/**
 * Deregister ONLY the single worktree admin directory for `wtPath`,
 * WITHOUT a repo-wide `git worktree prune`.
 *
 * `git worktree prune` is repo-wide and takes effect immediately with no
 * grace period (verified empirically on Git 2.55.0.windows.3 in a scratch
 * repo) -- it deregisters EVERY missing worktree registration in the repo,
 * not just the `pp/*` candidate this sweep iteration is looking at. This
 * sweep runs per-project across every project the daemon knows about, and a
 * Hydra `attended/*` worktree can legitimately live in the same repo,
 * paused on a HITL gate for days. If that attended worktree's directory
 * happens to read as transiently absent at the exact moment this sweep
 * calls a repo-wide prune (slow filesystem, network mount, mid-write), the
 * prune would collaterally deregister its `git worktree list` entry -- it
 * can never delete the attended worktree's checkout content or its branch,
 * but losing the registration is still real, unintended damage a per-entry
 * `pp/*` cleanup has no business causing to an unrelated worktree.
 *
 * This is the identical hazard class removed from Hydra's own worktree
 * janitor one stage ago (see hydra_core/host_bridge.py's
 * `_prune_single_worktree_admin_dir`); this mirrors that fix so pp's `pp/*`
 * cleanup carries the same per-entry scoping discipline instead of reaching
 * for the repo-wide tool.
 *
 * Walks `<git-common-dir>/worktrees/*` directly -- each admin directory
 * contains a `gitdir` file pointing back at `<wtPath>/.git` -- and removes
 * only the single admin directory whose `gitdir` matches `wtPath`. Every
 * other worktree's registration, live or stale, is left completely
 * untouched: there is no repo-wide operation for a race to reach.
 *
 * Best-effort and silent on failure, exactly like the repo-wide
 * `worktree prune` call this replaces already was -- the caller never
 * checked that call's result either, so preserving "swallow and move on"
 * here changes nothing about the surrounding sweep's error-handling
 * contract, only how narrowly the deregistration is scoped.
 */
export function pruneSingleWorktreeAdminDir(projectPath: string, wtPath: string): void {
  try {
    const commonDirRaw = execFileGit(["rev-parse", "--git-common-dir"], projectPath).trim();
    if (!commonDirRaw) return;
    const commonDir = isAbsolute(commonDirRaw) ? commonDirRaw : resolve(projectPath, commonDirRaw);
    const worktreesDir = join(commonDir, "worktrees");
    if (!existsSync(worktreesDir)) return;
    const target = wtPath.replace(/\\/g, "/").replace(/\/+$/, "");
    for (const name of readdirSync(worktreesDir)) {
      const adminDir = join(worktreesDir, name);
      let isDir = false;
      try {
        isDir = statSync(adminDir).isDirectory();
      } catch {
        continue;
      }
      if (!isDir) continue;
      const gitdirFile = join(adminDir, "gitdir");
      if (!existsSync(gitdirFile)) continue;
      let pointed: string;
      try {
        pointed = readFileSync(gitdirFile, "utf8").trim();
      } catch {
        continue;
      }
      // `gitdir` is normally an absolute path, but nothing guarantees that --
      // resolve a relative entry against the admin directory it lives in
      // (matching how git itself resolves it) before comparing, or a
      // relative-`gitdir` admin dir silently never matches and is skipped
      // forever.
      const pointedAbs = isAbsolute(pointed) ? pointed : resolve(adminDir, pointed);
      let pointedNorm = pointedAbs.replace(/\\/g, "/").replace(/\/+$/, "");
      if (pointedNorm.endsWith("/.git")) {
        pointedNorm = pointedNorm.slice(0, -"/.git".length);
      }
      // Do NOT return on the first match: if more than one admin dir points
      // at the same wtPath (a stale duplicate registration left behind by
      // an earlier crash), every one of them must be removed, not just the
      // first encountered -- otherwise "the single admin directory" is
      // false and a duplicate registration survives the sweep.
      if (pointedNorm === target) {
        rmSync(adminDir, { recursive: true, force: true });
      }
    }
  } catch {
    /* advisory only -- never propagate into the caller's sweep loop */
  }
}

/** Synchronous git helper. Returns stdout (empty string on non-zero exit). */
function execFileGit(args: string[], cwd: string): string {
  try {
    const out = execFileSync("git", args, { cwd, encoding: "utf8", windowsHide: true });
    return out.toString();
  } catch {
    return "";
  }
}
