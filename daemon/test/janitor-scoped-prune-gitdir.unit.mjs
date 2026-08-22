/**
 * janitor-scoped-prune-gitdir.unit.mjs
 *
 * Two real gaps in `pruneSingleWorktreeAdminDir` (janitor.ts):
 *
 * 1. A `gitdir` file that is relative (rather than the absolute path git
 *    normally writes) is trimmed and slash-normalized but never resolved
 *    against the admin directory it lives in before being compared to the
 *    target `wtPath`. A relative entry therefore never matches and the
 *    admin dir is silently skipped forever -- the exact "quietly never
 *    cleaned" failure mode this test pins.
 *
 * 2. The scan `return`s on the first matching admin dir. If two admin
 *    directories' `gitdir` files both point at the same `wtPath` (a stale
 *    duplicate registration left behind by an earlier crash), only the
 *    first is removed and the second survives the sweep untouched --
 *    contradicting the "the single admin directory" framing.
 *
 * `pruneSingleWorktreeAdminDir` only ever walks the filesystem under
 * `<git-common-dir>/worktrees/*` and compares `gitdir` file contents -- it
 * never consults `git worktree list` -- so these tests fabricate admin
 * directories directly rather than going through `git worktree add`. This
 * keeps the test independent of whatever git itself would or wouldn't ever
 * literally write to a `gitdir` file, and isolates the function under test
 * from the caller's `git worktree list` parsing tested elsewhere in
 * janitor-scoped-prune.unit.mjs.
 *
 * Run: node --test test/janitor-scoped-prune-gitdir.unit.mjs
 */

import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join, relative, isAbsolute, resolve } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import assert from "node:assert/strict";
import { describe, it } from "node:test";

const SUITE_DIR = mkdtempSync(join(tmpdir(), "pp-janitor-gitdir-"));
mkdirSync(join(SUITE_DIR, ".pair-programmer"), { recursive: true });
process.env.PP_HOME = SUITE_DIR;
process.env.EIGHTS_SKIP_AUDIT_CHECK = "1";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DIST = join(__dirname, "..", "dist");
const importDist = (relPath) => import(pathToFileURL(join(DIST, relPath)).href);

let _janitor = null;
async function getJanitor() {
  if (!_janitor) _janitor = await importDist("orchestrator/janitor.js");
  return _janitor;
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

/** Create a fake `<worktreesDir>/<name>/gitdir` admin dir with the given content. */
function makeFakeAdminDir(worktreesDir, name, gitdirContent) {
  const adminDir = join(worktreesDir, name);
  mkdirSync(adminDir, { recursive: true });
  writeFileSync(join(adminDir, "gitdir"), gitdirContent, "utf8");
  return adminDir;
}

describe("pruneSingleWorktreeAdminDir: relative gitdir resolution", () => {
  it("resolves a relative gitdir against its admin dir and removes the match", async () => {
    const { pruneSingleWorktreeAdminDir } = await getJanitor();

    const projectDir = initRepo(mkdtempSync(join(tmpdir(), "pp-janitor-gitdir-project-")));
    const commonDirRaw = git(["rev-parse", "--git-common-dir"], projectDir).trim();
    const commonDir = isAbsolute(commonDirRaw) ? commonDirRaw : resolve(projectDir, commonDirRaw);
    const worktreesDir = join(commonDir, "worktrees");
    mkdirSync(worktreesDir, { recursive: true });

    const wtRoot = mkdtempSync(join(tmpdir(), "pp-janitor-gitdir-wt-"));
    const wtPath = join(wtRoot, "relative-target");
    mkdirSync(wtPath, { recursive: true });

    const adminDir = makeFakeAdminDir(worktreesDir, "relative-entry", "placeholder");
    // Write the gitdir content AS RELATIVE TO THE ADMIN DIR -- this is the
    // malformed/unusual case the fix must resolve before comparing.
    const relativeGitdir = relative(adminDir, join(wtPath, ".git")).replace(/\\/g, "/");
    writeFileSync(join(adminDir, "gitdir"), relativeGitdir, "utf8");

    assert.ok(existsSync(adminDir), "test setup: admin dir must exist before pruning");

    pruneSingleWorktreeAdminDir(projectDir, wtPath);

    assert.ok(
      !existsSync(adminDir),
      "an admin dir whose gitdir is relative-to-itself must still be matched and removed " +
        "once resolved against the admin dir -- without the fix it is silently skipped forever"
    );
  });
});

describe("pruneSingleWorktreeAdminDir: duplicate admin dirs for the same wtPath", () => {
  it("removes every admin dir that points at the same wtPath, not just the first", async () => {
    const { pruneSingleWorktreeAdminDir } = await getJanitor();

    const projectDir = initRepo(mkdtempSync(join(tmpdir(), "pp-janitor-gitdir-project2-")));
    const commonDirRaw = git(["rev-parse", "--git-common-dir"], projectDir).trim();
    const commonDir = isAbsolute(commonDirRaw) ? commonDirRaw : resolve(projectDir, commonDirRaw);
    const worktreesDir = join(commonDir, "worktrees");
    mkdirSync(worktreesDir, { recursive: true });

    const wtRoot = mkdtempSync(join(tmpdir(), "pp-janitor-gitdir-wt2-"));
    const wtPath = join(wtRoot, "duplicated-target");
    mkdirSync(wtPath, { recursive: true });

    const gitdirAbs = join(wtPath, ".git").replace(/\\/g, "/");
    const adminDirA = makeFakeAdminDir(worktreesDir, "dup-a", gitdirAbs);
    const adminDirB = makeFakeAdminDir(worktreesDir, "dup-b", gitdirAbs);

    assert.ok(existsSync(adminDirA) && existsSync(adminDirB), "test setup: both duplicates must exist");

    pruneSingleWorktreeAdminDir(projectDir, wtPath);

    assert.ok(
      !existsSync(adminDirA),
      "the first duplicate admin dir pointing at wtPath must be removed"
    );
    assert.ok(
      !existsSync(adminDirB),
      "the SECOND duplicate admin dir pointing at the same wtPath must also be removed -- " +
        "returning after the first match leaves a stale duplicate registration behind"
    );
  });
});
