// Unit tests for doctor's bounded, concurrent CLI-version and agy-pin probes.
//
// Context: `agy --version` measured at 127s cold on some machines, which
// blows past the MCP client's fixed 60s per-request timeout and fails every
// stage smoke run regardless of the change under test. Fix: run the five
// version probes (codex, agy, claude, git, node) CONCURRENTLY via
// captureCliVersions(), each bounded by PP_DOCTOR_PROBE_TIMEOUT_MS (default
// 15000ms); bound checkAgyPinServed via checkAgyPinServedBounded() with its
// own PP_DOCTOR_PIN_TIMEOUT_MS (default 20000ms), degrading open on timeout.
//
// Seams used (injected rather than spawning real CLIs):
//   - captureCliVersions(probe, timeoutMs) — probe is a CliVersionProbe;
//     tests substitute fakes that hang or resolve after a controlled delay.
//   - checkAgyPinServedBounded(pins, timeoutMs, checkFn) — checkFn is an
//     AgyPinCheckFn; tests substitute a fake that never resolves.
//
// Runs against the compiled dist/.

import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import test from "node:test";
import assert from "node:assert/strict";

const SUITE_DIR = mkdtempSync(join(tmpdir(), "pp-doctor-probe-timeout-"));
mkdirSync(join(SUITE_DIR, ".pair-programmer"), { recursive: true });
process.env.PP_HOME = SUITE_DIR;

const __dirname = dirname(fileURLToPath(import.meta.url));
const DIST = join(__dirname, "..", "dist");
const importDist = (relPath) => import(pathToFileURL(join(DIST, relPath)).href);

const { captureCliVersions, checkAgyPinServedBounded, doctor } = await importDist("orchestrator/runs.js");
const { defaultAgyPins, checkAgyPinServed } = await importDist("orchestrator/agy-pin.js");
const { doctorProbeTimeoutMs, doctorPinTimeoutMs } = await importDist("config.js");

/** Never resolves — simulates a hung CLI child process. */
function hangingProbe() {
  return new Promise(() => {});
}

/** Resolves after `delayMs` with a fixed fake version string. */
function delayedProbe(delayMs, value = "1.0.0") {
  return (_cmd, _args, _timeoutMs) =>
    new Promise((resolve) => setTimeout(() => resolve(value), delayMs));
}

/** Never resolves — simulates a hung `agy models` call. */
function hangingPinCheck() {
  return new Promise(() => {});
}

// ─── version-probe timeout ──────────────────────────────────────────────────

test("captureCliVersions: a probe that never resolves within its budget -> null version, name in cli_probe_timeouts", async () => {
  const { versions, timeouts } = await captureCliVersions(hangingProbe, 100);
  for (const cli of ["codex", "agy", "claude", "git", "node"]) {
    assert.equal(versions[cli], null, `${cli} must be null when its probe times out`);
  }
  assert.deepEqual(
    [...timeouts].sort(),
    ["agy", "claude", "codex", "git", "node"],
    "every CLI whose probe hung past the budget must be named in cli_probe_timeouts",
  );
});

test("captureCliVersions: a null version from a timeout is distinguishable from a genuinely-failed probe", async () => {
  // A probe that resolves null quickly (CLI absent) must NOT appear in
  // cli_probe_timeouts — only genuine timeouts do.
  const fastFailProbe = async () => null;
  const { versions, timeouts } = await captureCliVersions(fastFailProbe, 5000);
  for (const cli of ["codex", "agy", "claude", "git", "node"]) {
    assert.equal(versions[cli], null);
  }
  assert.deepEqual(timeouts, [], "a fast-failing probe (missing CLI) is not a timeout");
});

// ─── version-probe concurrency ──────────────────────────────────────────────

