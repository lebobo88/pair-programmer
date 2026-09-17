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
const { defaultAgyPins } = await importDist("orchestrator/agy-pin.js");

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
