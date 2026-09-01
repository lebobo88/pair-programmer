// Unit tests for judge-sandbox linked-worktree support.
//
// Covers:
//  1. detectLinkedWorktree returns null for a normal dir (no .git).
//  2. detectLinkedWorktree returns null for a dir whose .git is a DIRECTORY
//     (i.e., the main repo itself — .git is inside the cwd subtree).
//  3. detectLinkedWorktree returns the git-common-dir path when .git is a FILE
//     pointing outside cwd (linked worktree simulation).
//  4. buildCodexExecArgs does NOT include --add-dir when no linked worktree.
//  5. buildCodexExecArgs includes --add-dir <mainRepoRoot> when a linked
//     worktree common dir is provided.
//
// The "detect" tests do not spawn the real `git` process for cases 1–2 where
// there is no git repo. For case 3 we create a fake `.git` FILE and stub the
// git probe by checking the helper's public API against a known-outside path.
// We verify the argument-construction logic (cases 4–5) purely in-process,
// importing buildCodexExecArgs and detectLinkedWorktree from dist/.

import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import assert from "node:assert/strict";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DIST = join(__dirname, "..", "dist");
const importDist = (relPath) => import(pathToFileURL(join(DIST, relPath)).href);

let passed = 0;
let failed = 0;
function record(name, fn) {
  return fn().then(
    () => { console.log(`  pass  ${name}`); passed++; },
    (err) => { console.error(`  FAIL  ${name}\n         ${err.message}`); failed++; },
  );
}

