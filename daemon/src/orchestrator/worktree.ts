import { trackedExeca, trackedExecaNoRefuse, SpawnRefusedError, isShuttingDown } from "../mcp/cli-runner.js";
import { mkdirSync, cpSync, rmSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { log } from "../util/logger.js";

/**
 * Per-attempt isolated working tree. Tries `git worktree add` first; falls
 * back to a plain copy of the project for non-git directories or when
 * worktree creation fails (Windows + some shallow setups).
 */

export type Worktree = {
  path: string;
  mode: "git-worktree" | "copy" | "in-place";
  release: () => Promise<void>;
};

export async function createWorktree(opts: {
  projectPath: string;
  workdirPath: string;          // where the worktree lives, e.g. <run_id>/<stage>/<candidate>/
  branch?: string;              // ephemeral branch name
}): Promise<Worktree> {
  mkdirSync(dirname(opts.workdirPath), { recursive: true });

  const isGit = await isGitRepo(opts.projectPath);
  if (isGit) {
    const branch = opts.branch ?? `pp/${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    try {
      await trackedExeca("git", ["worktree", "add", "-b", branch, opts.workdirPath], {
        cwd: opts.projectPath,
        windowsHide: true,
      });
      return {
        path: opts.workdirPath,
        mode: "git-worktree",
        release: async () => {
          // Intentionally runs during shutdown via trackedExecaNoRefuse — removes
          // only the throwaway candidate worktree/branch (never the user's project);
          // janitor is the sync backstop.  Do NOT guard with isShuttingDown() here.
          //
          // trackedExecaNoRefuse skips the _spawnRefused gate so shutdown does NOT
          // orphan these directories; it still registers in ACTIVE_CHILDREN so
          // abortAllInFlightChildren can terminate the child if the cap fires.
          try {
            await trackedExecaNoRefuse("git", ["worktree", "remove", "--force", opts.workdirPath], {
              cwd: opts.projectPath,
              windowsHide: true,
            });
          } catch (err) {
            // Abort if refused-before-spawn OR killed-mid-flight during shutdown.
            // Do NOT rmSync during shutdown — janitor is the last-resort cleaner.
            if (err instanceof SpawnRefusedError || isShuttingDown()) throw err;
            log.warn({ err, path: opts.workdirPath }, "git worktree remove failed; falling back to rmSync");
            // Point-of-action guard: shutdown may have started while we awaited git.
            if (isShuttingDown()) throw new SpawnRefusedError("shutdown in progress — aborting release rmSync");
            try { rmSync(opts.workdirPath, { recursive: true, force: true }); } catch { /* ignore */ }
          }
          try {
            await trackedExecaNoRefuse("git", ["branch", "-D", branch], { cwd: opts.projectPath, windowsHide: true });
          } catch (err) {
            // Rethrow on shutdown (refused or killed); swallow genuine git errors (branch gone).
            if (err instanceof SpawnRefusedError || isShuttingDown()) throw err;
            /* branch may already be gone */
          }
        },
      };
    } catch (err) {
      // Abort if refused-before-spawn OR killed-mid-flight during shutdown.
      // Falling back to copy-mode during shutdown could clobber the project root.
      if (err instanceof SpawnRefusedError || isShuttingDown()) throw err;
      log.warn({ err }, "git worktree add failed; falling back to copy");
    }
  }

  // Point-of-action guard: shutdown may have begun between the isGitRepo await
  // and here (e.g. git rev-parse killed and swallowed, then shutdown set).
  if (isShuttingDown()) throw new SpawnRefusedError("shutdown in progress — aborting copy-mode copyProject");
  copyProject(opts.projectPath, opts.workdirPath);
  return {
    path: opts.workdirPath,
    mode: "copy",
    release: async () => {
      if (existsSync(opts.workdirPath)) {
        // Point-of-action guard: copy-mode release rmSync must not run during
        // shutdown — janitor is the last-resort cleaner for orphaned dirs.
        if (isShuttingDown()) throw new SpawnRefusedError("shutdown in progress — aborting copy-mode release rmSync");
        try { rmSync(opts.workdirPath, { recursive: true, force: true }); } catch { /* ignore */ }
      }
    },
  };
}

async function isGitRepo(projectPath: string): Promise<boolean> {
  try {
    await trackedExeca("git", ["rev-parse", "--is-inside-work-tree"], { cwd: projectPath, windowsHide: true });
    return true;
  } catch (err) {
    // Propagate on shutdown (refused or killed) — returning false here would
    // trigger copy-mode in the caller, clobbering the project root on shutdown.
    if (err instanceof SpawnRefusedError || isShuttingDown()) throw err;
    return false;
  }
}

function copyProject(src: string, dest: string): void {
  mkdirSync(dest, { recursive: true });
  cpSync(src, dest, {
    recursive: true,
    force: false,
    errorOnExist: false,
    filter: (p) => {
      // Skip node_modules and .git to keep copies lean; the per-attempt
      // worktree only needs source tree.
      if (/\\node_modules(\\|$)/.test(p)) return false;
      if (/\\\.git(\\|$)/.test(p))         return false;
      if (/\\\.harness(\\|$)/.test(p))     return false;
      return true;
    },
  });
}
