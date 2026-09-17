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
import { dirname, join, delimiter } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import test from "node:test";
import assert from "node:assert/strict";

const SUITE_DIR = mkdtempSync(join(tmpdir(), "pp-doctor-remediation-"));
mkdirSync(join(SUITE_DIR, ".pair-programmer"), { recursive: true });
process.env.PP_HOME = SUITE_DIR;

const __dirname = dirname(fileURLToPath(import.meta.url));
const DIST = join(__dirname, "..", "dist");
const importDist = (relPath) => import(pathToFileURL(join(DIST, relPath)).href);

const { classifyCliProbeResult, cliRemediationText, buildVendorRemediationNote } = await importDist("hooks/dispatcher.js");

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

// ─── finding 2 (gpt-5.6-terra remediation-wording pass, sites the prior pass missed) ──
//
// best-of-n.ts's startBestOfStage precondition and dispatcher.ts's
// vendor-matrix hook both build their operator-facing remediation off
// vendors_configured / cli_probe_timeouts. Both now route through the same
// buildVendorRemediationNote() helper this file already exercises through
// classifyCliProbeResult/cliRemediationText — these tests exercise
// buildVendorRemediationNote() itself (the single source of truth both call
// sites now share) and then, separately, best-of-n's ACTUAL thrown Error
// message end-to-end so a regression at either the shared helper OR its call
// site is caught.

test("buildVendorRemediationNote: a timed-out vendor gets budget wording (naming PP_DOCTOR_PROBE_TIMEOUT_MS), not credential advice", () => {
  const note = buildVendorRemediationNote({ codex: null, agy: null }, ["codex", "agy"]);
  assert.match(note.codex, /PP_DOCTOR_PROBE_TIMEOUT_MS/);
  assert.match(note.agy, /PP_DOCTOR_PROBE_TIMEOUT_MS/);
  assert.doesNotMatch(note.codex, /codex login/i);
  assert.doesNotMatch(note.agy, /sign in/i);
  assert.doesNotMatch(note.codex, /OPENAI_API_KEY/);
  assert.doesNotMatch(note.agy, /GEMINI_API_KEY|ANTIGRAVITY_API_KEY/);
});

test("buildVendorRemediationNote: a genuinely-missing vendor still gets install/login/credential advice", () => {
  const note = buildVendorRemediationNote({ codex: null, agy: null }, []);
  assert.match(note.codex, /OPENAI_API_KEY|codex login/i);
  assert.match(note.agy, /GEMINI_API_KEY|ANTIGRAVITY_API_KEY|agy/i);
  assert.doesNotMatch(note.codex, /PP_DOCTOR_PROBE_TIMEOUT_MS/);
  assert.doesNotMatch(note.agy, /PP_DOCTOR_PROBE_TIMEOUT_MS/);
});

test("buildVendorRemediationNote: a resolved (ok) vendor produces no remediation text", () => {
  const note = buildVendorRemediationNote({ codex: "1.2.3", agy: "4.5.6" }, ["codex", "agy"]);
  assert.equal(note.codex, null);
  assert.equal(note.agy, null);
});

/** Put a hanging `codex`/`agy` (never exits) FIRST on PATH so a real spawn of either never resolves. */
function installHangingVendorShims() {
  const dir = mkdtempSync(join(tmpdir(), "pp-shim-vendor-hang-"));
  for (const bin of ["codex", "agy"]) {
    writeFileSync(join(dir, `${bin}.cmd`), `@echo off\r\n:loop\r\ntimeout /t 3600 >nul\r\ngoto loop\r\n`, "utf8");
    writeFileSync(join(dir, bin), `#!/bin/sh\nwhile true; do sleep 3600; done\n`, { encoding: "utf8", mode: 0o755 });
  }
  const prevPath = process.env.PATH;
  process.env.PATH = dir + delimiter + prevPath;
  return {
    cleanup() {
      process.env.PATH = prevPath;
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test("best-of-n startBestOfStage: precondition message uses budget wording for timed-out vendors and still refuses (fail-closed)", async () => {
  const shim = installHangingVendorShims();
  const prevBudget = process.env.PP_DOCTOR_PROBE_TIMEOUT_MS;
  const prevPinBudget = process.env.PP_DOCTOR_PIN_TIMEOUT_MS;
  const prevAllow = process.env.PP_ALLOW_BEST_OF_WITHOUT_JUDGE;
  process.env.PP_DOCTOR_PROBE_TIMEOUT_MS = "300";
  process.env.PP_DOCTOR_PIN_TIMEOUT_MS = "300";
  delete process.env.PP_ALLOW_BEST_OF_WITHOUT_JUDGE;
  try {
    const { startBestOfStage } = await importDist("orchestrator/best-of-n.js");
    await assert.rejects(
      () => startBestOfStage({ run_id: "run_does_not_exist_for_this_test", kind: "spec", gate_type: "spec", n: 2 }),
      (err) => {
        assert.match(err.message, /best-of-N refused/);
        assert.match(
          err.message,
          /PP_DOCTOR_PROBE_TIMEOUT_MS/,
          `expected budget wording in the refusal message, got: ${err.message}`,
        );
        assert.doesNotMatch(
          err.message,
          /configure codex|configure agy|codex login|sign in/i,
          `a timed-out probe must not be rendered with credential advice, got: ${err.message}`,
        );
        return true;
      },
    );
  } finally {
    shim.cleanup();
    if (prevBudget === undefined) delete process.env.PP_DOCTOR_PROBE_TIMEOUT_MS;
    else process.env.PP_DOCTOR_PROBE_TIMEOUT_MS = prevBudget;
    if (prevPinBudget === undefined) delete process.env.PP_DOCTOR_PIN_TIMEOUT_MS;
    else process.env.PP_DOCTOR_PIN_TIMEOUT_MS = prevPinBudget;
    if (prevAllow === undefined) delete process.env.PP_ALLOW_BEST_OF_WITHOUT_JUDGE;
    else process.env.PP_ALLOW_BEST_OF_WITHOUT_JUDGE = prevAllow;
  }
});