test("captureCliVersions: five probes run concurrently, not sequentially", async () => {
  const DELAY_MS = 200;
  const start = Date.now();
  const { versions } = await captureCliVersions(delayedProbe(DELAY_MS), 5000);
  const elapsed = Date.now() - start;
  for (const cli of ["codex", "agy", "claude", "git", "node"]) {
    assert.equal(versions[cli], "1.0.0");
  }
  // Sequential would take ~5 * DELAY_MS = 1000ms; concurrent takes ~DELAY_MS.
  // Assert well under 2x a single delay, per the required proof.
  assert.ok(
    elapsed < DELAY_MS * 2,
    `expected concurrent probes to finish in well under ${DELAY_MS * 2}ms, took ${elapsed}ms`,
  );
});

test("captureCliVersions: fast probes leave every existing field unchanged", async () => {
  const { versions, timeouts } = await captureCliVersions(delayedProbe(10, "9.9.9"), 5000);
  assert.deepEqual(Object.keys(versions).sort(), ["agy", "claude", "codex", "git", "node"]);
  for (const cli of Object.keys(versions)) assert.equal(versions[cli], "9.9.9");
  assert.deepEqual(timeouts, []);
});

// ─── agy pin-check timeout ───────────────────────────────────────────────────

test("checkAgyPinServedBounded: a pin check that exceeds its budget -> degraded-open shape with a note, still returns", async () => {
  const pins = defaultAgyPins();
  const result = await checkAgyPinServedBounded(pins, 100, hangingPinCheck);
  assert.equal(result.agy_pin_served, null, "timeout must degrade open, never fail closed (false)");
  assert.equal(result.pinned_model, pins.critique_default);
  assert.deepEqual(result.pinned_models, pins);
  assert.deepEqual(
    result.per_pin,
    Object.fromEntries(Object.keys(pins).map((k) => [k, null])),
  );
  assert.equal(result.served_models, null);
  assert.deepEqual(result.unserved_allowlist, []);
  assert.match(result.note, /time budget/);
  assert.match(result.note, /100ms/);
});

test("checkAgyPinServedBounded: a fast check resolves normally and is returned as-is", async () => {
  const pins = defaultAgyPins();
  const fakeResult = {
    agy_pin_served: true,
    pinned_model: pins.critique_default,
    pinned_models: pins,
    per_pin: Object.fromEntries(Object.keys(pins).map((k) => [k, true])),
    served_models: Object.values(pins),
    unserved_allowlist: [],
    note: null,
  };
  const fastCheck = async () => fakeResult;
  const result = await checkAgyPinServedBounded(pins, 5000, fastCheck);
  assert.deepEqual(result, fakeResult);
});

// ─── budget threading: the pin-check budget must reach the real child (gpt-5.6-terra #1) ──
//
// Earlier code raced a Promise that resolved after PP_DOCTOR_PIN_TIMEOUT_MS
// against checkAgyPinServed(pins) with NO arguments, so the real `agy models`
// child was always spawned with the fixed AGY_MODELS_TIMEOUT_MS (15s)
// regardless of the caller's configured budget. checkAgyPinServedBounded must
// now call checkFn(pins, timeoutMs) — i.e. forward the SAME budget that
// bounds its own race — so a real checkFn can thread it into the subprocess's
// kill deadline.

test("checkAgyPinServedBounded: forwards timeoutMs to checkFn as its second argument", async () => {
  const pins = defaultAgyPins();
  let receivedTimeout;
  const spyCheck = async (_pins, timeoutMs) => {
    receivedTimeout = timeoutMs;
    return {
      agy_pin_served: true, pinned_model: pins.critique_default, pinned_models: pins,
      per_pin: {}, served_models: [], unserved_allowlist: [], note: null,
    };
  };
  await checkAgyPinServedBounded(pins, 4242, spyCheck);
  assert.equal(
    receivedTimeout, 4242,
    "checkAgyPinServedBounded must forward its own timeoutMs to checkFn so a real " +
      "implementation can bound its subprocess by the SAME budget",
  );
});

// ─── checkAgyPinServed: the configured budget reaches the exec seam, not a fixed constant ──

