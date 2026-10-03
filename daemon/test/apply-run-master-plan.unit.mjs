/**
 * apply-run-master-plan.unit.mjs
 *
 * Self-contained unit tests for the `apply_run_master_plan` MCP tool's
 * underlying implementation (`applyRunMasterPlan` in orchestrator/runs.ts)
 * and finalize_run's new `master_plan_applied` skip-guard.
 *
 * Covers:
 *   - Default-path regression: finalize_run(complete) without the flag still
 *     writes the run's block into <project>/PROJECT_MASTER.md (unchanged
 *     autoPatchMasterPlan behaviour).
 *   - Worktree-apply: applyRunMasterPlan against a linked git worktree writes
 *     PROJECT_MASTER.md there and leaves project_path's copy untouched.
 *   - Validation: an unrelated git repo and a plain non-git directory are
 *     both rejected with nothing written.
 *   - Skip-guard: finalize_run(complete, master_plan_applied=true) after a
 *     worktree-apply + merge leaves project_path/PROJECT_MASTER.md
 *     byte-identical to just before the call.
 *   - PP-VG-1: a run whose taxonomy mapping requires a master-plan section
 *     is blocked until the worktree-applied block is merged in, then passes
 *     once master_plan_applied=true is set.
 *   - Idempotency: a worktree apply followed by a default-path finalize on
 *     the merged root does not duplicate the run's block; and a direct
 *     repeated applyRunMasterPlan(run_id, target_dir) against the same
 *     worktree leaves PROJECT_MASTER.md byte-identical, with the run's block
 *     present exactly once in every section it maps to.
 *   - Symlink/junction target_dir: a junction resolving OUTSIDE the project's
 *     repository is rejected (nothing written at either the link path or its
 *     real target); a junction resolving AT a real linked worktree of the
 *     SAME repository is accepted (realpath makes the link transparent).
 *   - Nonexistent target_dir: rejected with a clear error, nothing created.
 *   - git unavailable for the common-dir check: fails closed (rejected),
 *     even for a target_dir that would otherwise validate as a real worktree
 *     of the project.
 *   - git spawnable but `rev-parse --git-common-dir` erroring: also fails
 *     closed for an otherwise-valid worktree.
 *   - Shutdown: the git probe runs through trackedExeca, so once spawns are
 *     refused the SpawnRefusedError propagates and nothing is written.
 *
 * Anti-stall contract:
 *   - Uses a temp sqlite DB (setIsolatedProcessEnv), direct dist function calls.
 *   - No MCP server, no daemon socket, no *.smoke.mjs files touched.
 *   - Uses real `git` via execFileSync against temp repos/worktrees only.
 *   - The git-unavailable test scrubs process.env.PATH for the duration of
 *     one `applyRunMasterPlan` call (inside a try/finally) rather than
 *     adding a git-runner DI seam to production code — this is the actual
 *     failure mode (git missing/broken on the host) the gate needs to
 *     survive, and tests in this file run sequentially so no other test
 *     observes the scrubbed PATH.
 *   - Run: timeout 90 node --test --test-timeout=60000 test/apply-run-master-plan.unit.mjs
 */

import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, symlinkSync } from "node:fs";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { setIsolatedProcessEnv } from "./fixtures/isolated-env.mjs";

// Isolate the ledger BEFORE any dist import: scrubs an ambient PP_DB_PATH
// (which would otherwise win over PP_HOME and point at the live state.db)
// and pins an explicit temp PP_HOME + PP_DB_PATH.
const { ppHome: SUITE_DIR } = setIsolatedProcessEnv({ prefix: "pp-apply-run-master-plan-" });
mkdirSync(join(SUITE_DIR, ".pair-programmer"), { recursive: true });
process.env.EIGHTS_SKIP_AUDIT_CHECK = "1";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DIST = join(__dirname, "..", "dist");
const importDist = (relPath) => import(pathToFileURL(join(DIST, relPath)).href);

let _runs = null;
let _db = null;

async function getRuns() {
  if (!_runs) _runs = await importDist("orchestrator/runs.js");
  return _runs;
}
async function getDb() {
  if (!_db) {
    const m = await importDist("db/database.js");
    _db = m.db;
  }
  return _db;
}

// ── git helpers ──────────────────────────────────────────────────────────

