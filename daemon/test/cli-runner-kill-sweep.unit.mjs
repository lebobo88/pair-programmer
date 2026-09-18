/**
 * cli-runner-kill-sweep.unit.mjs
 *
 * P1c: _spawnTracked passes execa's own `timeout` option straight through
 * again (restoring `timedOut` metadata and execa's own SIGTERM->SIGKILL
 * escalation), and layers killProcessTree() as an ADDITIONAL best-effort
 * sweep on top, gated on identity so a reused pid is never signalled.
 *
 * Covers the two regressions a cross-vendor judge confirmed against the
 * single-SIGTERM-timer revision:
 *   1. `result.timedOut` must be set for `reject:false` consumers, and the
 *      TDD gate (daemon/src/orchestrator/tdd-gate.ts) must classify a hung
 *      test command as a timeout via the REAL runTddCheck() path (not a
 *      copy of its classification logic).
 *   2. A POSIX child that installs a SIGTERM handler and ignores it must
 *      still be gone by the deadline (execa's forceKillAfterDelay SIGKILL
 *      escalation, not a single SIGTERM that a handler can swallow).
 * Plus the process-tree sweep itself:
 *   3. A launcher whose grandchild outlives the direct child must have that
 *      grandchild gone after the sweep (killProcessTree's tree-wide kill).
 * Every case also asserts ACTIVE_CHILDREN is empty afterward.
 *
 * Anti-stall contract:
 *   - Uses a temp sqlite DB (PP_HOME override) + temp project dir, direct
 *     dist function calls. No MCP server, no daemon socket.
 *   - Every spawned child is force-killed in a `finally` even if an
 *     assertion throws first.
 *   - Run: node --test test/cli-runner-kill-sweep.unit.mjs
 */

import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import test from "node:test";
import assert from "node:assert/strict";

const SUITE_DIR = mkdtempSync(join(tmpdir(), "pp-cli-kill-sweep-"));
mkdirSync(join(SUITE_DIR, ".pair-programmer"), { recursive: true });
process.env.PP_HOME = SUITE_DIR;
process.env.EIGHTS_SKIP_AUDIT_CHECK = "1";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DIST = join(__dirname, "..", "dist");
const importDist = (relPath) => import(pathToFileURL(join(DIST, relPath)).href);

const cliRunner = await importDist("mcp/cli-runner.js");
const runs = await importDist("orchestrator/runs.js");
const tddGate = await importDist("orchestrator/tdd-gate.js");

/** True while `pid` still exists (cross-platform: signal 0 is existence-only). */
function pidAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Poll until `pid` is gone or `timeoutMs` elapses; returns whether it's gone. */
async function waitForDeath(pid, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!pidAlive(pid)) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return !pidAlive(pid);
}

/** Fresh temp project dir with the minimal scaffolding tdd-gate needs. */
function makeProject() {
  const dir = mkdtempSync(join(tmpdir(), "pp-cks-proj-"));
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
 * alive without CPU spin) — used both as a plain "hangs past timeout" child
 * and, combined with a SIGTERM handler, as the ignores-SIGTERM child. */
const HANG_BODY = `setInterval(() => {}, 1000);\n`;

const IGNORE_SIGTERM_BODY =
  `process.on('SIGTERM', () => {});\n` +
  `setInterval(() => {}, 1000);\n`;

/** Launcher: spawns a detached grandchild, records its pid to a file, then
 * hangs itself so it's still alive when the caller's timeout fires. */
const LAUNCHER_BODY =
  `const { spawn } = require('node:child_process');\n` +
  `const fs = require('node:fs');\n` +
  `const grandchildScript = process.argv[2];\n` +
  `const pidFile = process.argv[3];\n` +
  `const gc = spawn(process.execPath, [grandchildScript], { detached: true, stdio: 'ignore' });\n` +
  `fs.writeFileSync(pidFile, String(gc.pid));\n` +
  `gc.unref();\n` +
  `setInterval(() => {}, 1000);\n`;

/** Bootstrap a run + tests_pre stage + archived tdd_manifest artifact, and
 * return the stage_id for runTddCheck({ stage_id, phase: 'pre' }). */