test("checkAgyPinServed: threads timeoutMs into the exec seam instead of a fixed constant", async () => {
  const pins = defaultAgyPins();
  let receivedTimeout;
  const spyExec = async (timeoutMs) => {
    receivedTimeout = timeoutMs;
    return { stdout: `${pins.critique_default}\tLabel\n` };
  };
  await checkAgyPinServed(pins, 777, spyExec);
  assert.equal(
    receivedTimeout, 777,
    "checkAgyPinServed must pass its timeoutMs argument straight into the exec seam " +
      "(and, in production, into execa's own `timeout` option) rather than always using " +
      "the fixed AGY_MODELS_TIMEOUT_MS default",
  );
});

// ─── real child: the exec seam's default must actually terminate a real process (gpt-5.6-terra #5) ──
//
// Proves execa's `timeout` option (which the production exec seam wires
// through) really kills the OS process at the configured deadline, not just
// that the JS Promise settles. Spawns a real node child that would otherwise
// run for 60s, bounds it to a small budget via the SAME code path
// (trackedExeca's timeout option), and asserts the pid is gone shortly after
// the deadline via a liveness probe (process.kill(pid, 0) throws ESRCH once
// the OS process is dead).

test("real child: a hung node subprocess bounded by a small execa timeout is actually killed (not just abandoned)", async () => {
  const { trackedExeca } = await importDist("mcp/cli-runner.js");
  const BUDGET_MS = 300;
  const child = trackedExeca("node", ["-e", "setTimeout(() => {}, 60000)"], {
    windowsHide: true,
    timeout: BUDGET_MS,
  });
  const pid = child.pid;
  assert.ok(pid, "child must have a pid to prove liveness against");

  let threw = false;
  try {
    await child;
  } catch {
    threw = true; // execa rejects when it kills the child on timeout
  }
  assert.ok(threw, "a timed-out execa call must reject, not resolve as if it succeeded");

  // Give the OS a brief grace window to reap the killed process, then assert
  // it is genuinely gone -- not merely detached/orphaned and still running.
  const deadline = Date.now() + 5000;
  let alive = true;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0); // no signal sent; throws if the pid doesn't exist
      await new Promise((r) => setTimeout(r, 50));
    } catch {
      alive = false;
      break;
    }
  }
  assert.equal(alive, false, `pid ${pid} must be terminated well after the ${BUDGET_MS}ms execa timeout, not left running`);
});

// ─── P1b (gpt-5.6-terra revise pass): a `.cmd`/script LAUNCHER's grandchild must die too ──
//
// The "real child" test above spawns node DIRECTLY, so trackedExeca's tracked
// pid IS the process doing the sleeping — killing that one pid is enough to
// pass, and cannot distinguish a correct process-TREE kill from the old
// "kill only the direct pid" behaviour. This test spawns a shim launcher
// (a `.cmd` on Windows, a shell script on POSIX) that runs a SECOND node
// process (the "grandchild") in the foreground, so the launcher's own
// tracked pid blocks on it exactly like a real vendor CLI's npm `.cmd` shim
// blocks on the underlying node binary. Reverting the process-tree kill (so
// only the launcher's direct pid is signalled) leaves the grandchild running
// indefinitely — this test would then fail (alive === true) after the poll
// window, proving the tree-kill is load-bearing.

