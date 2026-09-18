/**
 * cli-runner-timeout-classification.unit.mjs
 *
 * Regression guard kept from the withdrawn process-tree-sweep work
 * (cli-runner-kill-sweep.unit.mjs, removed — see cli-runner.ts's
 * _spawnTracked doc comment for why the sweep itself was withdrawn).
 *
 * This is the one case from that file that still applies and mattered on
 * its own merits, independent of the sweep: a `reject:false` trackedExeca
 * call whose command hangs past its timeout must report `timedOut === true`,
 * and the real `runTddCheck()` path (daemon/src/orchestrator/tdd-gate.ts)
 * must classify that as a timeout rather than an ordinary test failure.
 * Stripping execa's own `timeout` option before it reaches execa (or losing
 * `timedOut` on the result) makes this test fail.
 *
 * Anti-stall contract:
 *   - Uses a temp sqlite DB (PP_HOME override) + temp project dir, direct
 *     dist function calls. No MCP server, no daemon socket.
 *   - The hung child is killed by trackedExeca's own timeout handling; no
 *     manual cleanup needed since it's registered in ACTIVE_CHILDREN.
 *   - Run: node --test test/cli-runner-timeout-classification.unit.mjs
 */

import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import test from "node:test";
import assert from "node:assert/strict";

const SUITE_DIR = mkdtempSync(join(tmpdir(), "pp-cli-timeout-class-"));
mkdirSync(join(SUITE_DIR, ".pair-programmer"), { recursive: true });
process.env.PP_HOME = SUITE_DIR;
process.env.EIGHTS_SKIP_AUDIT_CHECK = "1";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DIST = join(__dirname, "..", "dist");
const importDist = (relPath) => import(pathToFileURL(join(DIST, relPath)).href);

const cliRunner = await importDist("mcp/cli-runner.js");
const runs = await importDist("orchestrator/runs.js");
const tddGate = await importDist("orchestrator/tdd-gate.js");

/** Fresh temp project dir with the minimal scaffolding tdd-gate needs. */
function makeProject() {
  const dir = mkdtempSync(join(tmpdir(), "pp-cli-timeout-proj-"));
  mkdirSync(join(dir, ".harness"), { recursive: true });
  return dir;
}

/** Writes a CommonJS script (tmp dirs have no package.json, so `.js` defaults
 * to CJS regardless of the daemon's own "type":"module"). */
function writeScript(dir, name, body) {
  const p = join(dir, name);
  writeFileSync(p, body, "utf8");
  return p;
}

/** A child that never exits on its own and does no work (keeps the loop
 * alive without CPU spin). */
const HANG_BODY = `setInterval(() => {}, 1000);\n`;

/** Bootstrap a run + tests_pre stage + archived tdd_manifest artifact, and
 * return the stage_id for runTddCheck({ stage_id, phase: 'pre' }). */
async function bootstrapTddStage(project, testCommand, timeoutMs) {
  const run = await runs.ensureRun({
    request_text: "cli-runner timeout classification test",
    project_path: project,
    mode: "single",
  });
  const stage = runs.startStage({
    run_id: run.run_id,
    kind: "tests_pre",
    gate_type: "tests_pre",
  });
  const manifestYaml =
    `tdd_mode: bug-fix\n` +
    `test_runner: other\n` +
    `test_command: "${testCommand.replaceAll("\\", "\\\\")}"\n` +
    `test_files:\n  - dummy.test.js\n` +
    `expected_pre_outcome: all_fail\n` +
    `expected_post_outcome: all_pass\n` +
    `timeout_ms: ${timeoutMs}\n` +
    `cited_artifacts:\n  - kind: tdd_manifest\n    path: tests_pre/manifest.yaml\n`;
  const archived = runs.archiveArtifact({
    run_id: run.run_id,
    stage_id: stage.stage_id,
    kind: "tdd_manifest",
    relative_path: "tests_pre/manifest.yaml",
    bytes: manifestYaml,
  });
  assert.equal(archived.status, "ok", "manifest archive must succeed");
  return { run, stage };
}

test("cli-runner: reject:false hang -> timedOut===true, and runTddCheck classifies it as a timeout", async () => {
  const project = makeProject();
  const script = writeScript(project, "hang.js", HANG_BODY);
  // Schema minimum is 10_000ms.
  const { stage } = await bootstrapTddStage(project, `node ${script}`, 10_000);

  const sizeBefore = cliRunner._activeChildrenSize();
  const row = await tddGate.runTddCheck({ stage_id: stage.stage_id, phase: "pre" });

  assert.equal(row.status, "execution_error", "a timed-out test command must not be scored pass/fail");
  assert.match(row.reason ?? "", /exceeded timeout/, "reason must name it a timeout, not an ordinary failure");
  assert.equal(cliRunner._activeChildrenSize(), sizeBefore, "ACTIVE_CHILDREN must be empty again after the run");
});