async function bootstrapTddStage(project, testCommand, timeoutMs) {
  const run = await runs.ensureRun({
    request_text: "cli-runner kill-sweep test",
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

// ─── 1. reject:false timeout -> timedOut, real TDD-gate classification ─────

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

// ─── 2. SIGTERM-ignoring child is gone by the deadline ─────────────────────
//
// Platform note: on Windows, `ChildProcess.kill()` resolves ANY non-SIGKILL
// signal to an unconditional `TerminateProcess()` call (Node's own documented
// behavior; see killProcessTree's doc comment in cli-runner.ts) -- there is
// no real ignorable SIGTERM to deliver in the first place, so this scenario
// exercises the POSIX threat model on the platform that can express it (the
// child process below still installs the handler for parity with the POSIX
// code path this module also runs under) while asserting the platform-
// portable contract: the call is classified `timedOut` and the child is
// provably gone by the deadline. Mutation-proof: stripping `timeout` before
// it reaches execa (the P1c regression) makes `result.timedOut` false and
// this test fails on both platforms — see the engineering report.

test("cli-runner: a child that installs a SIGTERM handler and ignores it is still gone by the deadline", async () => {
  const project = makeProject();
  const script = writeScript(project, "ignore-sigterm.js", IGNORE_SIGTERM_BODY);

  const sizeBefore = cliRunner._activeChildrenSize();
  const child = cliRunner.trackedExeca("node", [script], {
    cwd: project,
    timeout: 2_000,
    forceKillAfterDelay: 1_500,
    reject: false,
    windowsHide: true,
  });
  const pid = child.pid;
  const result = await child;

  assert.equal(result.timedOut, true, "execa must report the call as timed out");
  const dead = await waitForDeath(pid, 5_000);
  assert.equal(dead, true, "a SIGTERM-ignoring child must be force-killed, not survive indefinitely");
  assert.equal(cliRunner._activeChildrenSize(), sizeBefore, "ACTIVE_CHILDREN must be empty again after the kill");
});

// ─── 3. Grandchild outliving the direct child is swept ─────────────────────

test("cli-runner: a launcher's grandchild that outlives the direct child is gone after the sweep", async () => {
  const project = makeProject();
  const grandchildScript = writeScript(project, "grandchild.js", HANG_BODY);
  const launcherScript = writeScript(project, "launcher.js", LAUNCHER_BODY);
  const pidFile = join(project, "grandchild.pid");

  const sizeBefore = cliRunner._activeChildrenSize();
  let grandchildPid;
  try {
    const child = cliRunner.trackedExeca("node", [launcherScript, grandchildScript, pidFile], {
      cwd: project,
      timeout: 2_000,
      forceKillAfterDelay: 1_500,
      reject: false,
      windowsHide: true,
    });

    // Wait for the launcher to record the grandchild's pid.
    const pidFileDeadline = Date.now() + 5_000;
    while (!existsSync(pidFile) && Date.now() < pidFileDeadline) {
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.ok(existsSync(pidFile), "launcher must have written the grandchild pid file");
    grandchildPid = Number(readFileSync(pidFile, "utf8").trim());
    assert.ok(Number.isInteger(grandchildPid) && grandchildPid > 0, "grandchild pid must be a positive integer");
    assert.ok(pidAlive(grandchildPid), "grandchild must be alive before the timeout fires");

    const result = await child;
    assert.equal(result.timedOut, true, "the launcher call must be reported as timed out");

    const dead = await waitForDeath(grandchildPid, 5_000);
    assert.equal(dead, true, "the grandchild must be gone after the sweep, not merely the direct launcher pid");
    assert.equal(cliRunner._activeChildrenSize(), sizeBefore, "ACTIVE_CHILDREN must be empty again after the sweep");
  } finally {
    // Defensive cleanup: this must be a no-op if the sweep worked.
    if (grandchildPid && pidAlive(grandchildPid)) {
      cliRunner.killProcessTree(grandchildPid, "SIGKILL");
    }
  }
});