test("killProcessTree (via trackedExeca's timeout): a .cmd/script launcher's grandchild is also terminated, not orphaned", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pp-killtree-"));
  const pidFile = join(dir, "grandchild.pid");
  const sleeperPath = join(dir, "sleeper.js");
  writeFileSync(
    sleeperPath,
    `const fs = require("fs");\n` +
    `fs.writeFileSync(process.argv[2], String(process.pid));\n` +
    `setTimeout(() => {}, 60000);\n`,
    "utf8",
  );

  let shimPath;
  if (process.platform === "win32") {
    shimPath = join(dir, "shim.cmd");
    // Foreground (not `start /B`): cmd.exe BLOCKS on the node grandchild, so
    // cmd.exe's own pid stays alive for the whole sleep, exactly like a real
    // `.cmd`-shimmed vendor CLI blocking on its underlying node process.
    writeFileSync(shimPath, `@echo off\r\nnode "${sleeperPath}" "${pidFile}"\r\n`, "utf8");
  } else {
    shimPath = join(dir, "shim.sh");
    writeFileSync(shimPath, `#!/bin/sh\nnode "${sleeperPath}" "${pidFile}"\n`, { encoding: "utf8", mode: 0o755 });
  }

  const { trackedExeca, killProcessTree } = await importDist("mcp/cli-runner.js");
  const BUDGET_MS = 400;
  let grandchildPid;
  try {
    const child = trackedExeca(shimPath, [], { windowsHide: true, timeout: BUDGET_MS });

    let threw = false;
    try { await child; } catch { threw = true; }
    assert.ok(threw, "the timed-out launcher must reject");

    // The grandchild writes its own pid as soon as it starts; poll briefly
    // for the pidfile in case it lands slightly after spawn.
    const pidWriteDeadline = Date.now() + 5000;
    while (Date.now() < pidWriteDeadline) {
      try {
        const parsed = parseInt(readFileSync(pidFile, "utf8").trim(), 10);
        if (Number.isFinite(parsed)) { grandchildPid = parsed; break; }
      } catch { /* not written yet */ }
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.ok(Number.isFinite(grandchildPid), "the grandchild must have written its own pid before the launcher was killed");

    // Poll briefly, then assert the grandchild is genuinely gone — this is
    // exactly the P1b leak: killing only the launcher's pid leaves this
    // process running indefinitely.
    const deadline = Date.now() + 5000;
    let alive = true;
    while (Date.now() < deadline) {
      try {
        process.kill(grandchildPid, 0); // no signal sent; throws if pid is gone
        await new Promise((r) => setTimeout(r, 50));
      } catch {
        alive = false;
        break;
      }
    }
    assert.equal(alive, false, `grandchild pid ${grandchildPid} must be terminated by the process-tree kill, not left orphaned`);
  } finally {
    // Defense-in-depth: if the assertion above failed (tree-kill regressed),
    // don't leave the grandchild running past this test file.
    if (Number.isFinite(grandchildPid)) {
      try { process.kill(grandchildPid, 0); killProcessTree(grandchildPid, "SIGKILL"); } catch { /* already gone */ }
    }
    rmSync(dir, { recursive: true, force: true });
  }
});

// ─── doctor-payload composition: cli_probe_timeouts + duration_ms surface end-to-end ──
//
// doctor() itself normally spawns 5 real CLIs plus a real `agy models` call,
// which is why other doctor tests avoid calling it directly (see
// doctor-pin-freshness.unit.mjs's convention). doctor() now accepts
// test-only injectable seams (cliVersionProbe/cliVersionTimeoutMs/
// agyPinCheckFn/agyPinTimeoutMs) specifically so this can drive the REAL
// doctor() function end-to-end instead of hand-assembling a stand-in payload
// object — a hand-assembled payload would still pass if doctor() itself
// stopped returning cli_probe_timeouts or duration_ms; calling the real
// function does not.

test("doctor(): cli_probe_timeouts and duration_ms both appear in doctor()'s OWN returned result", async () => {
  const fastFailProbe = async () => null; // every version probe "fails fast" (not a timeout)
  const hangingPinCheck = () => new Promise(() => {}); // never resolves -> exercises the pin-check race
  const report = await doctor({
    cliVersionProbe: fastFailProbe,
    cliVersionTimeoutMs: 50,
    agyPinCheckFn: hangingPinCheck,
    agyPinTimeoutMs: 50,
  });

  assert.ok(Array.isArray(report.cli_probe_timeouts), "doctor() must return cli_probe_timeouts as an array");
  assert.equal(report.agy_pin_check.agy_pin_served, null, "a hung pin check must degrade open, not fail closed");
  assert.ok(
    typeof report.duration_ms === "number" && report.duration_ms >= 0,
    "doctor() must return a non-negative duration_ms",
  );
});

