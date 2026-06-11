/**
 * finalize-gates-c.unit.mjs
 *
 * Self-contained unit tests for two finalize gates:
 *   VG-1: finalizeRun(complete) blocked when a REQUIRED master-plan section
 *         (derived from taxonomy mapping, NOT artifact.taxonomy_section) is
 *         unpopulated. Fail-closed on unknown/missing/bad id in mapping.
 *         Gate is READ-ONLY — a blocked finalize must NOT modify PROJECT_MASTER.md.
 *   VG-5: getStageFinalizeReadiness blocked for a stage that produced code/diff
 *         artifacts and has no TDD predecessor, unless the stage has an executed
 *         smoke pass tied to the WINNING attempt (via candidate_index in
 *         attempt.notes_json). No winner, no candidate_index, or a pass tied to
 *         a non-winner candidate all block. Non-code/diff-producing stages skip.
 *
 * Anti-stall contract:
 *   - Uses a temp sqlite DB (PP_HOME override), direct dist function calls.
 *   - No MCP server, no daemon socket, no *.smoke.mjs files touched.
 *   - Run: timeout 90 node --test test/finalize-gates-c.unit.mjs
 */

import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, statSync } from "node:fs";
import assert from "node:assert/strict";
import { describe, it } from "node:test";

// Set PP_HOME BEFORE any dist import so the DB is isolated.
const SUITE_DIR = mkdtempSync(join(tmpdir(), "pp-finalize-gates-c-"));
mkdirSync(join(SUITE_DIR, ".pair-programmer"), { recursive: true });
process.env.PP_HOME = SUITE_DIR;
process.env.EIGHTS_SKIP_AUDIT_CHECK = "1";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DIST = join(__dirname, "..", "dist");
const importDist = (relPath) => import(pathToFileURL(join(DIST, relPath)).href);

// ── Shared lazy-loaded dist modules ──────────────────────────────────────────

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

// ── Shared project directory ───────────────────────────────────────────────
const SHARED_PROJECT = mkdtempSync(join(tmpdir(), "pp-fgc-shared-"));
mkdirSync(join(SHARED_PROJECT, ".harness"), { recursive: true });
writeFileSync(join(SHARED_PROJECT, "AGENTS.md"), "# AGENTS\n", "utf8");

// ── SQL helpers ────────────────────────────────────────────────────────────

