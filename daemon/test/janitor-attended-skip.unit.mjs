/**
 * janitor-attended-skip.unit.mjs
 *
 * The startup janitor (orchestrator/janitor.ts) sweeps stale candidate
 * worktrees on mtime staleness alone. An attended Hydra run can legitimately
 * sit paused on a HITL gate for days with a non-terminal cursor — this
 * daemon has no access to that cursor and cannot tell "paused" apart from
 * "abandoned" by mtime, so it must never act on Hydra's `attended/*`
 * worktrees/branches at all, rather than try to acquire cursor awareness it
 * has no business owning (that policy belongs in Hydra's own
 * `sweep_stale_worktrees`).
 *
 * Real git repos, real worktrees, real (backdated) mtimes, real sqlite rows
 * — no mocks for the git plumbing.
 *
 * Tests:
 *   1. A stale `attended/*` worktree survives the janitor untouched: not in
 *      swept_worktrees/swept_branches, directory and branch both still on
 *      disk after the run.
 *   2. Positive control on the SAME sweep: a stale `pp/*` candidate
 *      worktree in the same project IS removed (proves the attended
 *      survival above is a real skip, not e.g. an exception aborting the
 *      whole sweep silently).
 *
 * Anti-stall contract:
 *   - Direct dist function call, no MCP server, no daemon socket.
 *   - Isolated PP_HOME (temp sqlite DB) and a scratch git project dir.
 *   - Run: node --test test/janitor-attended-skip.unit.mjs
 */

import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, utimesSync } from "node:fs";
import assert from "node:assert/strict";
import { describe, it, before } from "node:test";

// Set PP_HOME BEFORE any dist import so the DB is isolated.
const SUITE_DIR = mkdtempSync(join(tmpdir(), "pp-janitor-attended-"));
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

/** Create a worktree on a new branch, then backdate its directory mtime far
 * past the janitor's staleness threshold so mtime-based sweeping considers
 * it a candidate regardless of branch prefix. */
function addStaleWorktree(repoDir, wtPath, branch) {
  git(["worktree", "add", "-b", branch, wtPath], repoDir);
  const old = new Date(Date.now() - 48 * 60 * 60 * 1000); // 48h old, well past STALE_RUN_HOURS=6
  utimesSync(wtPath, old, old);
  return wtPath;
}

async function insertRunRow(projectPath) {
  const db = await getDb();
  const id = `run_jattn_${Math.random().toString(36).slice(2, 12)}`;
  const now = new Date().toISOString();
  db().prepare(
    `INSERT INTO runs(id, project_path, request_text, mode, status, started_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(id, projectPath, "janitor attended-skip test", "single", "crashed", now);
  return id;
}

describe("janitor: never acts on Hydra attended/* worktrees or branches", () => {
  let projectDir;
  let attendedWtPath;
  let ppWtPath;
  const attendedBranch = "attended/run_janitorAttnTest";
  const ppBranch = "pp/janitor-attn-test-candidate";

  before(async () => {
    projectDir = initRepo(mkdtempSync(join(tmpdir(), "pp-janitor-attn-project-")));
    const wtRoot = mkdtempSync(join(tmpdir(), "pp-janitor-attn-wt-"));

    attendedWtPath = addStaleWorktree(projectDir, join(wtRoot, "attended-run_janitorAttnTest"), attendedBranch);
    ppWtPath = addStaleWorktree(projectDir, join(wtRoot, "pp-candidate"), ppBranch);

    await insertRunRow(projectDir);
  });

  it("leaves the attended/* worktree and branch untouched, but sweeps a stale pp/* sibling in the same run", async () => {
    const { runJanitor } = await getJanitor();
    const result = runJanitor();

    // git's own `worktree list --porcelain` output (and therefore
    // swept_worktrees, which is built straight from it) always uses
    // forward slashes regardless of platform; normalize both sides before
    // comparing so this isn't a false pass/fail on Windows path spelling.
    const norm = (p) => p.replace(/\\/g, "/");
    const sweptWtNorm = result.swept_worktrees.map(norm);

    // -- attended/* survives completely --
    assert.ok(
      !sweptWtNorm.includes(norm(attendedWtPath)),
      "janitor must not report the attended worktree as swept"
    );
    assert.ok(
      !result.swept_branches.includes(attendedBranch),
      "janitor must not report the attended branch as swept"
    );
    assert.ok(existsSync(attendedWtPath), "attended worktree directory must still exist on disk");
    const attendedShowRef = execFileSync(
      "git", ["show-ref", "--verify", `refs/heads/${attendedBranch}`],
      { cwd: projectDir, encoding: "utf8" },
    );
    assert.match(attendedShowRef, new RegExp(attendedBranch.replace(/\//g, "\\/")));

    // -- positive control: the pp/* sibling in the SAME sweep IS removed --
    // proves the attended survival above is a real branch-prefix skip, not
    // e.g. a silently-swallowed exception that aborted the whole sweep.
    assert.ok(
      sweptWtNorm.includes(norm(ppWtPath)),
      "a stale pp/* candidate worktree must still be swept in the same run"
    );
    assert.ok(
      result.swept_branches.includes(ppBranch),
      "the stale pp/* candidate's branch must still be swept"
    );
    assert.ok(!existsSync(ppWtPath), "pp/* candidate worktree directory must be gone");
  });
});
