/**
 * hydra-context-block.unit.mjs
 *
 * Unit tests for Phase 7a: hydra_context_block returned on start_run /
 * ensure_run when the run is linked to a Hydra workflow.
 *
 * The rendered block is returned by the daemon as a field on the tool result;
 * the driver (Hydra host_bridge / squad_node) injects it into generator
 * prompts. pp never assembles prompts itself.
 *
 * Tests:
 *   (a) startRun with hydra_workflow_id returns hydra_context_block that
 *       contains the workflow_id and the "## Hydra context" heading.
 *   (b) startRun without any hydra fields returns NO hydra_context_block key
 *       (field must be absent, not just undefined/null).
 *   (c) ensureRun returning an existing hydra-linked run includes
 *       hydra_context_block containing the workflow_id and heading.
 *
 * Anti-stall contract:
 *   - Uses a temp sqlite DB (PP_HOME override), direct dist function calls.
 *   - No MCP server, no daemon socket, no smoke files touched.
 *   - Run: timeout 90 node --test test/hydra-context-block.unit.mjs
 */

import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync, mkdirSync } from "node:fs";
import assert from "node:assert/strict";
import { describe, it } from "node:test";

// Set PP_HOME BEFORE any dist import so the DB is isolated.
const SUITE_DIR = mkdtempSync(join(tmpdir(), "pp-hydra-ctx-block-"));
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

// ── Shared project directory factory ─────────────────────────────────────────

function makeProject() {
  const dir = mkdtempSync(join(tmpdir(), "pp-hcb-proj-"));
  mkdirSync(join(dir, ".harness"), { recursive: true });
  return dir;
}

// ── SQL helper: insert a run row with hydra fields directly ──────────────────
// No file I/O, no git, no eights. Status='running' so ensureRun can find it.

async function insertHydraRun(projectPath, { workflowId = "wf_test_001", kind = "ad-hoc" } = {}) {
  const db = await getDb();
  const id = `run_hcb_${Math.random().toString(36).slice(2, 12)}`;
  const now = new Date().toISOString();
  db().prepare(
    `INSERT INTO runs(id, project_path, request_text, mode, status, team, started_at,
       hydra_workflow_id, hydra_envelope_id, hydra_origin_squad, hydra_envelope_type)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id, projectPath, "hydra ctx block test", "single", "running", kind, now,
    workflowId, null, "engineering", null,
  );
  return id;
}

// ── Tests (a) & (b): startRun ─────────────────────────────────────────────────

describe("hydra_context_block: startRun", () => {

  it("(a) startRun with hydra_workflow_id returns hydra_context_block containing workflow_id and heading", async () => {
    const runs = await getRuns();
    const project = makeProject();
    const workflowId = "wf_phase7a_abc123";

    const out = await runs.startRun({
      request_text: "test — hydra context block in startRun",
      project_path: project,
      mode: "single",
      hydra_workflow_id: workflowId,
      hydra_origin_squad: "engineering",
    });

    assert.ok(
      Object.prototype.hasOwnProperty.call(out, "hydra_context_block"),
      "startRun with hydra_workflow_id must return hydra_context_block as an own property",
    );
    assert.equal(
      typeof out.hydra_context_block, "string",
      "hydra_context_block must be a string",
    );
    assert.ok(
      out.hydra_context_block.length > 0,
      "hydra_context_block must be non-empty",
    );
    assert.ok(
      out.hydra_context_block.includes("## Hydra context"),
      `hydra_context_block must contain "## Hydra context" heading; got: ${out.hydra_context_block.slice(0, 120)}`,
    );
    assert.ok(
      out.hydra_context_block.includes(workflowId),
      `hydra_context_block must contain the workflow_id (${workflowId})`,
    );

    // Release the project lock so the test process can exit cleanly.
    runs.finalizeRun({ run_id: out.run_id, status: "surfaced" });
  });

  it("(b) startRun without hydra fields returns NO hydra_context_block key", async () => {
    const runs = await getRuns();
    const project = makeProject();

    const out = await runs.startRun({
      request_text: "standalone run — no hydra fields",
      project_path: project,
      mode: "single",
    });

    assert.ok(
      !Object.prototype.hasOwnProperty.call(out, "hydra_context_block"),
      "startRun without hydra fields must NOT include hydra_context_block as an own property",
    );

    // Release the project lock.
    runs.finalizeRun({ run_id: out.run_id, status: "surfaced" });
  });

});

// ── Test (c): ensureRun existing hydra-linked run ────────────────────────────

describe("hydra_context_block: ensureRun", () => {

  it("(c) ensureRun returning an existing hydra-linked run includes hydra_context_block", async () => {
    const runs = await getRuns();
    const project = makeProject();
    const workflowId = "wf_ensure_7a_xyz789";
    const kind = "engineering";

    // Insert a run row directly with hydra fields so no project-lock file is
    // created. ensureRun's existing-case path only reads the DB + returns;
    // it does not check or acquire the lock on an existing run.
    await insertHydraRun(project, { workflowId, kind });

    const out = await runs.ensureRun({
      project_path: project,
      request_text: "ensure_run reuse test",
      kind,
    });

    assert.equal(
      out.created, false,
      "ensureRun must reuse the existing run (created=false)",
    );
    assert.ok(
      Object.prototype.hasOwnProperty.call(out, "hydra_context_block"),
      "ensureRun for a hydra-linked existing run must return hydra_context_block",
    );
    assert.equal(
      typeof out.hydra_context_block, "string",
      "hydra_context_block must be a string",
    );
    assert.ok(
      out.hydra_context_block.length > 0,
      "hydra_context_block must be non-empty",
    );
    assert.ok(
      out.hydra_context_block.includes("## Hydra context"),
      `hydra_context_block must contain "## Hydra context" heading`,
    );
    assert.ok(
      out.hydra_context_block.includes(workflowId),
      `hydra_context_block must contain workflow_id (${workflowId})`,
    );
  });

});
