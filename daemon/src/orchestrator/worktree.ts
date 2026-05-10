import { execa } from "execa";
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
      await execa("git", ["worktree", "add", "-b", branch, opts.workdirPath], {
        cwd: opts.projectPath,
      });
      return {
        path: opts.workdirPath,
        mode: "git-worktree",
        release: async () => {
          try {
            await execa("git", ["worktree", "remove", "--force", opts.workdirPath], {
              cwd: opts.projectPath,
            });
          } catch (err) {
            log.warn({ err, path: opts.workdirPath }, "git worktree remove failed; falling back to rmSync");
            try { rmSync(opts.workdirPath, { recursive: true, force: true }); } catch { /* ignore */ }
          }
          try {
            await execa("git", ["branch", "-D", branch], { cwd: opts.projectPath });
          } catch { /* branch may already be gone */ }
        },
      };
    } catch (err) {
      log.warn({ err }, "git worktree add failed; falling back to copy");
    }
  }

  // Copy fallback (or non-git project).
  copyProject(opts.projectPath, opts.workdirPath);
  return {
    path: opts.workdirPath,
    mode: "copy",
    release: async () => {
      if (existsSync(opts.workdirPath)) {
        try { rmSync(opts.workdirPath, { recursive: true, force: true }); } catch { /* ignore */ }
      }
    },
  };
}

async function isGitRepo(projectPath: string): Promise<boolean> {
  try {
    await execa("git", ["rev-parse", "--is-inside-work-tree"], { cwd: projectPath });
    return true;
  } catch {
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
