// J10 (daemon half) — start_run persists driver-parsed cli_flags and replay
// surfaces them together with the archived judge_decisions.json.
//
// Asserts, against a temp SQLite DB (no daemon, no MCP peer):
//   1. startRun({ cli_flags }) writes runs.cli_flags_json verbatim.
//   2. startRun without cli_flags leaves the column NULL (not "{}").
//   3. buildReplayBundle returns cli_flags and judge_resolution (parsed from
//      <artifact_dir>/judge_decisions.json), and null judge_resolution when
//      the driver archived none.
//   4. reproduction_notes tells the replayer to re-pass --judge-* flags.

import { strict as assert } from "node:assert";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { execSync } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DIST = join(__dirname, "..", "dist");

const SUITE_DIR = mkdtempSync(join(tmpdir(), "pp-run-cli-flags-"));
mkdirSync(join(SUITE_DIR, ".pair-programmer"), { recursive: true });
process.env.PP_HOME = SUITE_DIR;
process.env.EIGHTS_SKIP_AUDIT_CHECK = "1";

const runs = await import(pathToFileURL(join(DIST, "orchestrator", "runs.js")).href);
const { buildReplayBundle } = await import(pathToFileURL(join(DIST, "orchestrator", "replay.js")).href);
const { db } = await import(pathToFileURL(join(DIST, "db", "database.js")).href);
const { projectArtifactDir } = await import(pathToFileURL(join(DIST, "util", "paths.js")).href);

let passed = 0, failed = 0;
async function it(label, fn) {
  try { await fn(); passed++; console.log(`✓ ${label}`); }
  catch (err) { failed++; console.error(`✗ ${label}`); console.error(`  ${err.message}`); }
}

let seq = 0;
function scaffoldProject() {
  const project = mkdtempSync(join(tmpdir(), `pp-rcf-${seq++}-`));
  mkdirSync(join(project, ".harness"), { recursive: true });
  writeFileSync(join(project, "AGENTS.md"), "# AGENTS\n", "utf8");
  try {
    execSync("git init -q", { cwd: project, stdio: "ignore" });
    execSync("git -c user.email=t@t -c user.name=t commit -q --allow-empty -m init", { cwd: project, stdio: "ignore" });
  } catch { /* head_sha simply stays null */ }
  return project;
}

const FLAGS = {
  tier_cap: "sonnet",
  judge_vendor: "codex",
  judge_model: "gpt-5.6-luna",
  judge_effort: "high",
  judge_escalate: false,
  judge_reason: "operator wants the luna judge for this contract gate",
};

let runWithFlags;
await it("startRun persists cli_flags verbatim as runs.cli_flags_json", async () => {
  const project = scaffoldProject();
  runWithFlags = await runs.startRun({
    request_text: "cli flags fixture",
    project_path: project,
    mode: "single",
    cli_flags: FLAGS,
  });
  const row = db().prepare("SELECT cli_flags_json FROM runs WHERE id = ?").get(runWithFlags.run_id);
  assert.ok(row, "run row exists");
  assert.deepEqual(JSON.parse(row.cli_flags_json), FLAGS);
});

await it("startRun without cli_flags leaves cli_flags_json NULL", async () => {
  const project = scaffoldProject();
  const r = await runs.startRun({ request_text: "no flags fixture", project_path: project, mode: "single" });
  const row = db().prepare("SELECT cli_flags_json FROM runs WHERE id = ?").get(r.run_id);
  assert.equal(row.cli_flags_json, null);
});

await it("startRun with an empty cli_flags object leaves cli_flags_json NULL", async () => {
  const project = scaffoldProject();
  const r = await runs.startRun({ request_text: "empty flags fixture", project_path: project, mode: "single", cli_flags: {} });
  const row = db().prepare("SELECT cli_flags_json FROM runs WHERE id = ?").get(r.run_id);
  assert.equal(row.cli_flags_json, null);
});

await it("buildReplayBundle surfaces cli_flags and a parsed judge_decisions.json", async () => {
  const run = db().prepare("SELECT project_path FROM runs WHERE id = ?").get(runWithFlags.run_id);
  const dir = projectArtifactDir(run.project_path, runWithFlags.run_id);
  mkdirSync(dir, { recursive: true });
  const decisions = {
    cli_flags: { judge_vendor: "codex", judge_model: "gpt-5.6-luna", judge_effort: "high", judge_escalate: false, judge_reason: FLAGS.judge_reason },
    allowed_critique_models: { codex: ["gpt-5.6-terra", "gpt-5.6-sol", "gpt-5.6-luna"] },
    per_stage: [{ stage_id: "stage_x", stage_kind: "code", gate_type: "contract", required_cross_vendor: true,
      judge_agent: "judge-cross-vendor", generator_producer: "claude", generator_model: "claude-sonnet-5",
      resolved: { vendor: "codex", model: "gpt-5.6-luna", reasoning_effort: "high", escalate: false },
      source: "cli", reason: FLAGS.judge_reason, trace: [{ layer: "default" }, { layer: "cli", field: "model" }],
      verdict_id: null, outcome: null, cross_vendor: true }],
  };
  writeFileSync(join(dir, "judge_decisions.json"), JSON.stringify(decisions), "utf8");
  assert.ok(existsSync(join(dir, "judge_decisions.json")));
  const bundle = buildReplayBundle(runWithFlags.run_id);
  assert.ok(bundle);
  assert.deepEqual(bundle.cli_flags, FLAGS);
  assert.deepEqual(bundle.judge_resolution, decisions);
  assert.match(bundle.reproduction_notes, /--judge-\*/);
  assert.match(bundle.reproduction_notes, /--judge-reason/);
});

await it("buildReplayBundle returns judge_resolution null when the driver archived none", async () => {
  const project = scaffoldProject();
  const r = await runs.startRun({ request_text: "no decisions fixture", project_path: project, mode: "single" });
  const bundle = buildReplayBundle(r.run_id);
  assert.equal(bundle.judge_resolution, null);
  assert.equal(bundle.cli_flags, null);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
