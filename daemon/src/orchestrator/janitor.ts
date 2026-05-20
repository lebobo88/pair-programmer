/**
 * Startup janitor: marks orphaned `running` runs as `crashed`, sweeps
 * stale candidate worktrees, removes orphan project locks, and surfaces
 * them on the next /pp:status. Idempotent — safe to call on every daemon
 * start and via /pp:doctor.
 */

import { execFileSync } from "node:child_process";
import { rmSync, existsSync, statSync } from "node:fs";
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
          execFileGit(["worktree", "prune"], project_path);
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

/** Synchronous git helper. Returns stdout (empty string on non-zero exit). */
function execFileGit(args: string[], cwd: string): string {
  try {
    const out = execFileSync("git", args, { cwd, encoding: "utf8", windowsHide: true });
    return out.toString();
  } catch {
    return "";
  }
}