async function insertRun(overrides = {}) {
  const db = await getDb();
  const id = `run_fgc_${Math.random().toString(36).slice(2, 12)}`;
  const now = new Date().toISOString();
  db().prepare(
    `INSERT INTO runs(id, project_path, request_text, mode, team, forum, status,
        profile_snapshot_json, taxonomy_mapping_json, started_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    overrides.project_path ?? SHARED_PROJECT,
    "finalize-gates-c test",
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

async function insertStage(run_id, kind = "code", overrides = {}) {
  const db = await getDb();
  const id = `stage_fgc_${Math.random().toString(36).slice(2, 12)}`;
  const now = new Date().toISOString();
  db().prepare(
    `INSERT INTO stages(id, run_id, kind, gate_type, status, notes_json, winner_attempt_id, started_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id, run_id, kind, kind, "running",
    overrides.notes_json ?? null,
    overrides.winner_attempt_id ?? null,
    now,
  );
  return id;
}

async function insertAttempt(stage_id, overrides = {}) {
  const db = await getDb();
  const id = `attempt_fgc_${Math.random().toString(36).slice(2, 12)}`;
  const now = new Date().toISOString();
  db().prepare(
    `INSERT INTO attempts(id, stage_id, producer, model_id, status, notes_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id, stage_id,
    overrides.producer ?? "claude",
    overrides.model_id ?? "claude-sonnet-4-6",
    overrides.status ?? "ok",
    overrides.notes_json ?? null,
    now,
  );
  return id;
}

/** Insert an artifact of kind 'code' or 'diff' to make the stage smoke-required. */
async function insertCodeArtifact(run_id, stage_id, kind = "code") {
  const db = await getDb();
  const id = `art_fgc_${Math.random().toString(36).slice(2, 12)}`;
  db().prepare(
    `INSERT INTO artifacts(id, run_id, stage_id, kind, path, sha256, bytes, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(id, run_id, stage_id, kind, `${kind}.patch`, "abc123", 10, new Date().toISOString());
  return id;
}

/** Write a minimal PROJECT_MASTER.md; populatedSections = section headers to mark as populated. */
async function writePopulatedMasterPlan(projectPath, populatedSections = []) {
  const masterPlanSections = [
    "1. Executive summary",
    "2. Business and portfolio context",
    "3. Stakeholders and users",
    "4. Current-state workflow and pain",
    "5. Scope and roadmap",
    "6. Functional requirements",
    "7. Acceptance criteria",
    "8. Non-functional requirements",
    "9. UX/UI/content design",
    "10. Domain and data model",
    "11. Architecture and technical strategy",
    "12. Interfaces and contracts",
    "13. Engineering standards and delivery model",
    "14. Security, privacy, and compliance",
    "15. Test and verification strategy",
    "16. Operations and support model",
    "17. Team operating model and governance",
    "18. Risks, assumptions, and open questions",
    "19. Launch, migration, and rollback plan",
    "20. Deprecation and retirement plan",
    "Appendices",
  ];
  const populated = new Set(populatedSections);
  const body = masterPlanSections.map(s => {
    if (populated.has(s)) {
      return `## ${s}\n\nThis section has real content about the project.\n`;
    }
    return `## ${s}\n\n_To be populated by harness runs._\n`;
  }).join("\n");
  writeFileSync(join(projectPath, "PROJECT_MASTER.md"), `# Project Master Plan\n\n${body}`, "utf8");
}

// ─── VG-1: completion-checklist gate ──────────────────────────────────────
describe("VG-1: completion-checklist gate", () => {

  it("responsible section unpopulated -> blocked (CompletionChecklistGateViolation)", async () => {
    const runs = await getRuns();
    const proj = mkdtempSync(join(tmpdir(), "pp-vg1-a-"));
    mkdirSync(join(proj, ".harness"), { recursive: true });
    writeFileSync(join(proj, "AGENTS.md"), "# AGENTS\n", "utf8");
    await writePopulatedMasterPlan(proj, []); // nothing populated

    // 4.11 -> "19. Launch, migration, and rollback plan" (unpopulated)
    const run_id = await insertRun({
      project_path: proj,
      taxonomy_mapping_json: JSON.stringify({
        scope: "standard", signals: [],
        sections: [{ id: "4.11", title: "Delivery", rationale: "r", required_artifacts: [] }],
        missability_required: [],
      }),
    });

    let threw = false;
    try {
      runs.finalizeRun({ run_id, status: "complete" });
    } catch (err) {
      threw = true;
      assert.equal(err.name, "CompletionChecklistGateViolation",
        `expected CompletionChecklistGateViolation, got ${err.name}: ${err.message}`);
      assert.match(err.message, /PP-VG-1/);
      assert.ok(Array.isArray(err.unmet_sections) && err.unmet_sections.length > 0);
      assert.ok(err.unmet_sections.some(s => s.section.includes("19.")),
        `expected '19. Launch...' in unmet_sections: ${JSON.stringify(err.unmet_sections)}`);
      assert.ok(err.unmet_sections.every(s => s.reason === "unpopulated"),
        "all unmet reasons must be 'unpopulated'");
    }
    assert.ok(threw, "must have thrown CompletionChecklistGateViolation");
  });

  it("all responsible sections populated -> not blocked", async () => {
    const runs = await getRuns();
    const proj = mkdtempSync(join(tmpdir(), "pp-vg1-b-"));
    mkdirSync(join(proj, ".harness"), { recursive: true });
    writeFileSync(join(proj, "AGENTS.md"), "# AGENTS\n", "utf8");
    await writePopulatedMasterPlan(proj, ["19. Launch, migration, and rollback plan"]);

    const run_id = await insertRun({
      project_path: proj,
      taxonomy_mapping_json: JSON.stringify({
        scope: "standard", signals: [],
        sections: [{ id: "4.11", title: "Delivery", rationale: "r", required_artifacts: [] }],
        missability_required: [],
      }),
    });

    const result = runs.finalizeRun({ run_id, status: "complete" });
    assert.equal(result.effective_status, "complete",
      "all responsible sections populated must not block VG-1");
  });

  it("no-artifact run that mapped a section with unmet item -> blocked (not exempt)", async () => {
    const runs = await getRuns();
    const proj = mkdtempSync(join(tmpdir(), "pp-vg1-c-"));
    mkdirSync(join(proj, ".harness"), { recursive: true });
    writeFileSync(join(proj, "AGENTS.md"), "# AGENTS\n", "utf8");
    await writePopulatedMasterPlan(proj, []);

    // 4.6 -> "11. Architecture and technical strategy" (unpopulated)
    const run_id = await insertRun({
      project_path: proj,
      taxonomy_mapping_json: JSON.stringify({
        scope: "standard", signals: [],
        sections: [{ id: "4.6", title: "Architecture", rationale: "r", required_artifacts: [] }],
        missability_required: [],
      }),
    });

    let threw = false;
    try {
      runs.finalizeRun({ run_id, status: "complete" });
    } catch (err) {
      threw = true;
      assert.equal(err.name, "CompletionChecklistGateViolation");
      assert.ok(err.unmet_sections.some(s => s.section.includes("11.")),
        `expected '11. Architecture...' in unmet_sections: ${JSON.stringify(err.unmet_sections)}`);
    }
    assert.ok(threw, "no-artifact run must NOT be exempt from VG-1");
  });

  it("{'sections':[{}]} (missing id) -> fail closed", async () => {
    const runs = await getRuns();
    const proj = mkdtempSync(join(tmpdir(), "pp-vg1-d1-"));
    mkdirSync(join(proj, ".harness"), { recursive: true });
    writeFileSync(join(proj, "AGENTS.md"), "# AGENTS\n", "utf8");
    await writePopulatedMasterPlan(proj, []);

    const run_id = await insertRun({
      project_path: proj,
      // Valid JSON but section entry has no id field.
      taxonomy_mapping_json: JSON.stringify({ sections: [{}] }),
    });

    let threw = false;
    try {
      runs.finalizeRun({ run_id, status: "complete" });
    } catch (err) {
      threw = true;
      // VG-1 fires on missing id (CompletionChecklistGateViolation).
      // VG-2 may fire first if shape is rejected there too — both are correct fail-closed.
      const acceptable = ["CompletionChecklistGateViolation", "ArtifactAvailabilityGateViolation"];
      assert.ok(acceptable.includes(err.name),
        `expected gate violation for missing id, got ${err.name}: ${err.message}`);
    }
    assert.ok(threw, "sections:[{}] (no id) must fail closed");
  });

  it("unknown taxonomy id '4.99' -> fail closed (CompletionChecklistGateViolation)", async () => {
    const runs = await getRuns();
    const proj = mkdtempSync(join(tmpdir(), "pp-vg1-d2-"));
    mkdirSync(join(proj, ".harness"), { recursive: true });
    writeFileSync(join(proj, "AGENTS.md"), "# AGENTS\n", "utf8");
    await writePopulatedMasterPlan(proj, []);

    const run_id = await insertRun({
      project_path: proj,
      taxonomy_mapping_json: JSON.stringify({
        sections: [{ id: "4.99", title: "Unknown", rationale: "r", required_artifacts: [] }],
      }),
    });

    let threw = false;
    try {
      runs.finalizeRun({ run_id, status: "complete" });
    } catch (err) {
      threw = true;
      assert.equal(err.name, "CompletionChecklistGateViolation",
        `expected CompletionChecklistGateViolation for unknown id, got ${err.name}: ${err.message}`);
      assert.match(err.message, /PP-VG-1/);
      assert.match(err.message, /unknown taxonomy section id/i);
      assert.match(err.message, /4\.99/);
    }
    assert.ok(threw, "unknown taxonomy id must fail closed with CompletionChecklistGateViolation");
  });

  it("malformed taxonomy JSON -> fail closed (VG-2 or VG-1 blocks)", async () => {
    const runs = await getRuns();
    const proj = mkdtempSync(join(tmpdir(), "pp-vg1-e-"));
    mkdirSync(join(proj, ".harness"), { recursive: true });
    writeFileSync(join(proj, "AGENTS.md"), "# AGENTS\n", "utf8");
    await writePopulatedMasterPlan(proj, []);

    const run_id = await insertRun({ project_path: proj });
    const db = await getDb();
    db().prepare(`UPDATE runs SET taxonomy_mapping_json = '{BROKEN' WHERE id = ?`).run(run_id);

    let threw = false;
    try {
      runs.finalizeRun({ run_id, status: "complete" });
    } catch (err) {
      threw = true;
      const acceptable = ["CompletionChecklistGateViolation", "ArtifactAvailabilityGateViolation"];
      assert.ok(acceptable.includes(err.name),
        `expected gate violation, got ${err.name}: ${err.message}`);
      assert.match(err.message, /taxonomy_mapping_json/);
    }
    assert.ok(threw, "malformed JSON must fail closed");
  });

  it("NULL taxonomy_mapping_json -> not blocked (no responsible sections)", async () => {
    const runs = await getRuns();
    const proj = mkdtempSync(join(tmpdir(), "pp-vg1-f-"));
    mkdirSync(join(proj, ".harness"), { recursive: true });
    writeFileSync(join(proj, "AGENTS.md"), "# AGENTS\n", "utf8");
    await writePopulatedMasterPlan(proj, []);

    const run_id = await insertRun({ project_path: proj }); // no taxonomy_mapping_json

    const result = runs.finalizeRun({ run_id, status: "complete" });
    assert.equal(result.effective_status, "complete",
      "NULL taxonomy_mapping_json means no responsible sections; must not block VG-1");
  });

  it("READ-ONLY: blocked finalize must NOT modify PROJECT_MASTER.md", async () => {
    const runs = await getRuns();
    const proj = mkdtempSync(join(tmpdir(), "pp-vg1-g-"));
    mkdirSync(join(proj, ".harness"), { recursive: true });
    writeFileSync(join(proj, "AGENTS.md"), "# AGENTS\n", "utf8");
    await writePopulatedMasterPlan(proj, []);

    const masterPath = join(proj, "PROJECT_MASTER.md");
    const beforeContent = readFileSync(masterPath, "utf8");
    const beforeMtime = statSync(masterPath).mtimeMs;

    const run_id = await insertRun({
      project_path: proj,
      taxonomy_mapping_json: JSON.stringify({
        scope: "standard", signals: [],
        sections: [{ id: "4.6", title: "Arch", rationale: "r", required_artifacts: [] }],
        missability_required: [],
      }),
    });

    let threw = false;
    try {
      runs.finalizeRun({ run_id, status: "complete" });
    } catch (err) {
      threw = true;
      assert.equal(err.name, "CompletionChecklistGateViolation",
        `expected CompletionChecklistGateViolation, got ${err.name}`);
    }
    assert.ok(threw, "must throw to test read-only invariant");

    const afterContent = readFileSync(masterPath, "utf8");
    const afterMtime = statSync(masterPath).mtimeMs;
    assert.equal(afterContent, beforeContent,
      "PROJECT_MASTER.md must not be modified when finalize is blocked by VG-1");
    assert.equal(afterMtime, beforeMtime,
      "PROJECT_MASTER.md mtime must not change after a blocked finalize");
  });

  it("explicit section->checklist map: populated section passes; unpopulated blocks (not circular)", async () => {
    // 4.9 -> "14. Security, privacy, and compliance"
    // Populated = gate passes. Demonstrates explicit map used, not circular.
    const runs = await getRuns();
    const proj = mkdtempSync(join(tmpdir(), "pp-vg1-h-"));
    mkdirSync(join(proj, ".harness"), { recursive: true });
    writeFileSync(join(proj, "AGENTS.md"), "# AGENTS\n", "utf8");
    await writePopulatedMasterPlan(proj, ["14. Security, privacy, and compliance"]);

    const run_id = await insertRun({
      project_path: proj,
      taxonomy_mapping_json: JSON.stringify({
        scope: "standard", signals: [],
        sections: [{ id: "4.9", title: "Security", rationale: "r", required_artifacts: [] }],
        missability_required: [],
      }),
    });

    const result = runs.finalizeRun({ run_id, status: "complete" });
    assert.equal(result.effective_status, "complete",
      "populated security section must clear VG-1 via explicit section->checklist map");
  });

});

// ─── VG-1 additional: non-canonical master_plan_section ─────────────────
describe("VG-1: non-canonical master_plan_section (Fix #2)", () => {

  it("taxonomy entry whose master_plan_section is NOT in canonical set -> fail closed", async () => {
    const runs = await getRuns();
    // Inject a fake taxonomy entry with a non-canonical master_plan_section
    // into the live TAXONOMY_BY_ID object (shared singleton with runs.js).
    const taxMod = await importDist("orchestrator/taxonomy.js");
    const FAKE_ID = "4.TEST_NONCANON";
    taxMod.TAXONOMY_BY_ID[FAKE_ID] = {
      id: FAKE_ID,
      title: "Test non-canonical section",
      default_artifact_kinds: [],
      master_plan_section: "99. Non-canonical ghost section",  // NOT in MASTER_PLAN_SECTIONS
    };

    const proj = mkdtempSync(join(tmpdir(), "pp-vg1-nc-"));
    mkdirSync(join(proj, ".harness"), { recursive: true });
    writeFileSync(join(proj, "AGENTS.md"), "# AGENTS\n", "utf8");
    await writePopulatedMasterPlan(proj, []);

    const run_id = await insertRun({
      project_path: proj,
      taxonomy_mapping_json: JSON.stringify({
        sections: [{ id: FAKE_ID, title: "Non-canonical", rationale: "r", required_artifacts: [] }],
      }),
    });

    let threw = false;
    try {
      runs.finalizeRun({ run_id, status: "complete" });
    } catch (err) {
      threw = true;
      assert.equal(err.name, "CompletionChecklistGateViolation",
        `expected CompletionChecklistGateViolation, got ${err.name}: ${err.message}`);
      assert.match(err.message, /PP-VG-1/);
      assert.match(err.message, /non-canonical/i,
        "error must mention non-canonical");
      assert.match(err.message, /99\. Non-canonical ghost section/,
        "error must include the offending section value");
    } finally {
      // Clean up the injected fake entry.
      delete taxMod.TAXONOMY_BY_ID[FAKE_ID];
    }
    assert.ok(threw, "non-canonical master_plan_section must fail closed with CompletionChecklistGateViolation");
  });

  it("canonical master_plan_section ('11. Architecture...') via 4.6 -> passes (not blocked by canonical check)", async () => {
    const runs = await getRuns();
    const proj = mkdtempSync(join(tmpdir(), "pp-vg1-canon-"));
    mkdirSync(join(proj, ".harness"), { recursive: true });
    writeFileSync(join(proj, "AGENTS.md"), "# AGENTS\n", "utf8");
    // Populate the section that 4.6 maps to.
    await writePopulatedMasterPlan(proj, ["11. Architecture and technical strategy"]);

    const run_id = await insertRun({
      project_path: proj,
      taxonomy_mapping_json: JSON.stringify({
        scope: "standard", signals: [],
        sections: [{ id: "4.6", title: "Architecture", rationale: "r", required_artifacts: [] }],
        missability_required: [],
      }),
    });

    const result = runs.finalizeRun({ run_id, status: "complete" });
    assert.equal(result.effective_status, "complete",
      "canonical section via 4.6 must pass canonical check and not be blocked");
  });

});

// ─── VG-5: smoke/assertion gate ──────────────────────────────────────────
describe("VG-5: smoke gate — binds to winning attempt, classifies by produced artifacts", () => {

  it("winner attempt with executed smoke pass (correct candidate_index) -> not blocked", async () => {
    const runs = await getRuns();
    const run_id = await insertRun();
    const stage_id = await insertStage(run_id, "code");
    await insertCodeArtifact(run_id, stage_id, "code");

    const attempt_id = await insertAttempt(stage_id, {
      notes_json: JSON.stringify({ candidate_index: 1 }),
    });
    const db = await getDb();
    db().prepare(`UPDATE stages SET winner_attempt_id = ? WHERE id = ?`).run(attempt_id, stage_id);
    db().prepare(`UPDATE stages SET notes_json = ? WHERE id = ?`).run(
      JSON.stringify({ smoke_results: { "1": { status: "pass", reason: null, recorded_at: new Date().toISOString() } } }),
      stage_id,
    );

    const readiness = runs.getStageFinalizeReadiness(stage_id);
    const blocker = readiness.blockers.find(b => b.gate === "smoke");
    assert.equal(blocker, undefined, "winner attempt with correct smoke pass must clear VG-5");
  });

  it("winner attempt with NO smoke pass -> blocked", async () => {
    const runs = await getRuns();
    const run_id = await insertRun();
    const stage_id = await insertStage(run_id, "code");
    await insertCodeArtifact(run_id, stage_id, "code");

    const attempt_id = await insertAttempt(stage_id, {
      notes_json: JSON.stringify({ candidate_index: 1 }),
    });
    const db = await getDb();
    db().prepare(`UPDATE stages SET winner_attempt_id = ? WHERE id = ?`).run(attempt_id, stage_id);
    // No smoke_results entry at all.
    db().prepare(`UPDATE stages SET notes_json = ? WHERE id = ?`).run(
      JSON.stringify({ smoke_results: {} }),
      stage_id,
    );

    const readiness = runs.getStageFinalizeReadiness(stage_id);
    assert.equal(readiness.can_pass, false, "no smoke pass must block VG-5");
    const blocker = readiness.blockers.find(b => b.gate === "smoke");
    assert.ok(blocker, "smoke blocker must be present");
    assert.equal(blocker.next_action, "record_smoke_or_assertion");
    assert.match(blocker.message, /PP-VG-5/);
  });

  it("smoke pass tied to NON-winner candidate_index -> blocked", async () => {
    const runs = await getRuns();
    const run_id = await insertRun();
    const stage_id = await insertStage(run_id, "code");
    await insertCodeArtifact(run_id, stage_id, "code");

    // Winner is candidate 1 — only candidate 2 has a smoke pass.
    const attempt_id = await insertAttempt(stage_id, {
      notes_json: JSON.stringify({ candidate_index: 1 }),
    });
    const db = await getDb();
    db().prepare(`UPDATE stages SET winner_attempt_id = ? WHERE id = ?`).run(attempt_id, stage_id);
    db().prepare(`UPDATE stages SET notes_json = ? WHERE id = ?`).run(
      JSON.stringify({
        smoke_results: {
          "1": { status: "fail",  reason: "crash", recorded_at: new Date().toISOString() },
          "2": { status: "pass",  reason: null,    recorded_at: new Date().toISOString() },
        },
      }),
      stage_id,
    );

    const readiness = runs.getStageFinalizeReadiness(stage_id);
    assert.equal(readiness.can_pass, false, "pass for non-winner candidate must not clear VG-5");
    const blocker = readiness.blockers.find(b => b.gate === "smoke");
    assert.ok(blocker, "smoke blocker must be present when only non-winner candidate has pass");
  });

  it("no winner_attempt_id set -> blocked (fail closed)", async () => {
    const runs = await getRuns();
    const run_id = await insertRun();
    const stage_id = await insertStage(run_id, "code");
    await insertCodeArtifact(run_id, stage_id, "code");
    // Smoke pass exists for candidate 1 but no winner is set.
    const db = await getDb();
    db().prepare(`UPDATE stages SET notes_json = ? WHERE id = ?`).run(
      JSON.stringify({ smoke_results: { "1": { status: "pass", reason: null, recorded_at: new Date().toISOString() } } }),
      stage_id,
    );

    const readiness = runs.getStageFinalizeReadiness(stage_id);
    assert.equal(readiness.can_pass, false,
      "no winner_attempt_id must block VG-5 (fail closed — no 'accept any' path)");
    const blocker = readiness.blockers.find(b => b.gate === "smoke");
    assert.ok(blocker, "smoke blocker must fire when winner_attempt_id is null");
  });

  it("winner has no candidate_index in notes -> fail closed", async () => {
    const runs = await getRuns();
    const run_id = await insertRun();
    const stage_id = await insertStage(run_id, "code");
    await insertCodeArtifact(run_id, stage_id, "code");

    // Winner attempt has no candidate_index in notes.
    const attempt_id = await insertAttempt(stage_id, {
      notes_json: JSON.stringify({ touched_hashes_path: "some/path.txt" }),
    });
    const db = await getDb();
    db().prepare(`UPDATE stages SET winner_attempt_id = ? WHERE id = ?`).run(attempt_id, stage_id);
    // Stage has a pass for candidate 1 — but winner has no candidate_index.
    db().prepare(`UPDATE stages SET notes_json = ? WHERE id = ?`).run(
      JSON.stringify({ smoke_results: { "1": { status: "pass", reason: null, recorded_at: new Date().toISOString() } } }),
      stage_id,
    );

    const readiness = runs.getStageFinalizeReadiness(stage_id);
    assert.equal(readiness.can_pass, false,
      "winner with no candidate_index must fail closed (no smoke row resolved)");
    const blocker = readiness.blockers.find(b => b.gate === "smoke");
    assert.ok(blocker, "smoke blocker must be present when candidate_index absent from winner");
  });

  it("smoke status='skipped' -> blocked (not pass)", async () => {
    const runs = await getRuns();
    const run_id = await insertRun();
    const stage_id = await insertStage(run_id, "code");
    await insertCodeArtifact(run_id, stage_id, "code");

    const attempt_id = await insertAttempt(stage_id, {
      notes_json: JSON.stringify({ candidate_index: 1 }),
    });
    const db = await getDb();
    db().prepare(`UPDATE stages SET winner_attempt_id = ? WHERE id = ?`).run(attempt_id, stage_id);
    db().prepare(`UPDATE stages SET notes_json = ? WHERE id = ?`).run(
      JSON.stringify({ smoke_results: { "1": { status: "skipped", reason: "non-ui-project", recorded_at: new Date().toISOString() } } }),
      stage_id,
    );

    const readiness = runs.getStageFinalizeReadiness(stage_id);
    assert.equal(readiness.can_pass, false, "smoke=skipped must block VG-5");
    const blocker = readiness.blockers.find(b => b.gate === "smoke");
    assert.ok(blocker, "smoke blocker must be present for skipped status");
  });

  it("stage with no code/diff artifacts -> NOT smoke-required (VG-5 skipped)", async () => {
    const runs = await getRuns();
    const run_id = await insertRun();
    const stage_id = await insertStage(run_id, "spec");
    // No code/diff artifacts — VG-5 must not fire.

    const readiness = runs.getStageFinalizeReadiness(stage_id);
    const blocker = readiness.blockers.find(b => b.gate === "smoke");
    assert.equal(blocker, undefined, "stage with no code/diff artifacts must not trigger VG-5");
  });

  it("stage labeled 'spec' but produced diff artifact -> smoke-required (artifact-based classification)", async () => {
    const runs = await getRuns();
    const run_id = await insertRun();
    const stage_id = await insertStage(run_id, "spec"); // mislabeled
    await insertCodeArtifact(run_id, stage_id, "diff"); // but produced a diff

    // No winner, no smoke pass -> should block.
    const readiness = runs.getStageFinalizeReadiness(stage_id);
    const blocker = readiness.blockers.find(b => b.gate === "smoke");
    assert.ok(blocker,
      "stage labeled 'spec' but with diff artifact must be smoke-required (artifact-based)");
    assert.equal(blocker.next_action, "record_smoke_or_assertion");
    assert.match(blocker.message, /PP-VG-5/);
  });

  it("stage with only 'adr' artifact (not code/diff) -> NOT smoke-required", async () => {
    const runs = await getRuns();
    const db = await getDb();
    const run_id = await insertRun();
    const stage_id = await insertStage(run_id, "architecture");
    const art_id = `art_fgc_${Math.random().toString(36).slice(2, 12)}`;
    db().prepare(
      `INSERT INTO artifacts(id, run_id, stage_id, kind, path, sha256, bytes, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(art_id, run_id, stage_id, "adr", "arch.md", "def456", 100, new Date().toISOString());

    const readiness = runs.getStageFinalizeReadiness(stage_id);
    const blocker = readiness.blockers.find(b => b.gate === "smoke");
    assert.equal(blocker, undefined, "stage with only 'adr' artifact must not trigger VG-5");
  });

  it("code stage with TDD predecessor -> VG-5 skipped (TDD gate covers it)", async () => {
    const runs = await getRuns();
    const run_id = await insertRun();
    const db = await getDb();

    const tests_pre_id = await insertStage(run_id, "tests_pre");
    db().prepare(`UPDATE stages SET status = 'passed', finished_at = ? WHERE id = ?`)
      .run(new Date().toISOString(), tests_pre_id);

    await new Promise(r => setTimeout(r, 2));
    const code_stage_id = await insertStage(run_id, "code");
    await insertCodeArtifact(run_id, code_stage_id, "code");
    // No smoke pass — but TDD predecessor exempts this stage from VG-5.

    const readiness = runs.getStageFinalizeReadiness(code_stage_id);
    const blocker = readiness.blockers.find(b => b.gate === "smoke");
    assert.equal(blocker, undefined,
      "code stage with TDD tests_pre predecessor must not be blocked by VG-5");
  });

  // ── Fix #1: winner_attempt_id passed as PARAM (not persisted on stage) ──

  it("HAPPY PATH: winner_attempt_id param (not persisted) + candidate_index 0 + smoke pass[0] -> can_pass true", async () => {
    // This is the canonical finalize_stage path: readiness is checked INSIDE
    // finalizeStage before winner_attempt_id is written to the stages row.
    // The fix threads input.winner_attempt_id into getStageFinalizeReadiness.
    const runs = await getRuns();
    const run_id = await insertRun();
    const stage_id = await insertStage(run_id, "code");
    await insertCodeArtifact(run_id, stage_id, "code");

    // Insert winner attempt with candidate_index = 0 in notes_json.
    const attempt_id = await insertAttempt(stage_id, {
      notes_json: JSON.stringify({ candidate_index: 0 }),
    });
    // Do NOT set winner_attempt_id on the stage row (simulates pre-persist state).
    const db = await getDb();
    db().prepare(`UPDATE stages SET notes_json = ? WHERE id = ?`).run(
      JSON.stringify({ smoke_results: { "0": { status: "pass", reason: null, recorded_at: new Date().toISOString() } } }),
      stage_id,
    );

    // Call with winner_attempt_id as param — stage row has NULL winner_attempt_id.
    const readiness = runs.getStageFinalizeReadiness(stage_id, attempt_id);
    const blocker = readiness.blockers.find(b => b.gate === "smoke");
    assert.equal(blocker, undefined,
      "HAPPY PATH: winner_attempt_id passed as param must resolve smoke pass and clear VG-5 (PASSABLE)");
    assert.equal(readiness.can_pass, true,
      "can_pass must be true when winner_attempt_id param + candidate_index + smoke pass all align");
  });

  it("winner_attempt_id passed as PARAM but no smoke pass for its candidate_index -> still blocked", async () => {
    const runs = await getRuns();
    const run_id = await insertRun();
    const stage_id = await insertStage(run_id, "code");
    await insertCodeArtifact(run_id, stage_id, "code");

    const attempt_id = await insertAttempt(stage_id, {
      notes_json: JSON.stringify({ candidate_index: 0 }),
    });
    // Stage has no smoke_results at all.
    const db = await getDb();
    db().prepare(`UPDATE stages SET notes_json = ? WHERE id = ?`).run(
      JSON.stringify({ smoke_results: {} }),
      stage_id,
    );

    const readiness = runs.getStageFinalizeReadiness(stage_id, attempt_id);
    assert.equal(readiness.can_pass, false,
      "param-threaded winner with no smoke pass must still block VG-5");
    const blocker = readiness.blockers.find(b => b.gate === "smoke");
    assert.ok(blocker, "smoke blocker must be present");
  });

  it("winner_attempt_id param but smoke pass is for candidate 1, winner is candidate 0 -> blocked", async () => {
    const runs = await getRuns();
    const run_id = await insertRun();
    const stage_id = await insertStage(run_id, "code");
    await insertCodeArtifact(run_id, stage_id, "code");

    // Winner is candidate 0; only candidate 1 has a smoke pass.
    const attempt_id = await insertAttempt(stage_id, {
      notes_json: JSON.stringify({ candidate_index: 0 }),
    });
    const db = await getDb();
    db().prepare(`UPDATE stages SET notes_json = ? WHERE id = ?`).run(
      JSON.stringify({
        smoke_results: {
          "0": { status: "fail",  reason: "crash", recorded_at: new Date().toISOString() },
          "1": { status: "pass",  reason: null,    recorded_at: new Date().toISOString() },
        },
      }),
      stage_id,
    );

    const readiness = runs.getStageFinalizeReadiness(stage_id, attempt_id);
    assert.equal(readiness.can_pass, false,
      "smoke pass for non-winner candidate must not clear VG-5 even with param-threaded winner");
    const blocker = readiness.blockers.find(b => b.gate === "smoke");
    assert.ok(blocker, "smoke blocker must be present");
  });

  // ── Cross-stage attempt ownership checks (Fix #1 hole) ──────────────────

  it("winner_attempt_id belongs to a DIFFERENT stage -> fail closed (cross-stage bypass blocked)", async () => {
    // The winner_attempt_id resolves to an attempt on stage_B, not stage_A.
    // VG-5 on stage_A must reject it — the scoped SELECT (AND stage_id = ?)
    // returns no row, so candidateIndex stays null → blocked.
    const runs = await getRuns();
    const db = await getDb();
    const run_id = await insertRun();

    // stage_A: the stage we're finalizing.
    const stage_a = await insertStage(run_id, "code");
    await insertCodeArtifact(run_id, stage_a, "code");
    db().prepare(`UPDATE stages SET notes_json = ? WHERE id = ?`).run(
      JSON.stringify({ smoke_results: { "0": { status: "pass", reason: null, recorded_at: new Date().toISOString() } } }),
      stage_a,
    );

    // stage_B: a foreign stage whose attempt has candidate_index 0 + a passing smoke.
    const stage_b = await insertStage(run_id, "code");
    await insertCodeArtifact(run_id, stage_b, "code");
    const foreign_attempt_id = await insertAttempt(stage_b, {
      notes_json: JSON.stringify({ candidate_index: 0 }),
    });
    db().prepare(`UPDATE stages SET notes_json = ? WHERE id = ?`).run(
      JSON.stringify({ smoke_results: { "0": { status: "pass", reason: null, recorded_at: new Date().toISOString() } } }),
      stage_b,
    );

    // Pass the FOREIGN attempt (from stage_B) as the winner for stage_A.
    const readiness = runs.getStageFinalizeReadiness(stage_a, foreign_attempt_id);
    assert.equal(readiness.can_pass, false,
      "winner_attempt_id from a different stage must be rejected — VG-5 must fail closed");
    const blocker = readiness.blockers.find(b => b.gate === "smoke");
    assert.ok(blocker,
      "smoke blocker must fire when winner attempt belongs to a different stage");
  });

  it("winner_attempt_id does not exist at all -> fail closed", async () => {
    const runs = await getRuns();
    const db = await getDb();
    const run_id = await insertRun();
    const stage_id = await insertStage(run_id, "code");
    await insertCodeArtifact(run_id, stage_id, "code");
    db().prepare(`UPDATE stages SET notes_json = ? WHERE id = ?`).run(
      JSON.stringify({ smoke_results: { "0": { status: "pass", reason: null, recorded_at: new Date().toISOString() } } }),
      stage_id,
    );

    // Pass a nonexistent attempt id.
    const readiness = runs.getStageFinalizeReadiness(stage_id, "attempt_does_not_exist_xyz");
    assert.equal(readiness.can_pass, false,
      "nonexistent winner_attempt_id must fail closed");
    const blocker = readiness.blockers.find(b => b.gate === "smoke");
    assert.ok(blocker, "smoke blocker must fire for nonexistent winner attempt");
  });

  it("winner attempt has candidate_index = -1 (invalid) -> fail closed", async () => {
    const runs = await getRuns();
    const db = await getDb();
    const run_id = await insertRun();
    const stage_id = await insertStage(run_id, "code");
    await insertCodeArtifact(run_id, stage_id, "code");

    const attempt_id = await insertAttempt(stage_id, {
      notes_json: JSON.stringify({ candidate_index: -1 }),
    });
    db().prepare(`UPDATE stages SET notes_json = ? WHERE id = ?`).run(
      JSON.stringify({ smoke_results: { "-1": { status: "pass", reason: null, recorded_at: new Date().toISOString() } } }),
      stage_id,
    );

    const readiness = runs.getStageFinalizeReadiness(stage_id, attempt_id);
    assert.equal(readiness.can_pass, false,
      "candidate_index = -1 is invalid and must fail closed");
    const blocker = readiness.blockers.find(b => b.gate === "smoke");
    assert.ok(blocker, "smoke blocker must fire for negative candidate_index");
  });

});
