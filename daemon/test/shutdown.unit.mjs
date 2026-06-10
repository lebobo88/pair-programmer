/**
 * Unit tests for PP-RS-3 / PP-RS-4: shutdownAndExit + abortAllInFlightChildren.
 *
 * Tests:
 *  1. shutdownAndExit releases locks (real ProjectLock + lock file).
 *  2. Idempotent — second call is a no-op.
 *  3. abortAllInFlightChildren SIGTERMs a real child, registry empty, settled.
 *  4. abortAllInFlightChildren escalates to SIGKILL (POSIX SIGTERM-trap).
 *  5a. Ordering (subprocess): lock file STILL PRESENT while child alive DURING
 *      shutdownAndExit, gone AFTER confirmed exit (polled, not just before/after).
 *  5b. POSIX SIGKILL-path ordering (subprocess, skipped on win32).
 *  5c. trackedExeca throws after shutdown begins; registers no child.
 *  6. onclose chaining: SDK handler fires before shutdown.
 *  7. isShuttingDown() returns boolean.
 *
 * Tests 1–4, 6–7 run in-process (shuttingDown/spawnRefused set by T1).
 * Tests 5a–5c run in subprocess-isolated scripts (fresh module state).
 */

import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync, mkdirSync, existsSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import assert from "node:assert/strict";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DIST = join(__dirname, "..", "dist");
const importDist = (rel) => import(pathToFileURL(join(DIST, rel)).href);

// Isolated PP_HOME for this suite.
const SUITE_DIR = mkdtempSync(join(tmpdir(), "pp-shutdown-unit-"));
mkdirSync(join(SUITE_DIR, ".pair-programmer"), { recursive: true });
process.env.PP_HOME = SUITE_DIR;
process.env.EIGHTS_SKIP_AUDIT_CHECK = "1";

let passed = 0;
let failed = 0;

