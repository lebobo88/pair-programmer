// Unit tests for gpt-5.6-terra finding #2: a CLI whose --version probe
// TIMED OUT must not be rendered with install/login remediation — that is
// actively wrong advice for a CLI that merely cold-starts slowly.
//
// The hook handlers themselves (dispatcher.ts's cli-version-pin,
// vendor-matrix, enforce-vendor-matrix) call reply() -> process.exit and read
// real doctor() output, so they are not unit-tested directly (see the
// existing convention in doctor-pin-freshness.unit.mjs of testing the pure
// helpers a hook is built from instead). classifyCliProbeResult() and
// cliRemediationText() are the pure, exported decision points those three
// handlers all route through; this file exercises them directly.
//
// Pure/offline. Runs against dist/.

import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DIST = join(__dirname, "..", "dist");
const importDist = (relPath) => import(pathToFileURL(join(DIST, relPath)).href);

const { classifyCliProbeResult, cliRemediationText } = await importDist("hooks/dispatcher.js");

test("classifyCliProbeResult: a resolved version is 'ok' regardless of cli_probe_timeouts", () => {
  assert.equal(classifyCliProbeResult("codex", "1.2.3", ["codex"]), "ok");
  assert.equal(classifyCliProbeResult("codex", "1.2.3", undefined), "ok");
});

test("classifyCliProbeResult: a null version NOT named in cli_probe_timeouts is 'missing'", () => {
  assert.equal(classifyCliProbeResult("codex", null, []), "missing");
  assert.equal(classifyCliProbeResult("codex", null, undefined), "missing");
  assert.equal(classifyCliProbeResult("codex", null, ["agy"]), "missing");
});

test("classifyCliProbeResult: a null version named in cli_probe_timeouts is 'timed_out', NOT 'missing'", () => {
  assert.equal(classifyCliProbeResult("agy", null, ["agy"]), "timed_out");
  assert.equal(classifyCliProbeResult("agy", null, ["codex", "agy", "claude"]), "timed_out");
});

test("cliRemediationText: 'ok' classification produces no remediation text", () => {
  assert.equal(cliRemediationText("codex", "ok", "install codex"), null);
});

test("cliRemediationText: 'missing' classification uses the vendor-specific install/login hint verbatim", () => {
  assert.equal(
    cliRemediationText("codex", "missing", "OpenAI not configured (set OPENAI_API_KEY or `codex login`)"),
    "OpenAI not configured (set OPENAI_API_KEY or `codex login`)",
  );
});

test("cliRemediationText: 'timed_out' classification NEVER mentions install/login, regardless of the hint text passed", () => {
  const text = cliRemediationText("agy", "timed_out", "Google not configured (set GEMINI_API_KEY or sign in via `agy`)");
  assert.doesNotMatch(text, /install/i);
  assert.doesNotMatch(text, /log ?in|sign in/i);
  assert.match(text, /PP_DOCTOR_PROBE_TIMEOUT_MS/);
  assert.match(text, /not confirmed missing/i);
});
