// Unit tests for doctorProbeTimeoutMs() / doctorPinTimeoutMs() env-var parsing
// (gpt-5.6-terra finding #3).
//
// Context: the parsers previously accepted any finite positive Number,
// including fractional values (execa/setTimeout silently floor these) and
// values beyond Node's 32-bit signed timer ceiling (~2147483647ms) — a value
// like PP_DOCTOR_PROBE_TIMEOUT_MS=6000000000 overflows the timer, which fires
// almost immediately, making every probe look instantly "missing" instead of
// running for the intended ~6.9 days (obviously absurd, but the point is the
// SILENT wraparound: a merely-too-large operator value like 3000000000 fails
// exactly the same way with no warning).
//
// Fix: reject anything that is not a safe integer in [1, 2147483647]; fall
// back to the default and log a warning.
//
// Pure/offline: reads/writes process.env only. Runs against dist/.

import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync, mkdirSync } from "node:fs";
import test from "node:test";
import assert from "node:assert/strict";

const SUITE_DIR = mkdtempSync(join(tmpdir(), "pp-doctor-timeout-env-"));
mkdirSync(join(SUITE_DIR, ".pair-programmer"), { recursive: true });
process.env.PP_HOME = SUITE_DIR;

const __dirname = dirname(fileURLToPath(import.meta.url));
const DIST = join(__dirname, "..", "dist");
const importDist = (relPath) => import(pathToFileURL(join(DIST, relPath)).href);

const { doctorProbeTimeoutMs, doctorPinTimeoutMs } = await importDist("config.js");

const MAX_TIMER_MS = 2_147_483_647;

/** Table-driven: [envValue, expectedResolvedMs, description]. */
const CASES = [
  [undefined, 15_000, "unset -> default"],
  ["", 15_000, "empty string -> default"],
  ["5000", 5_000, "well-formed positive integer -> honored"],
  ["1", 1, "the minimum valid value (1ms) -> honored"],
  [String(MAX_TIMER_MS), MAX_TIMER_MS, "the maximum valid value -> honored"],
  ["0", 15_000, "zero -> rejected, falls back to default"],
  ["-1000", 15_000, "negative -> rejected, falls back to default"],
  ["1500.5", 15_000, "fractional -> rejected (execa/setTimeout would silently floor it)"],
  ["not-a-number", 15_000, "non-numeric garbage -> rejected, falls back to default"],
  [String(MAX_TIMER_MS + 1), 15_000, "one past the 32-bit timer ceiling -> rejected"],
  ["6000000000", 15_000, "far beyond the timer ceiling (the reported bug value) -> rejected"],
  ["Infinity", 15_000, "Infinity -> rejected, falls back to default"],
  ["NaN", 15_000, "NaN -> rejected, falls back to default"],
];

test("doctorProbeTimeoutMs: validates PP_DOCTOR_PROBE_TIMEOUT_MS against [1, 2147483647] safe-integer range", () => {
  for (const [envValue, expected, desc] of CASES) {
    if (envValue === undefined) delete process.env.PP_DOCTOR_PROBE_TIMEOUT_MS;
    else process.env.PP_DOCTOR_PROBE_TIMEOUT_MS = envValue;
    assert.equal(doctorProbeTimeoutMs(), expected, `PP_DOCTOR_PROBE_TIMEOUT_MS=${JSON.stringify(envValue)}: ${desc}`);
  }
  delete process.env.PP_DOCTOR_PROBE_TIMEOUT_MS;
});

test("doctorPinTimeoutMs: validates PP_DOCTOR_PIN_TIMEOUT_MS against [1, 2147483647] safe-integer range (default 20000)", () => {
  const pinCases = CASES.map(([envValue, expected, desc]) => [
    envValue,
    expected === 15_000 ? 20_000 : expected, // pin's default is 20000, not 15000
    desc,
  ]);
  for (const [envValue, expected, desc] of pinCases) {
    if (envValue === undefined) delete process.env.PP_DOCTOR_PIN_TIMEOUT_MS;
    else process.env.PP_DOCTOR_PIN_TIMEOUT_MS = envValue;
    assert.equal(doctorPinTimeoutMs(), expected, `PP_DOCTOR_PIN_TIMEOUT_MS=${JSON.stringify(envValue)}: ${desc}`);
  }
  delete process.env.PP_DOCTOR_PIN_TIMEOUT_MS;
});

test("doctorProbeTimeoutMs / doctorPinTimeoutMs: env is re-read on every call (not memoized)", () => {
  process.env.PP_DOCTOR_PROBE_TIMEOUT_MS = "1234";
  assert.equal(doctorProbeTimeoutMs(), 1234);
  process.env.PP_DOCTOR_PROBE_TIMEOUT_MS = "5678";
  assert.equal(doctorProbeTimeoutMs(), 5678);
  delete process.env.PP_DOCTOR_PROBE_TIMEOUT_MS;
  assert.equal(doctorProbeTimeoutMs(), 15_000);
});
