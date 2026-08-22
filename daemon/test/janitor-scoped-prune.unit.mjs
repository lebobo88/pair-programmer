/**
 * janitor-scoped-prune.unit.mjs
 *
 * The startup janitor's stale-`pp/*`-candidate sweep used to fall back to a
 * repo-wide `git worktree prune` whenever a candidate's directory was
 * already gone (e.g. `existsSync(wtPath)` false). `git worktree prune` is
 * repo-wide and immediate with no grace period (verified empirically on
 * Git 2.55.0.windows.3) -- it deregisters EVERY missing worktree
 * registration in the repo, not just the one candidate this sweep
 * iteration found. A sibling worktree living in the same repo (e.g. a
 * Hydra `attended/*` worktree paused on HITL) whose directory reads as
 * transiently absent at that exact moment -- slow filesystem, network
 * mount, mid-write -- would get its `git worktree list` registration
 * collaterally deregistered by that repo-wide call, even though this
 * per-entry `pp/*` cleanup has no business touching it.
 *
 * Fixed: `pruneSingleWorktreeAdminDir` walks `<git-common-dir>/worktrees/*`
 * directly and removes ONLY the admin directory whose `gitdir` file points
 * back at the specific candidate's path -- never a repo-wide prune.
 *
 * Falsification discipline: a sibling whose directory still EXISTS is the
 * one state where the old repo-wide-prune code does no damage either (git
 * only prunes registrations whose working tree is actually missing), so a
 * test built on an existing sibling directory would pass identically
 * against the broken implementation and prove nothing. To genuinely
 * exercise the hazard, this test makes BOTH the target candidate's
 * directory AND the sibling's directory absent -- indistinguishable to git
 * from a transient absence -- so a repo-wide prune WOULD collaterally
 * deregister the sibling, and the scoped fix must not.
 *
 * Real git repo, real worktrees, real sqlite rows -- no mocks for the git
 * plumbing.
 *
 * Run: node --test test/janitor-scoped-prune.unit.mjs
 */

import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync, mkdirSync, rmSync, existsSync } from "node:fs";
import assert from "node:assert/strict";
import { describe, it, before } from "node:test";

// Set PP_HOME BEFORE any dist import so the DB is isolated.
const SUITE_DIR = mkdtempSync(join(tmpdir(), "pp-janitor-scoped-"));
mkdirSync(join(SUITE_DIR, ".pair-programmer"), { recursive: true });
process.env.PP_HOME = SUITE_DIR;
process.env.EIGHTS_SKIP_AUDIT_CHECK = "1";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DIST = join(__dirname, "..", "dist");
const importDist = (relPath) => import(pathToFileURL(join(DIST, relPath)).href);

let _janitor = null;
let _db = null;

async function getJanitor() {
  if (!_janitor) _janitor = await importDist("orchestrator/janitor.js");
  return _janitor;
}
async function getDb() {
  if (!_db) {
    const m = await importDist("db/database.js");
    _db = m.db;
  }
  return _db;
}

function git(args, cwd) {
  return execFileSync("git", args, { cwd, encoding: "utf8", windowsHide: true });
}

function initRepo(dir) {
  mkdirSync(dir, { recursive: true });
  git(["init", "-q"], dir);
  git(["-c", "user.name=t", "-c", "user.email=t@t", "commit", "--allow-empty", "-q", "-m", "init"], dir);
  return dir;
}

async function insertRunRow(projectPath) {
  const db = await getDb();
  const id = `run_jscoped_${Math.random().toString(36).slice(2, 12)}`;
  const now = new Date().toISOString();
  db().prepare(
    `INSERT INTO runs(id, project_path, request_text, mode, status, started_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(id, projectPath, "janitor scoped-prune test", "single", "crashed", now);
  return id;
}

function isRegistered(projectDir, wtPath) {
  const listing = git(["worktree", "list", "--porcelain"], projectDir);
  const norm = (p) => p.replace(/\\/g, "/");
  return listing
    .split("\n")
    .some((line) => line.startsWith("worktree ") && norm(line.slice("worktree ".length).trim()) === norm(wtPath));
}

describe("janitor: pp/* candidate cleanup never repo-wide prunes a sibling worktree", () => {
  let projectDir;
  let candidateWtPath;
  let siblingWtPath;
  const candidateBranch = "pp/janitor-scoped-candidate";
  const siblingBranch = "attended/run_janitorScopedSibling";

  before(async () => {
    projectDir = initRepo(mkdtempSync(join(tmpdir(), "pp-janitor-scoped-project-")));
    const wtRoot = mkdtempSync(join(tmpdir(), "pp-janitor-scoped-wt-"));

    candidateWtPath = join(wtRoot, "pp-candidate");
    siblingWtPath = join(wtRoot, "attended-sibling");

    git(["worktree", "add", "-b", candidateBranch, candidateWtPath], projectDir);
    git(["worktree", "add", "-b", siblingBranch, siblingWtPath], projectDir);

    // Both directories genuinely absent -- indistinguishable to git from a
    // transient absence, which is exactly the state under which the OLD
    // repo-wide `git worktree prune` fallback would collaterally deregister
    // the sibling too. If the sibling's directory were left in place
    // instead, this test would pass against the broken implementation as
    // well (git only prunes registrations with a missing working tree) and
    // would prove nothing about the scoping fix.
    rmSync(candidateWtPath, { recursive: true, force: true });
    rmSync(siblingWtPath, { recursive: true, force: true });

    assert.ok(!existsSync(candidateWtPath), "test setup: candidate directory must be gone");
    assert.ok(!existsSync(siblingWtPath), "test setup: sibling directory must be gone");
    assert.ok(isRegistered(projectDir, candidateWtPath), "test setup: candidate must still be git-registered");
    assert.ok(isRegistered(projectDir, siblingWtPath), "test setup: sibling must still be git-registered");

    await insertRunRow(projectDir);
  });

  it("deregisters only the pp/* candidate's own admin dir, leaving the sibling's registration intact", async () => {
    const { runJanitor } = await getJanitor();
    runJanitor();

    assert.ok(
      !isRegistered(projectDir, candidateWtPath),
      "the pp/* candidate whose directory is gone should be deregistered"
    );
    assert.ok(
      isRegistered(projectDir, siblingWtPath),
      "a sibling worktree whose directory happened to also be absent must NOT be " +
        "collaterally deregistered by a scoped, per-entry cleanup -- only a repo-wide " +
        "`git worktree prune` would do that"
    );
  });
});