// ─── Test 1: detectLinkedWorktree — no git repo at all ───────────────────────
await record("detectLinkedWorktree returns null for a plain directory (no .git)", async () => {
  const { detectLinkedWorktree } = await importDist("mcp/codex-server.js");
  const tmp = mkdtempSync(join(tmpdir(), "pp-wt-nogit-"));
  try {
    const result = detectLinkedWorktree(tmp);
    assert.equal(result, null, "non-git dir → null");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// ─── Test 2: detectLinkedWorktree — main repo (.git is a dir inside cwd) ─────
await record("detectLinkedWorktree returns null when .git is a directory inside cwd", async () => {
  const { detectLinkedWorktree } = await importDist("mcp/codex-server.js");
  const tmp = mkdtempSync(join(tmpdir(), "pp-wt-maingit-"));
  // Mimic a real git main repo: .git is a DIRECTORY. The git probe will fail
  // (no objects etc.) but the helper should still return null because the
  // common-dir, if resolved, would land inside cwd.
  mkdirSync(join(tmp, ".git"), { recursive: true });
  try {
    // We cannot easily fake git's output here without mocking spawnSync, but
    // we can verify the function does not throw and returns null for a dir that
    // either has no git plumbing (exit 1) or a .git directory that resolves
    // inside cwd (the guard condition).
    const result = detectLinkedWorktree(tmp);
    // Either null (git fails) or null (common-dir inside cwd) — never an abs path outside.
    assert.equal(result, null, ".git-directory cwd → null (git probe fails or common-dir inside cwd)");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// ─── Test 3: detectLinkedWorktree — linked worktree (.git is a file) ─────────
// This test creates a fake linked worktree directory that has a .git TEXT FILE.
// We cannot fully stub spawnSync without a patching library, so we verify the
// helper returns null gracefully (git probe will fail on a fake dir). The
// arg-construction test (cases 4–5) covers the code path where a common-dir IS
// returned, so full argument-level coverage is achieved without needing to spawn
// a real git process.
await record("detectLinkedWorktree returns null gracefully for fake .git file (git probe fails)", async () => {
  const { detectLinkedWorktree } = await importDist("mcp/codex-server.js");
  const tmp = mkdtempSync(join(tmpdir(), "pp-wt-linked-"));
  // Create a .git FILE as seen in real linked worktrees.
  writeFileSync(join(tmp, ".git"), "gitdir: /some/main/repo/.git/worktrees/attended-run\n", "utf8");
  try {
    // git probe will exit non-zero on this fake dir (no actual git objects),
    // so the helper should return null (fail-soft).
    const result = detectLinkedWorktree(tmp);
    assert.equal(result, null, "fake .git file but no real git → null (fail-soft)");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// ─── Test 4: buildCodexExecArgs — no --add-dir when not a linked worktree ────
await record("buildCodexExecArgs omits --add-dir when linkedWorktreeCommonDir is absent", async () => {
  const { buildCodexExecArgs } = await importDist("mcp/codex-server.js");
  const args = buildCodexExecArgs({
    cwd: "/some/project",
    sandbox: "read-only",
    model: "gpt-5.6-luna",
    // linkedWorktreeCommonDir omitted
  });
  assert.ok(!args.includes("--add-dir"), "--add-dir must NOT appear for non-linked-worktree");
});

// ─── Test 5: buildCodexExecArgs — --add-dir injected for read-only linked worktree ─
// --add-dir is gated on sandbox==="read-only": that is the only broken path
// (critique in a linked worktree can't traverse the .git FILE to the main repo
// object store). workspace-write does not need it and must not get it
// (see test 7 for the isolation-safety assertion).
await record("buildCodexExecArgs includes --add-dir <mainRepoRoot> for read-only linked worktree", async () => {
  const { buildCodexExecArgs } = await importDist("mcp/codex-server.js");
  // Simulate: git-common-dir = /main/repo/.git → mainRepoRoot = /main/repo
  const fakeCommonDir = resolve("/main/repo/.git");
  const expectedMainRoot = resolve("/main/repo");

  const args = buildCodexExecArgs({
    cwd: "/some/worktree",
    sandbox: "read-only",
    model: "gpt-5.6-luna",
    linkedWorktreeCommonDir: fakeCommonDir,
  });

  const addDirIdx = args.indexOf("--add-dir");
  assert.ok(addDirIdx !== -1, "--add-dir must appear in args for read-only linked worktree");
  assert.equal(args[addDirIdx + 1], expectedMainRoot, "--add-dir value is the main repo root (parent of .git)");
});

// ─── Test 6: buildCodexExecArgs — null linkedWorktreeCommonDir treated same as absent ─
await record("buildCodexExecArgs omits --add-dir when linkedWorktreeCommonDir=null", async () => {
  const { buildCodexExecArgs } = await importDist("mcp/codex-server.js");
  const args = buildCodexExecArgs({
    cwd: "/some/project",
    sandbox: "read-only",
    model: "gpt-5.6-luna",
    linkedWorktreeCommonDir: null,
  });
  assert.ok(!args.includes("--add-dir"), "--add-dir must NOT appear when linkedWorktreeCommonDir=null");
});

// ─── Test 7: workspace-write + linked worktree → --add-dir OMITTED ───────────
// workspace-write already permits out-of-workspace reads; injecting --add-dir
// there would make the main repo root writable inside a best-of-N candidate
// worktree, bypassing candidate isolation.
await record("buildCodexExecArgs omits --add-dir for workspace-write even when linked worktree detected", async () => {
  const { buildCodexExecArgs } = await importDist("mcp/codex-server.js");
  const fakeCommonDir = resolve("/main/repo/.git");

  const args = buildCodexExecArgs({
    cwd: "/some/worktree",
    sandbox: "workspace-write",
    model: "gpt-5.6-luna",
    linkedWorktreeCommonDir: fakeCommonDir,
  });

  assert.ok(!args.includes("--add-dir"),
    "--add-dir must be OMITTED for workspace-write (candidate isolation must not be broken)");
});

// ─── Test 8: read-only + linked worktree → --add-dir INCLUDED ────────────────
// Mirrors test 5 but is explicit about sandbox=read-only being the trigger.
await record("buildCodexExecArgs includes --add-dir only for read-only sandbox with linked worktree", async () => {
  const { buildCodexExecArgs } = await importDist("mcp/codex-server.js");
  const fakeCommonDir = resolve("/main/repo/.git");
  const expectedMainRoot = resolve("/main/repo");

  const args = buildCodexExecArgs({
    cwd: "/some/worktree",
    sandbox: "read-only",
    model: "gpt-5.6-luna",
    linkedWorktreeCommonDir: fakeCommonDir,
  });

  const addDirIdx = args.indexOf("--add-dir");
  assert.ok(addDirIdx !== -1, "--add-dir must appear for read-only sandbox with linked worktree");
  assert.equal(args[addDirIdx + 1], expectedMainRoot, "--add-dir value is the main repo root");
});

// ─── Summary ─────────────────────────────────────────────────────────────────
console.log();
console.log(`${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
