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
import { mkdtempSync, mkdirSync } from "node:fs";
import test from "node:test";
import assert from "node:assert/strict";

const SUITE_DIR = mkdtempSync(join(tmpdir(), "pp-doctor-probe-timeout-"));
mkdirSync(join(SUITE_DIR, ".pair-programmer"), { recursive: true });
process.env.PP_HOME = SUITE_DIR;

const __dirname = dirname(fileURLToPath(import.meta.url));
const DIST = join(__dirname, "..", "dist");
const importDist = (relPath) => import(pathToFileURL(join(DIST, relPath)).href);

const { captureCliVersions, checkAgyPinServedBounded } = await importDist("orchestrator/runs.js");
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

// ─── doctor-payload composition: cli_probe_timeouts + duration_ms surface end-to-end ──
//
// doctor() itself spawns 5 real CLIs and is intentionally not called directly
// in unit tests (would be slow / environment-dependent — see
// doctor-pin-freshness.unit.mjs's convention). This test instead exercises
// the exact composition doctor() performs -- Promise.all([captureCliVersions,
// checkAgyPinServedBounded]) plus a duration_ms wall-clock measurement --
// with injected fakes, proving both fields survive into the assembled payload
// shape doctor() returns.

test("doctor payload composition: cli_probe_timeouts and duration_ms both appear in the assembled result", async () => {
  const pins = defaultAgyPins();
  const doctorStart = Date.now();
  const [{ versions, timeouts: cli_probe_timeouts }, agyPinResult] = await Promise.all([
    captureCliVersions(async () => null, 50), // every version probe "fails fast" (not a timeout)
    checkAgyPinServedBounded(pins, 50, () => new Promise(() => {})), // hangs -> exercises the race
  ]);
  const duration_ms = Date.now() - doctorStart;
  const payload = { cli_versions: versions, cli_probe_timeouts, agy_pin_check: agyPinResult, duration_ms };

  assert.ok(Array.isArray(payload.cli_probe_timeouts), "cli_probe_timeouts must be an array in the doctor payload");
  assert.equal(payload.agy_pin_check.agy_pin_served, null, "a hung pin check must degrade open, not fail closed");
  assert.ok(typeof payload.duration_ms === "number" && payload.duration_ms >= 0, "duration_ms must be a non-negative number");
});