function git(args, cwd) {
  return execFileSync("git", args, { cwd, encoding: "utf8", windowsHide: true });
}

function initRepo(dir) {
  mkdirSync(dir, { recursive: true });
  git(["init", "-q", "-b", "main"], dir);
  git(["-c", "user.name=t", "-c", "user.email=t@t", "commit", "--allow-empty", "-q", "-m", "init"], dir);
  return dir;
}

function addWorktree(repoDir, wtDir, branch) {
  git(["worktree", "add", "-q", "-b", branch, wtDir], repoDir);
  return wtDir;
}

function commitAll(dir, msg) {
  git(["add", "-A"], dir);
  git(["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", msg], dir);
}

function mergeBranch(repoDir, branch) {
  git(["merge", "--no-edit", "-q", branch], repoDir);
}

/**
 * Create a directory reparse point (Windows junction) / symlink at `linkPath`
 * pointing at `target`. Junctions don't require elevation on Windows, unlike
 * symlinks, which is why 'junction' is used there; POSIX uses a plain
 * directory symlink. `linkPath`'s parent must already exist; `linkPath`
 * itself must not.
 */
function makeDirLink(target, linkPath) {
  symlinkSync(target, linkPath, process.platform === "win32" ? "junction" : "dir");
  return linkPath;
}

// ── SQL helpers (mirrors finalize-gates-c.unit.mjs) ────────────────────────

