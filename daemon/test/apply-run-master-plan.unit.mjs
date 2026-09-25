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
 *     the merged root does not duplicate the run's block.
 *
 * Anti-stall contract:
 *   - Uses a temp sqlite DB (PP_HOME override), direct dist function calls.
 *   - No MCP server, no daemon socket, no *.smoke.mjs files touched.
 *   - Uses real `git` via execFileSync against temp repos/worktrees only.
 *   - Run: timeout 90 node --test --test-timeout=60000 test/apply-run-master-plan.unit.mjs
 */

import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import assert from "node:assert/strict";
import { describe, it } from "node:test";

// Set PP_HOME BEFORE any dist import so the DB is isolated.
const SUITE_DIR = mkdtempSync(join(tmpdir(), "pp-apply-run-master-plan-"));
mkdirSync(join(SUITE_DIR, ".pair-programmer"), { recursive: true });
process.env.PP_HOME = SUITE_DIR;
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

    const result = runs.applyRunMasterPlan(run_id, wt);
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
    runs.applyRunMasterPlan(run_id, wt);

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

    assert.throws(
      () => runs.applyRunMasterPlan(run_id, unrelated),
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

    assert.throws(
      () => runs.applyRunMasterPlan(run_id, plainDir),
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

    const result = runs.applyRunMasterPlan(run_id, proj);
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
    runs.applyRunMasterPlan(run_id, wt);
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
    runs.applyRunMasterPlan(run_id, wt);
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

    runs.applyRunMasterPlan(run_id, wt);
    commitAll(wt, "apply master plan block");
    mergeBranch(repo, "arm-idem-feature");

    // Default-path finalize (NO master_plan_applied) on the merged root.
    const result = runs.finalizeRun({ run_id, status: "complete" });
    assert.equal(result.effective_status, "complete");

    const content = readMasterPlan(repo);
    assert.equal(countRunBlocks(content, run_id), 1,
      "default-path finalize after a worktree apply must not duplicate the run's block");
  });
});