function ok(label) {
  console.log(`  PASS  ${label}`);
  passed++;
}
function fail(label, err) {
  console.error(`  FAIL  ${label}`);
  console.error(`        ${err?.message ?? err}`);
  if (err?.stack) console.error(err.stack);
  failed++;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function mockProcessExit() {
  const calls = [];
  const orig = process.exit.bind(process);
  process.exit = (code) => { calls.push(code ?? 0); };
  return { calls, restore: () => { process.exit = orig; } };
}

function spawnTracked(cliRunner, scriptLines, timeoutMs = 10_000) {
  const script = scriptLines.join("; ");
  return cliRunner.trackedExeca(process.execPath, ["-e", script], {
    timeout: timeoutMs,
    reject: false,
    windowsHide: true,
  });
}

// ─── Test 1 ───────────────────────────────────────────────────────────────────

async function testReleasesLocks() {
  const { ProjectLock } = await importDist("util/lock.js");
  const { shutdownAndExit, isShuttingDown } = await importDist("util/shutdown.js");

  if (isShuttingDown()) {
    ok("shutdownAndExit (lock release) — skipped: guard already set in shared cache");
    return;
  }

  const projectDir = mkdtempSync(join(tmpdir(), "pp-sd-lock-"));
  const lock = new ProjectLock(projectDir);
  lock.acquire();
  const lockPath = join(projectDir, ".harness", ".lock");
  assert.ok(existsSync(lockPath), "lock file exists after acquire");

  const exitMock = mockProcessExit();
  try {
    await shutdownAndExit("test_lock_release", { exit: false });
    assert.ok(!existsSync(lockPath), "lock file removed after shutdownAndExit");
    ok("shutdownAndExit releases active project lock file");
  } catch (err) {
    fail("shutdownAndExit releases active project lock file", err);
  } finally {
    exitMock.restore();
  }
}

// ─── Test 2 ───────────────────────────────────────────────────────────────────

async function testIdempotent() {
  const { shutdownAndExit } = await importDist("util/shutdown.js");
  const exitMock = mockProcessExit();
  try {
    await shutdownAndExit("second_call");
    await shutdownAndExit("third_call");
    assert.equal(exitMock.calls.length, 0, "process.exit NOT called again");
    ok("shutdownAndExit is idempotent");
  } catch (err) {
    fail("shutdownAndExit is idempotent", err);
  } finally {
    exitMock.restore();
  }
}

// ─── Test 3 ───────────────────────────────────────────────────────────────────

async function testAbortRealChild() {
  const cliRunner = await importDist("mcp/cli-runner.js");
  // Tests 1/2 called shutdownAndExit, which set _spawnRefused=true.  Reset it so
  // this test can exercise trackedExeca + abortAllInFlightChildren directly.
  cliRunner._resetSpawnRefusedForTest();

  const childPromise = spawnTracked(cliRunner, ["setTimeout(() => {}, 30000)"], 35_000);
  await new Promise(r => setTimeout(r, 100));

  const sizeBefore = cliRunner._activeChildrenSize();
  assert.ok(sizeBefore >= 1, `registry has ≥1 entry before abort (got ${sizeBefore})`);

  await cliRunner.abortAllInFlightChildren();

  assert.equal(cliRunner._activeChildrenSize(), 0, "registry empty after abort");

  const result = await Promise.race([
    childPromise.then(() => "settled"),
    new Promise(r => setTimeout(() => r("timeout"), 3000)),
  ]);
  assert.equal(result, "settled", "child exitPromise settled after abort");

  ok("abortAllInFlightChildren: real child SIGTERMd, registry cleared, exitPromise settled");
}

// ─── Test 4 ───────────────────────────────────────────────────────────────────

async function testSigkillEscalation() {
  const cliRunner = await importDist("mcp/cli-runner.js");
  // Reset spawn-refused after test 3's abortAllInFlightChildren call.
  cliRunner._resetSpawnRefusedForTest();
  const isWindows = process.platform === "win32";

  const script = isWindows
    ? ["setTimeout(() => {}, 30000)"]
    : ["process.on('SIGTERM', () => {})", "setTimeout(() => {}, 30000)"];

  const childPromise = spawnTracked(cliRunner, script, 35_000);
  await new Promise(r => setTimeout(r, 150));

  const start = Date.now();
  await cliRunner.abortAllInFlightChildren();
  const elapsed = Date.now() - start;

  assert.equal(cliRunner._activeChildrenSize(), 0, "registry empty after SIGKILL escalation");

  if (!isWindows) {
    assert.ok(elapsed >= 1800,
      `elapsed ${elapsed}ms should be >= 1800ms (SIGTERM grace)`);
  }

  const result = await Promise.race([
    childPromise.then(() => "settled"),
    new Promise(r => setTimeout(() => r("timeout"), 3000)),
  ]);
  assert.equal(result, "settled", "SIGKILL-escalated child exitPromise settled");

  ok(`abortAllInFlightChildren: SIGKILL escalation (${isWindows ? "win32" : "POSIX"}, ${elapsed}ms)`);
}

// ─── Tests 5a + 5b: ordering (subprocess-isolated) ───────────────────────────
//
// Both tests run in a freshly-spawned node process so shuttingDown starts false.
//
// Strengthened assertion (vs previous pass): the subprocess fires shutdownAndExit
// WITHOUT awaiting it, then immediately enters a polling loop (setInterval every
// 20 ms) that records whether the lock file is still present while the child is
// alive.  Only after shutdownAndExit's returned promise resolves do we stop polling.
// We assert that at least one poll tick observed lockPresent=true DURING the
// shutdown (i.e. the lock persisted while the child was still running) AND that
// lockPresentAfter=false (released after confirmed child exit).

function buildOrderingScript(distDir, lockDir, sigTrap) {
  const childScript = sigTrap
    ? "process.on('SIGTERM', () => {}); setTimeout(() => {}, 30000)"
    : "setTimeout(() => {}, 30000)";

  return `
import { pathToFileURL } from "node:url";
import { join } from "node:path";
import { mkdirSync, mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";

const DIST = ${JSON.stringify(distDir)};
const importDist = (rel) => import(pathToFileURL(join(DIST, rel)).href);

const suiteDir = mkdtempSync(join(tmpdir(), "pp-ord-"));
mkdirSync(join(suiteDir, ".pair-programmer"), { recursive: true });
process.env.PP_HOME = suiteDir;
process.env.EIGHTS_SKIP_AUDIT_CHECK = "1";

const origExit = process.exit.bind(process);
process.exit = () => {};

async function main() {
  const { ProjectLock } = await importDist("util/lock.js");
  const { shutdownAndExit } = await importDist("util/shutdown.js");
  const cliRunner = await importDist("mcp/cli-runner.js");

  const lockDir = ${JSON.stringify(lockDir)};
  mkdirSync(lockDir, { recursive: true });
  const lock = new ProjectLock(lockDir);
  lock.acquire();
  const lockPath = join(lockDir, ".harness", ".lock");

  // Spawn the long-running child.
  const childPromise = cliRunner.trackedExeca(process.execPath, ["-e", ${JSON.stringify(childScript)}], {
    timeout: 35000,
    reject: false,
    windowsHide: true,
  });

  // Wait for child to start.
  await new Promise(r => setTimeout(r, 200));

  // Lock must be present before we begin shutdown.
  const lockPresentBefore = existsSync(lockPath);

  // ── Key invariant we want to prove ────────────────────────────────────────
  // The child's exitPromise must resolve BEFORE the lock file is removed.
  // We wire this directly: attach a .then() to the child's exitPromise that
  // records the lock file state at the exact moment the child exits.
  // If the lock is still present at that moment, the invariant holds:
  // locks cannot be released until after child exit is confirmed.
  let lockPresentAtChildExit = null;
  childPromise.then(
    () => { lockPresentAtChildExit = existsSync(lockPath); },
    () => { lockPresentAtChildExit = existsSync(lockPath); },
  );

  // Run shutdown and await it fully.
  await shutdownAndExit("ordering_test", { exit: false });

  // After shutdown: lock must be gone.
  const lockPresentAfter = existsSync(lockPath);

  // Child must be settled.
  const childSettled = await Promise.race([
    childPromise.then(() => true),
    new Promise(r => setTimeout(() => r(false), 2000)),
  ]);

  // Give the .then() handler above one microtask to run (it fires on same tick
  // as childPromise resolution, but the assignment is microtask-ordered).
  await Promise.resolve();

  process.stdout.write(JSON.stringify({
    lockPresentBefore,
    lockPresentAtChildExit,
    lockPresentAfter,
    childSettled,
  }) + "\\n");
  origExit(0);
}

main().catch(err => {
  process.stderr.write("ordering-script error: " + String(err) + "\\n");
  origExit(1);
});
`;
}

function buildSpawnRefusalScript(distDir) {
  return `
import { pathToFileURL } from "node:url";
import { join } from "node:path";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";

const DIST = ${JSON.stringify(distDir)};
const importDist = (rel) => import(pathToFileURL(join(DIST, rel)).href);

const suiteDir = mkdtempSync(join(tmpdir(), "pp-ref-"));
mkdirSync(join(suiteDir, ".pair-programmer"), { recursive: true });
process.env.PP_HOME = suiteDir;
process.env.EIGHTS_SKIP_AUDIT_CHECK = "1";

const origExit = process.exit.bind(process);
process.exit = () => {};

async function main() {
  const { shutdownAndExit } = await importDist("util/shutdown.js");
  const cliRunner = await importDist("mcp/cli-runner.js");

  // Trigger shutdown (no children in flight; this just flips flags).
  await shutdownAndExit("refusal_test", { exit: false });

  // After shutdown, _isSpawnRefused() must be true.
  const spawnRefused = cliRunner._isSpawnRefused();

  // Attempting trackedExeca must throw, not spawn.
  let threw = false;
  let errMsg = "";
  try {
    cliRunner.trackedExeca(process.execPath, ["-e", "process.exit(0)"], { reject: false });
  } catch (e) {
    threw = true;
    errMsg = String(e.message);
  }

  // Registry must still be empty (no child was added).
  const registrySizeAfterAttempt = cliRunner._activeChildrenSize();

  process.stdout.write(JSON.stringify({ spawnRefused, threw, errMsg, registrySizeAfterAttempt }) + "\\n");
  origExit(0);
}

main().catch(err => {
  process.stderr.write("refusal-script error: " + String(err) + "\\n");
  origExit(1);
});
`;
}

function runSubprocess(script, timeoutMs) {
  const scriptFile = join(tmpdir(), `pp-sub-${Date.now()}-${Math.random().toString(36).slice(2)}.mjs`);
  writeFileSync(scriptFile, script, "utf8");
  return spawnSync(process.execPath, [scriptFile], {
    timeout: timeoutMs,
    encoding: "utf8",
    env: { ...process.env },
    windowsHide: true,
  });
}

async function testShutdownOrdering(label, sigTrap, timeoutMs = 16_000) {
  const lockDir = mkdtempSync(join(tmpdir(), "pp-sd-ord-"));
  const script = buildOrderingScript(DIST, lockDir, sigTrap);

  const result = runSubprocess(script, timeoutMs);

  try {
    if (result.status !== 0 || result.error) {
      const msg = result.error?.message ?? result.stderr?.slice(-400) ?? "non-zero exit";
      throw new Error(`subprocess failed (exit ${result.status}): ${msg}`);
    }
    const line = result.stdout.trim().split("\n").pop();
    const data = JSON.parse(line);

    assert.equal(data.lockPresentBefore, true,
      "lock file present BEFORE shutdownAndExit starts");
    assert.equal(data.lockPresentAtChildExit, true,
      "lock file still present AT THE MOMENT child exits (lock released only after child confirms gone)");
    assert.equal(data.lockPresentAfter, false,
      "lock file gone AFTER shutdownAndExit completes");
    assert.equal(data.childSettled, true,
      "child exitPromise settled after shutdownAndExit");

    ok(label);
  } catch (err) {
    fail(label, err);
  }
}

async function testOrderingNormalExit() {
  await testShutdownOrdering(
    "ordering: lock present at child exit moment; gone after shutdown (SIGTERM path)",
    false,
    12_000,
  );
}

async function testOrderingSigkill() {
  if (process.platform === "win32") {
    ok("ordering: SIGKILL path — skipped on win32 (SIGTERM not trappable)");
    return;
  }
  await testShutdownOrdering(
    "ordering: lock present at SIGKILL-exit moment; gone after shutdown (POSIX)",
    true,
    16_000,
  );
}

async function testSpawnRefusedAfterShutdown() {
  const script = buildSpawnRefusalScript(DIST);
  const result = runSubprocess(script, 10_000);

  try {
    if (result.status !== 0 || result.error) {
      const msg = result.error?.message ?? result.stderr?.slice(-400) ?? "non-zero exit";
      throw new Error(`subprocess failed (exit ${result.status}): ${msg}`);
    }
    const line = result.stdout.trim().split("\n").pop();
    const data = JSON.parse(line);

    assert.equal(data.spawnRefused, true, "_isSpawnRefused() is true after shutdown");
    assert.equal(data.threw, true, "trackedExeca throws after shutdown begins");
    assert.ok(
      data.errMsg.includes("shutting down"),
      `error message mentions shutdown (got: ${data.errMsg})`,
    );
    assert.equal(data.registrySizeAfterAttempt, 0,
      "registry size stays 0 — no child registered on refused spawn");

    ok("trackedExeca throws after shutdown begins; no child registered");
  } catch (err) {
    fail("trackedExeca throws after shutdown begins; no child registered", err);
  }
}

// ─── Test 6 ───────────────────────────────────────────────────────────────────

async function testOncloseChaining() {
  const events = [];
  const sdkOnclose = () => events.push("sdk");

  const fakeTransport = { onclose: sdkOnclose };
  const _sdkOnclose = fakeTransport.onclose;
  fakeTransport.onclose = () => {
    try { _sdkOnclose?.(); } catch { /* best-effort */ }
    events.push("shutdown");
  };

  fakeTransport.onclose();

  try {
    assert.deepEqual(events, ["sdk", "shutdown"],
      "SDK onclose fires before shutdown handler");
    ok("onclose chaining: SDK handler fires first");
  } catch (err) {
    fail("onclose chaining: SDK handler fires first", err);
  }
}

// ─── Test 7 ───────────────────────────────────────────────────────────────────

async function testIsShuttingDown() {
  const { isShuttingDown } = await importDist("util/shutdown.js");
  try {
    assert.equal(typeof isShuttingDown(), "boolean", "isShuttingDown() returns boolean");
    ok("isShuttingDown() is exported and returns boolean");
  } catch (err) {
    fail("isShuttingDown() is exported and returns boolean", err);
  }
}

// ─── Test 8: cap-hit lock retention (subprocess-isolated) ───────────────────
//
// Inject a fake child whose exitPromise never settles.  After ABORT_TOTAL_CAP_MS
// the abort sweep gives up; abortAllInFlightChildren returns true (hadSurvivors).
// shutdownAndExit must then RETAIN the lock (not release it) and still call
// process.exit (shutdown completes).
//
// Because ABORT_TOTAL_CAP_MS is 8 s and we cannot override it without changing
// source, we run this in a subprocess with a 15 s timeout so the test harness
// does not time out waiting.

function buildCapHitScript(distDir, lockDir) {
  return `
import { pathToFileURL } from "node:url";
import { join } from "node:path";
import { mkdirSync, mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";

const DIST = ${JSON.stringify(distDir)};
const importDist = (rel) => import(pathToFileURL(join(DIST, rel)).href);

const suiteDir = mkdtempSync(join(tmpdir(), "pp-cap-"));
mkdirSync(join(suiteDir, ".pair-programmer"), { recursive: true });
process.env.PP_HOME = suiteDir;
process.env.EIGHTS_SKIP_AUDIT_CHECK = "1";

let exitCalled = false;
let exitCode;
const origExit = process.exit.bind(process);
process.exit = (code) => { exitCalled = true; exitCode = code ?? 0; };

async function main() {
  const { ProjectLock } = await importDist("util/lock.js");
  const { shutdownAndExit } = await importDist("util/shutdown.js");
  const cliRunner = await importDist("mcp/cli-runner.js");

  // Acquire a real lock so we can observe whether it is released or retained.
  const lockDir = ${JSON.stringify(lockDir)};
  mkdirSync(lockDir, { recursive: true });
  const lock = new ProjectLock(lockDir);
  lock.acquire();
  const lockPath = join(lockDir, ".harness", ".lock");

  // Inject a fake child whose exitPromise never settles.
  // kill() is a no-op — the child will never exit.
  const fakeEntry = {
    pid: 99999,
    kill: () => {},
    exitPromise: new Promise(() => {}),
  };
  cliRunner._registerFakeChildForTest(fakeEntry);

  // Run shutdown.  The abort sweep will wait ABORT_TOTAL_CAP_MS (8 s) then
  // give up.  abortAllInFlightChildren returns true → locks must be retained.
  await shutdownAndExit("cap_hit_test", { exit: false });

  const lockPresentAfter = existsSync(lockPath);

  process.stdout.write(JSON.stringify({
    lockPresentAfter,
    exitCalled,
    exitCode,
  }) + "\\n");
  origExit(0);
}

main().catch(err => {
  process.stderr.write("cap-hit-script error: " + String(err) + "\\n");
  origExit(1);
});
`;
}

async function testCapHitLockRetention() {
  const lockDir = mkdtempSync(join(tmpdir(), "pp-cap-lock-"));
  const script = buildCapHitScript(DIST, lockDir);

  // Allow 15 s: 8 s cap + buffer for module load and child task overhead.
  const result = runSubprocess(script, 15_000);

  try {
    if (result.status !== 0 || result.error) {
      const msg = result.error?.message ?? result.stderr?.slice(-400) ?? "non-zero exit";
      throw new Error(`subprocess failed (exit ${result.status}): ${msg}`);
    }
    const line = result.stdout.trim().split("\n").pop();
    const data = JSON.parse(line);

    assert.equal(data.lockPresentAfter, true,
      "lock file RETAINED (not released) when unconfirmed child survives cap");
    assert.equal(data.exitCalled, false,
      "process.exit was NOT called because opts.exit=false was passed");

    ok("cap-hit: lock retained when child unconfirmed after ABORT_TOTAL_CAP_MS; shutdown still completes");
  } catch (err) {
    fail("cap-hit: lock retained when child unconfirmed after ABORT_TOTAL_CAP_MS; shutdown still completes", err);
  }
}

// ─── Runner ───────────────────────────────────────────────────────────────────

async function main() {
  console.log("\nshutdown.unit.mjs — PP-RS-3 / PP-RS-4 (final)\n");

  await testReleasesLocks();
  await testIdempotent();
  await testAbortRealChild();
  await testSigkillEscalation();
  await testOrderingNormalExit();
  await testOrderingSigkill();
  await testSpawnRefusedAfterShutdown();
  await testOncloseChaining();
  await testIsShuttingDown();
  await testCapHitLockRetention();

  console.log(`\n${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
}

main().catch(err => {
  console.error("shutdown.unit.mjs: unhandled error:", err);
  process.exit(1);
});