// ─── finding 1: a timed-out agy VERSION probe must not discard an already-computed pin result ──
//
// gpt-5.6-terra LOGIC BUG: doctor() chose between the bounded pin result and
// the literal "agy CLI not installed" shape by testing `cliVersions.agy !==
// null`. A TIMED-OUT agy version probe deliberately resolves to null, so
// doctor threw away the bounded pin result it had already computed
// CONCURRENTLY and reported the CLI as absent outright. Fix: consult
// cli_probe_timeouts to tell "absent" apart from "timed out"; on a timeout,
// keep the bounded pin result exactly as computed and name the version-probe
// budget in the note instead of claiming the CLI is missing.

test("doctor(): agy version probe times out while the pin check independently resolves -> pin result preserved, CLI not reported absent", async () => {
  const versionProbe = (cmd) => (cmd === "agy" ? new Promise(() => {}) : Promise.resolve("1.0.0"));
  const fakePinResult = {
    agy_pin_served: true,
    pinned_model: "gemini-fake-pin",
    pinned_models: { critique_default: "gemini-fake-pin" },
    per_pin: { critique_default: true },
    served_models: ["gemini-fake-pin"],
    unserved_allowlist: [],
    note: null,
  };
  const fastPinCheck = async () => fakePinResult;

  const report = await doctor({
    cliVersionProbe: versionProbe,
    cliVersionTimeoutMs: 100,
    agyPinCheckFn: fastPinCheck,
    agyPinTimeoutMs: 5000,
  });

  assert.equal(report.cli_versions.agy, null, "sanity: the agy --version probe must have timed out to null");
  assert.ok(report.cli_probe_timeouts.includes("agy"), "sanity: agy must be named in cli_probe_timeouts");

  assert.equal(
    report.agy_pin_check.agy_pin_served,
    true,
    "the bounded pin result already computed concurrently must be preserved, not discarded",
  );
  assert.deepEqual(
    report.agy_pin_check.pinned_models,
    fakePinResult.pinned_models,
    "the pin result's own fields must survive unchanged",
  );
  assert.equal(report.agy_pin_served, true);
  assert.match(
    report.agy_pin_check.note ?? "",
    /PP_DOCTOR_PROBE_TIMEOUT_MS|time budget|version probe/i,
    "the note must explain the VERSION probe exceeded its budget",
  );
  assert.doesNotMatch(
    report.agy_pin_check.note ?? "",
    /not installed/i,
    "a version-probe timeout must not be reported as the CLI being absent",
  );
});

test("doctor(): agy genuinely absent (fast-failing version probe, no timeout) still reports the 'not installed' shape even when the concurrent pin check succeeds", async () => {
  const fastFailProbe = async () => null; // resolves quickly to null -> genuinely absent, not a timeout
  const fakePinResult = {
    agy_pin_served: true,
    pinned_model: "gemini-fake-pin",
    pinned_models: { critique_default: "gemini-fake-pin" },
    per_pin: { critique_default: true },
    served_models: ["gemini-fake-pin"],
    unserved_allowlist: [],
    note: null,
  };
  const report = await doctor({
    cliVersionProbe: fastFailProbe,
    cliVersionTimeoutMs: 5000,
    agyPinCheckFn: async () => fakePinResult,
    agyPinTimeoutMs: 5000,
  });
  assert.equal(report.cli_versions.agy, null);
  assert.ok(!report.cli_probe_timeouts.includes("agy"), "sanity: a fast null resolution is not a timeout");
  assert.equal(report.agy_pin_check.agy_pin_served, null, "genuinely absent must still report the 'not installed' shape");
  assert.match(report.agy_pin_check.note ?? "", /not installed/i);
});