async function insertRun(overrides = {}) {
  const db = await getDb();
  const id = `run_arm_${Math.random().toString(36).slice(2, 12)}`;
  const now = new Date().toISOString();
  db().prepare(
    `INSERT INTO runs(id, project_path, request_text, mode, team, forum, status,
        profile_snapshot_json, taxonomy_mapping_json, started_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    overrides.project_path,
    "apply-run-master-plan test",
    "single",
    overrides.team ?? null,
    overrides.forum ?? null,
    "running",
    overrides.profile_snapshot_json ?? null,
    overrides.taxonomy_mapping_json ?? null,
    now,
  );
  return id;
}

async function insertArtifact(run_id, taxonomy_section, kind = "code", path = "src/foo.ts") {
  const db = await getDb();
  const id = `art_arm_${Math.random().toString(36).slice(2, 12)}`;
  db().prepare(
    `INSERT INTO artifacts(id, run_id, taxonomy_section, kind, path, sha256, bytes, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(id, run_id, taxonomy_section, kind, path, "abc123", 10, new Date().toISOString());
  return id;
}

function masterPlanFile(dir) {
  return join(dir, "PROJECT_MASTER.md");
}

function readMasterPlan(dir) {
  return readFileSync(masterPlanFile(dir), "utf8");
}

/**
 * Body of the `## <section>` heading up to the next `## ` heading, or null
 * when the heading is absent. CRLF-normalized at the read.
 */
function sectionBody(content, section) {
  const lines = content.replace(/\r\n/g, "\n").split("\n");
  const start = lines.indexOf(`## ${section}`);
  if (start === -1) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (lines[i].startsWith("## ")) { end = i; break; }
  }
  return lines.slice(start + 1, end).join("\n");
}

function countRunBlocks(content, runId) {
  const re = new RegExp("Run `" + runId + "`", "g");
  return (content.match(re) ?? []).length;
}

// ─── Default-path regression ───────────────────────────────────────────────

describe("apply_run_master_plan: default-path regression (unchanged behaviour)", () => {
  it("finalize_run(complete) without master_plan_applied still auto-patches project_path", async () => {
    const runs = await getRuns();
    const proj = mkdtempSync(join(tmpdir(), "pp-arm-default-"));

    const run_id = await insertRun({ project_path: proj });
    await insertArtifact(run_id, "4.6"); // -> "11. Architecture and technical strategy"

    const result = runs.finalizeRun({ run_id, status: "complete" });
    assert.equal(result.effective_status, "complete");

    const content = readMasterPlan(proj);
    assert.match(content, /## 11\. Architecture and technical strategy/);
    assert.equal(countRunBlocks(content, run_id), 1,
      "default-path finalize must write exactly one run block");
  });
});

// ─── Worktree-apply ─────────────────────────────────────────────────────────

describe("apply_run_master_plan: writes into a linked git worktree", () => {
  it("writes the block into the worktree's PROJECT_MASTER.md, leaves project_path untouched", async () => {
    const runs = await getRuns();
    const repo = initRepo(mkdtempSync(join(tmpdir(), "pp-arm-repo-")));
    const wtBase = mkdtempSync(join(tmpdir(), "pp-arm-wt-"));
    const wt = join(wtBase, "wt");
    addWorktree(repo, wt, "arm-feature");

    const run_id = await insertRun({ project_path: repo });
    await insertArtifact(run_id, "4.6");

    // project_path has no PROJECT_MASTER.md yet.
    assert.equal(existsSync(masterPlanFile(repo)), false);

    const result = await runs.applyRunMasterPlan(run_id, wt);
    assert.equal(result.run_id, run_id);
    assert.ok(result.sections.some(s => s.status === "applied"));

    const wtContent = readMasterPlan(wt);
    assert.match(wtContent, /## 11\. Architecture and technical strategy/);
    assert.equal(countRunBlocks(wtContent, run_id), 1);

    // project_path's copy is unaffected (still absent).
    assert.equal(existsSync(masterPlanFile(repo)), false,
      "applying to the worktree must not touch project_path's PROJECT_MASTER.md");
  });

  it("when project_path already has PROJECT_MASTER.md, applying to the worktree leaves it byte-identical", async () => {
    const runs = await getRuns();
    const repo = initRepo(mkdtempSync(join(tmpdir(), "pp-arm-repo2-")));
    writeFileSync(masterPlanFile(repo), "# Project Master Plan\n\n## 11. Architecture and technical strategy\n\n_To be populated by harness runs._\n", "utf8");
    git(["add", "-A"], repo);
    git(["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "seed master plan"], repo);

    const wtBase = mkdtempSync(join(tmpdir(), "pp-arm-wt2-"));
    const wt = join(wtBase, "wt");
    addWorktree(repo, wt, "arm-feature2");

    const before = readFileSync(masterPlanFile(repo), "utf8");

    const run_id = await insertRun({ project_path: repo });
    await insertArtifact(run_id, "4.6");
    await runs.applyRunMasterPlan(run_id, wt);

    const after = readFileSync(masterPlanFile(repo), "utf8");
    assert.equal(after, before, "project_path's PROJECT_MASTER.md must be byte-identical after a worktree apply");
  });
});

// ─── Validation ─────────────────────────────────────────────────────────────

describe("apply_run_master_plan: target_dir validation", () => {
  it("rejects an unrelated git repo, writing nothing there", async () => {
    const runs = await getRuns();
    const proj = initRepo(mkdtempSync(join(tmpdir(), "pp-arm-proj-")));
    const unrelated = initRepo(mkdtempSync(join(tmpdir(), "pp-arm-unrelated-")));

    const run_id = await insertRun({ project_path: proj });
    await insertArtifact(run_id, "4.6");

    await assert.rejects(
      runs.applyRunMasterPlan(run_id, unrelated),
      (err) => {
        assert.equal(err.name, "MasterPlanTargetDirError");
        assert.equal(err.run_id, run_id);
        assert.equal(err.target_dir, unrelated);
        return true;
      },
    );
    assert.equal(existsSync(masterPlanFile(unrelated)), false,
      "rejected unrelated git repo must have nothing written");
  });

  it("rejects a plain non-git directory, writing nothing there", async () => {
    const runs = await getRuns();
    const proj = initRepo(mkdtempSync(join(tmpdir(), "pp-arm-proj2-")));
    const plainDir = mkdtempSync(join(tmpdir(), "pp-arm-plain-"));

    const run_id = await insertRun({ project_path: proj });
    await insertArtifact(run_id, "4.6");

    await assert.rejects(
      runs.applyRunMasterPlan(run_id, plainDir),
      (err) => {
        assert.equal(err.name, "MasterPlanTargetDirError");
        return true;
      },
    );
    assert.equal(existsSync(masterPlanFile(plainDir)), false,
      "rejected plain directory must have nothing written");
  });

  it("accepts target_dir === realpath(project_path) itself", async () => {
    const runs = await getRuns();
    const proj = mkdtempSync(join(tmpdir(), "pp-arm-self-"));
    const run_id = await insertRun({ project_path: proj });
    await insertArtifact(run_id, "4.6");

    const result = await runs.applyRunMasterPlan(run_id, proj);
    assert.ok(result.sections.some(s => s.status === "applied"));
  });
});

// ─── Skip-guard ─────────────────────────────────────────────────────────────

describe("finalize_run: master_plan_applied skip-guard", () => {
  it("leaves project_path/PROJECT_MASTER.md byte-identical after apply-in-worktree + merge + finalize(master_plan_applied=true)", async () => {
    const runs = await getRuns();
    const repo = initRepo(mkdtempSync(join(tmpdir(), "pp-arm-skip-repo-")));
    const wtBase = mkdtempSync(join(tmpdir(), "pp-arm-skip-wt-"));
    const wt = join(wtBase, "wt");
    addWorktree(repo, wt, "arm-skip-feature");

    const run_id = await insertRun({ project_path: repo });
    await insertArtifact(run_id, "4.6");

    // Apply in the worktree, commit, merge into project_path.
    await runs.applyRunMasterPlan(run_id, wt);
    commitAll(wt, "apply master plan block");
    mergeBranch(repo, "arm-skip-feature");

    // A SECOND artifact, mapped to a DIFFERENT master-plan section, is
    // archived AFTER the merge (a realistic late-archival ordering) and was
    // never applied to the worktree. Without the skip guard, the default
    // autoPatchMasterPlan would append this section's block against
    // project_path on this very finalize call — a genuine, non-idempotent
    // write (as opposed to the first section, whose run-id-header block is
    // already present and would no-op regardless of the guard). This is
    // what makes the byte-identical assertion below load-bearing rather
    // than vacuously true.
    await insertArtifact(run_id, "4.9", "code", "src/late.ts"); // -> "14. Security, privacy, and compliance"

    const beforeCall = readFileSync(masterPlanFile(repo), "utf8");

    const result = runs.finalizeRun({ run_id, status: "complete", master_plan_applied: true });
    assert.equal(result.effective_status, "complete");

    const afterCall = readFileSync(masterPlanFile(repo), "utf8");
    assert.equal(afterCall, beforeCall,
      "master_plan_applied=true must leave project_path/PROJECT_MASTER.md untouched by finalize_run, " +
      "even when a section never applied to the worktree (the late 4.9 artifact) would otherwise be " +
      "written fresh by the default autoPatchMasterPlan path");

    // The skip must be recorded in the audit ledger.
    const db = await getDb();
    const skipRow = db()
      .prepare(`SELECT * FROM master_plan_patches WHERE run_id = ? AND kind = 'master_plan_applied_skip'`)
      .get(run_id);
    assert.ok(skipRow, "finalize_run must record a master_plan_applied_skip audit row");
  });
});

// ─── PP-VG-1 interaction ────────────────────────────────────────────────────

describe("apply_run_master_plan + finalize_run: PP-VG-1 interaction", () => {
  it("blocked before merge, complete after worktree-apply + merge + master_plan_applied=true", async () => {
    const runs = await getRuns();
    const repo = initRepo(mkdtempSync(join(tmpdir(), "pp-arm-vg1-repo-")));

    const run_id = await insertRun({
      project_path: repo,
      taxonomy_mapping_json: JSON.stringify({
        scope: "standard", signals: [],
        sections: [{ id: "4.6", title: "Architecture", rationale: "r", required_artifacts: [] }],
        missability_required: [],
      }),
    });
    await insertArtifact(run_id, "4.6");

    // Before any apply: blocked by PP-VG-1 (section unpopulated / file absent).
    let threw = false;
    try {
      runs.finalizeRun({ run_id, status: "complete" });
    } catch (err) {
      threw = true;
      assert.equal(err.name, "CompletionChecklistGateViolation");
      assert.match(err.message, /PP-VG-1/);
    }
    assert.ok(threw, "must be blocked by PP-VG-1 before the master plan is applied anywhere");

    // Apply in a worktree, commit, merge into project_path.
    const wtBase = mkdtempSync(join(tmpdir(), "pp-arm-vg1-wt-"));
    const wt = join(wtBase, "wt");
    addWorktree(repo, wt, "arm-vg1-feature");
    await runs.applyRunMasterPlan(run_id, wt);
    commitAll(wt, "apply master plan block");
    mergeBranch(repo, "arm-vg1-feature");

    // Now the section is populated in project_path -> PP-VG-1 clears.
    const result = runs.finalizeRun({ run_id, status: "complete", master_plan_applied: true });
    assert.equal(result.effective_status, "complete",
      "PP-VG-1 must clear once the worktree-applied block has been merged into project_path");
  });
});

// ─── Idempotency ────────────────────────────────────────────────────────────

describe("apply_run_master_plan + finalize_run: idempotency", () => {
  it("worktree apply followed by a default-path finalize on the merged root does not duplicate the run's block", async () => {
    const runs = await getRuns();
    const repo = initRepo(mkdtempSync(join(tmpdir(), "pp-arm-idem-repo-")));
    const wtBase = mkdtempSync(join(tmpdir(), "pp-arm-idem-wt-"));
    const wt = join(wtBase, "wt");
    addWorktree(repo, wt, "arm-idem-feature");

    const run_id = await insertRun({ project_path: repo });
    await insertArtifact(run_id, "4.6");

    await runs.applyRunMasterPlan(run_id, wt);
    commitAll(wt, "apply master plan block");
    mergeBranch(repo, "arm-idem-feature");

    // Default-path finalize (NO master_plan_applied) on the merged root.
    const result = runs.finalizeRun({ run_id, status: "complete" });
    assert.equal(result.effective_status, "complete");

    const content = readMasterPlan(repo);
    assert.equal(countRunBlocks(content, run_id), 1,
      "default-path finalize after a worktree apply must not duplicate the run's block");
  });

  it("a direct repeated applyRunMasterPlan on the same worktree target is byte-identical and never duplicates a block", async () => {
    const runs = await getRuns();
    const repo = initRepo(mkdtempSync(join(tmpdir(), "pp-arm-rep-repo-")));
    const wtBase = mkdtempSync(join(tmpdir(), "pp-arm-rep-wt-"));
    const wt = join(wtBase, "wt");
    addWorktree(repo, wt, "arm-rep-feature");

    const run_id = await insertRun({ project_path: repo });
    // Two artifacts mapping to two DIFFERENT master-plan sections, so the
    // per-section idempotency is exercised more than once per call.
    await insertArtifact(run_id, "4.6");                            // -> 11. Architecture
    await insertArtifact(run_id, "4.9", "code", "src/security.ts"); // -> 14. Security

    const first = await runs.applyRunMasterPlan(run_id, wt);
    const appliedSections = first.sections.map(s => s.section);
    assert.equal(appliedSections.length, 2, "first apply must touch both mapped sections");
    assert.deepEqual(first.sections.map(s => s.status), ["applied", "applied"]);
    const afterFirst = readFileSync(masterPlanFile(wt), "utf8");

    const second = await runs.applyRunMasterPlan(run_id, wt);
    const afterSecond = readFileSync(masterPlanFile(wt), "utf8");

    assert.equal(afterSecond, afterFirst,
      "a second applyRunMasterPlan to the same target must leave PROJECT_MASTER.md byte-identical");
    assert.equal(second.created, false, "the second apply must not re-scaffold PROJECT_MASTER.md");
    assert.deepEqual(second.sections.map(s => s.section), appliedSections,
      "the second apply must visit the same sections as the first");
    assert.deepEqual(second.sections.map(s => s.status), ["noop_already_applied", "noop_already_applied"],
      "every section must report noop_already_applied on the second apply");

    // Exactly one block per mapped section, checked section by section over
    // the sections actually written (derived from the result, not
    // hardcoded), so a duplicate in one section cannot hide behind a
    // missing block in another.
    for (const section of appliedSections) {
      const body = sectionBody(afterSecond, section);
      assert.ok(body !== null, `section '${section}' must exist in PROJECT_MASTER.md`);
      assert.equal(countRunBlocks(body, run_id), 1,
        `run block must appear exactly once in section '${section}' after two applies`);
    }
    assert.equal(countRunBlocks(afterSecond, run_id), appliedSections.length,
      "total run blocks must equal the number of mapped sections");
  });
});

// ─── target_dir validation: symlinks / junctions ───────────────────────────

describe("apply_run_master_plan: target_dir validation — symlinks/junctions", () => {
  it("rejects a junction whose target resolves OUTSIDE the project's repository, writing nothing at either path", async () => {
    const runs = await getRuns();
    const proj = initRepo(mkdtempSync(join(tmpdir(), "pp-arm-junc-proj-")));

    // The junction's real (physical) target — a directory with no relation
    // to `proj` at all, not even a git repo.
    const outsideReal = mkdtempSync(join(tmpdir(), "pp-arm-junc-outside-"));

    const linkBase = mkdtempSync(join(tmpdir(), "pp-arm-junc-link-"));
    const link = makeDirLink(outsideReal, join(linkBase, "link-to-outside"));

    const run_id = await insertRun({ project_path: proj });
    await insertArtifact(run_id, "4.6");

    await assert.rejects(
      runs.applyRunMasterPlan(run_id, link),
      (err) => {
        assert.equal(err.name, "MasterPlanTargetDirError");
        return true;
      },
    );
    assert.equal(existsSync(masterPlanFile(outsideReal)), false,
      "nothing must be written at the junction's real (outside) target");
    assert.equal(existsSync(masterPlanFile(link)), false,
      "nothing must be written when read through the junction path either");
  });

  it("accepts a junction pointing AT a real linked worktree of the project (transparent via realpath)", async () => {
    const runs = await getRuns();
    const repo = initRepo(mkdtempSync(join(tmpdir(), "pp-arm-junc-wt-repo-")));
    const wtBase = mkdtempSync(join(tmpdir(), "pp-arm-junc-wt-"));
    const wt = join(wtBase, "wt");
    addWorktree(repo, wt, "arm-junc-feature");

    const linkBase = mkdtempSync(join(tmpdir(), "pp-arm-junc-wt-link-"));
    const link = makeDirLink(wt, join(linkBase, "link-to-worktree"));

    const run_id = await insertRun({ project_path: repo });
    await insertArtifact(run_id, "4.6");

    // Documented behaviour: a junction resolving (via realpath) to a real
    // linked worktree of project_path's own repository is ACCEPTED — the
    // link is transparent and only the resolved destination is validated.
    const result = await runs.applyRunMasterPlan(run_id, link);
    assert.ok(result.sections.some(s => s.status === "applied"));

    const wtContent = readMasterPlan(wt);
    assert.match(wtContent, /## 11\. Architecture and technical strategy/);
    const linkContent = readMasterPlan(link);
    assert.equal(linkContent, wtContent,
      "reading through the junction must see the exact same physical file the write landed in");
  });
});

// ─── target_dir validation: nonexistent path ───────────────────────────────

describe("apply_run_master_plan: target_dir validation — nonexistent path", () => {
  it("rejects a nonexistent target_dir with a clear error, creating nothing there", async () => {
    const runs = await getRuns();
    const proj = mkdtempSync(join(tmpdir(), "pp-arm-nonexist-proj-"));
    const base = mkdtempSync(join(tmpdir(), "pp-arm-nonexist-base-"));
    const missing = join(base, "does-not-exist", "nested");

    const run_id = await insertRun({ project_path: proj });
    await insertArtifact(run_id, "4.6");

    assert.equal(existsSync(missing), false, "sanity: target must not pre-exist");

    await assert.rejects(
      runs.applyRunMasterPlan(run_id, missing),
      (err) => {
        assert.equal(err.name, "MasterPlanTargetDirError");
        assert.match(err.message, /does not resolve on disk/);
        return true;
      },
    );
    assert.equal(existsSync(missing), false,
      "a rejected apply against a nonexistent target_dir must not create it");
  });
});

// ─── target_dir validation: git unavailable ────────────────────────────────

describe("apply_run_master_plan: target_dir validation — git unavailable fails closed", () => {
  it("rejects (fails closed) when git cannot be spawned, even for a target_dir that is otherwise a real worktree of the project", async () => {
    const runs = await getRuns();
    const repo = initRepo(mkdtempSync(join(tmpdir(), "pp-arm-nogit-repo-")));
    const wtBase = mkdtempSync(join(tmpdir(), "pp-arm-nogit-wt-"));
    const wt = join(wtBase, "wt");
    addWorktree(repo, wt, "arm-nogit-feature");

    const run_id = await insertRun({ project_path: repo });
    await insertArtifact(run_id, "4.6");

    const savedPath = process.env.PATH;
    // Scrub PATH so `git` cannot be spawned for the git-common-dir check.
    // This is the actual failure mode being guarded against (git missing or
    // broken on the host) — not a mocked seam. Tests in this file run
    // sequentially, so no other test observes the scrubbed PATH.
    process.env.PATH = "";
    try {
      await assert.rejects(
        runs.applyRunMasterPlan(run_id, wt),
        (err) => {
          assert.equal(err.name, "MasterPlanTargetDirError");
          return true;
        },
      );
    } finally {
      process.env.PATH = savedPath;
    }

    assert.equal(existsSync(masterPlanFile(wt)), false,
      "nothing must be written to the worktree when git is unavailable for the common-dir check");
  });

  it("rejects (fails closed) when git spawns but rev-parse --git-common-dir errors, even for a real worktree of the project", async () => {
    const runs = await getRuns();
    const repo = initRepo(mkdtempSync(join(tmpdir(), "pp-arm-revfail-repo-")));
    const wtBase = mkdtempSync(join(tmpdir(), "pp-arm-revfail-wt-"));
    const wt = join(wtBase, "wt");
    addWorktree(repo, wt, "arm-revfail-feature");

    const run_id = await insertRun({ project_path: repo });
    await insertArtifact(run_id, "4.6");

    // Point GIT_DIR at a path that is not a repository: git still spawns,
    // but `rev-parse --git-common-dir` exits non-zero on BOTH sides. Two
    // failures must never be treated as "the same repository".
    const bogusGitDir = join(mkdtempSync(join(tmpdir(), "pp-arm-revfail-bogus-")), "not-a-repo");
    assert.throws(
      () => execFileSync("git", ["-C", wt, "rev-parse", "--git-common-dir"], {
        env: { ...process.env, GIT_DIR: bogusGitDir }, stdio: "pipe", windowsHide: true,
      }),
      "sanity: rev-parse must actually fail under the bogus GIT_DIR",
    );

    const savedGitDir = process.env.GIT_DIR;
    process.env.GIT_DIR = bogusGitDir;
    try {
      await assert.rejects(
        runs.applyRunMasterPlan(run_id, wt),
        (err) => {
          assert.equal(err.name, "MasterPlanTargetDirError");
          return true;
        },
      );
    } finally {
      if (savedGitDir === undefined) delete process.env.GIT_DIR;
      else process.env.GIT_DIR = savedGitDir;
    }

    assert.equal(existsSync(masterPlanFile(wt)), false,
      "nothing must be written to the worktree when rev-parse fails for the common-dir check");
  });
});

// ─── git-plumbing: shutdown refusal ────────────────────────────────────────

describe("apply_run_master_plan: git probe honours shutdown spawn refusal", () => {
  it("propagates SpawnRefusedError once spawns are refused, writing nothing, for an otherwise-valid worktree", async () => {
    const runs = await getRuns();
    const cliRunner = await importDist("mcp/cli-runner.js");
    const repo = initRepo(mkdtempSync(join(tmpdir(), "pp-arm-refuse-repo-")));
    const wtBase = mkdtempSync(join(tmpdir(), "pp-arm-refuse-wt-"));
    const wt = join(wtBase, "wt");
    addWorktree(repo, wt, "arm-refuse-feature");

    const run_id = await insertRun({ project_path: repo });
    await insertArtifact(run_id, "4.6");

    // The probe must go through trackedExeca: once shutdown refuses new
    // spawns, the refusal is a shutdown signal and must surface as such —
    // not be swallowed into an ordinary "not the same repository" rejection.
    cliRunner._refuseNewSpawns();
    try {
      await assert.rejects(
        runs.applyRunMasterPlan(run_id, wt),
        (err) => {
          assert.ok(err instanceof cliRunner.SpawnRefusedError,
            `expected SpawnRefusedError from the tracked git probe, got ${err?.name}: ${err?.message}`);
          return true;
        },
      );
    } finally {
      cliRunner._resetSpawnRefusedForTest();
    }
    assert.equal(cliRunner._isSpawnRefused(), false, "refusal flag must be reset for later tests");

    assert.equal(existsSync(masterPlanFile(wt)), false,
      "nothing must be written to the worktree when the git probe is refused at shutdown");
  });
});
