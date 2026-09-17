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
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { execSync } from "node:child_process";
import test from "node:test";
import assert from "node:assert/strict";

/**
 * Best-effort backstop (P1b hardening): kill any process whose command line
 * still references `needle` (a unique temp-dir path baked into a shim). The
 * production process-tree kill (killProcessTree in cli-runner.ts) is what's
 * actually under test and should leave nothing behind on its own; this is
 * defense-in-depth so a regression cannot leak a process past this suite's
 * lifetime, per "every test that spawns a shim cleans up its own processes
 * in a finally".
 */
function killAnyProcessReferencing(needle) {
  try {
    if (process.platform === "win32") {
      const escaped = needle.replace(/'/g, "''");
      const out = execSync(
        `powershell -NoProfile -Command "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*${escaped}*' } | Select-Object -ExpandProperty ProcessId"`,
        { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
      );
      for (const line of out.split(/\r?\n/)) {
        const pid = parseInt(line.trim(), 10);
        if (Number.isFinite(pid)) {
          try { execSync(`taskkill /PID ${pid} /T /F`, { stdio: "ignore" }); } catch { /* already gone */ }
        }
      }
    } else {
      const out = execSync(`pgrep -f ${JSON.stringify(needle)} || true`, { encoding: "utf8" });
      for (const line of out.split(/\r?\n/)) {
        const pid = parseInt(line.trim(), 10);
        if (Number.isFinite(pid)) {
          try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ }
        }
      }
    }
  } catch { /* best-effort cleanup; never fail the test on cleanup errors */ }
}

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

// ─── P1a (gpt-5.6-terra, revise pass): installed-but-unconfigured is a
// FOURTH state, distinct from "ok" — a resolved --version does not mean the
// vendor has usable credentials. ──────────────────────────────────────────

test("classifyCliProbeResult: a resolved version with configured=false is 'unconfigured', NOT 'ok'", () => {
  assert.equal(classifyCliProbeResult("codex", "1.2.3", [], false), "unconfigured");
  assert.equal(classifyCliProbeResult("codex", "1.2.3", ["codex"], false), "unconfigured");
});

test("classifyCliProbeResult: a resolved version with configured=true or omitted is 'ok'", () => {
  assert.equal(classifyCliProbeResult("codex", "1.2.3", [], true), "ok");
  assert.equal(classifyCliProbeResult("codex", "1.2.3", [], undefined), "ok");
});

test("cliRemediationText: 'unconfigured' classification uses the vendor-specific install/login hint verbatim (installed, no credentials)", () => {
  assert.equal(
    cliRemediationText("codex", "unconfigured", "OpenAI not configured (set OPENAI_API_KEY or `codex login`)"),
    "OpenAI not configured (set OPENAI_API_KEY or `codex login`)",
  );
  assert.equal(
    cliRemediationText("agy", "unconfigured", "Google not configured (set GEMINI_API_KEY or sign in via `agy`)"),
    "Google not configured (set GEMINI_API_KEY or sign in via `agy`)",
  );
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

test("buildVendorRemediationNote: a resolved AND configured vendor produces no remediation text", () => {
  const note = buildVendorRemediationNote(
    { codex: "1.2.3", agy: "4.5.6" },
    ["codex", "agy"],
    { openai: true, google: true },
  );
  assert.equal(note.codex, null);
  assert.equal(note.agy, null);
});

// P1a regression: this call site USED to lock in "any resolved version is
// always 'ok', full stop" — dropping credential guidance for an installed
// binary with no working credentials. buildVendorRemediationNote now takes
// vendors_configured as a third argument specifically to catch this.
test("buildVendorRemediationNote: an INSTALLED but UNCONFIGURED vendor still gets credential/login advice, not silence", () => {
  const note = buildVendorRemediationNote(
    { codex: "1.2.3", agy: "4.5.6" },
    [],
    { openai: false, google: false },
  );
  assert.match(note.codex, /OPENAI_API_KEY|codex login/i);
  assert.match(note.agy, /GEMINI_API_KEY|ANTIGRAVITY_API_KEY|agy/i);
  assert.doesNotMatch(note.codex, /PP_DOCTOR_PROBE_TIMEOUT_MS/);
  assert.doesNotMatch(note.agy, /PP_DOCTOR_PROBE_TIMEOUT_MS/);
});

test("buildVendorRemediationNote: vendors_configured omitted (unknown) still treats a resolved version as 'ok' (no manufactured warning)", () => {
  const note = buildVendorRemediationNote({ codex: "1.2.3", agy: "4.5.6" }, ["codex", "agy"]);
  assert.equal(note.codex, null);
  assert.equal(note.agy, null);
});

/** Put a hanging `codex`/`agy` (never exits) FIRST on PATH so a real spawn of either never resolves. */
function installHangingVendorShims() {
  const dir = mkdtempSync(join(tmpdir(), "pp-shim-vendor-hang-"));
  // 60s loops (not 3600s, per P1b hardening): the daemon is expected to
  // process-tree-kill these on timeout; should that regress, a leaked
  // process still can't outlive this suite by an hour.
  for (const bin of ["codex", "agy"]) {
    writeFileSync(join(dir, `${bin}.cmd`), `@echo off\r\n:loop\r\ntimeout /t 60 >nul\r\ngoto loop\r\n`, "utf8");
    writeFileSync(join(dir, bin), `#!/bin/sh\nwhile true; do sleep 60; done\n`, { encoding: "utf8", mode: 0o755 });
  }
  const prevPath = process.env.PATH;
  process.env.PATH = dir + delimiter + prevPath;
  return {
    cleanup() {
      process.env.PATH = prevPath;
      // Best-effort: the production timeout enforcement should already have
      // reaped any spawned shim process (that's what's under test), but kill
      // by path reference too so a regression can't leak past this test.
      killAnyProcessReferencing(dir);
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/**
 * Put a FAST (instant, version-printing) `codex`/`agy` shim on PATH, with an
 * isolated HOME/USERPROFILE so file-based login detection
 * (~/.codex/auth.json, ~/.gemini/oauth_creds.json) can never pick up the
 * real operator's credentials on the machine running this suite. Combined
 * with clearing the credential env vars, this deterministically reproduces
 * the P1a "installed but unconfigured" state regardless of what's actually
 * on this machine.
 */
function installFastUnconfiguredVendorShims() {
  const dir = mkdtempSync(join(tmpdir(), "pp-shim-vendor-fast-"));
  for (const bin of ["codex", "agy"]) {
    writeFileSync(join(dir, `${bin}.cmd`), `@echo off\r\necho 1.0.0-test\r\n`, "utf8");
    writeFileSync(join(dir, bin), `#!/bin/sh\necho 1.0.0-test\n`, { encoding: "utf8", mode: 0o755 });
  }
  const isolatedHome = mkdtempSync(join(tmpdir(), "pp-isolated-home-"));
  const prevPath = process.env.PATH;
  const prevHome = process.env.HOME;
  const prevUserProfile = process.env.USERPROFILE;
  const prevEnvVars = {
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
    GEMINI_API_KEY: process.env.GEMINI_API_KEY,
    GOOGLE_API_KEY: process.env.GOOGLE_API_KEY,
    ANTIGRAVITY_API_KEY: process.env.ANTIGRAVITY_API_KEY,
  };
  process.env.PATH = dir + delimiter + prevPath;
  process.env.HOME = isolatedHome;
  process.env.USERPROFILE = isolatedHome;
  delete process.env.OPENAI_API_KEY;
  delete process.env.GEMINI_API_KEY;
  delete process.env.GOOGLE_API_KEY;
  delete process.env.ANTIGRAVITY_API_KEY;
  return {
    cleanup() {
      process.env.PATH = prevPath;
      if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome;
      if (prevUserProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = prevUserProfile;
      for (const [k, v] of Object.entries(prevEnvVars)) {
        if (v === undefined) delete process.env[k]; else process.env[k] = v;
      }
      rmSync(dir, { recursive: true, force: true });
      rmSync(isolatedHome, { recursive: true, force: true });
    },
  };
}

// End-to-end P1a proof: startBestOfStage's ACTUAL thrown message (not just
// the shared helper in isolation) must carry credential wording — not
// budget wording — when the vendor CLI resolves fine but has no usable
// credentials. Before the fix, doctor()'s cliVersions.codex/agy resolving
// non-null short-circuited buildVendorRemediationNote straight to "ok" and
// this call site silently lost all remediation text.
test("best-of-n startBestOfStage: precondition message uses credential wording (not budget wording) for an INSTALLED-but-UNCONFIGURED vendor", async () => {
  const shim = installFastUnconfiguredVendorShims();
  const prevAllow = process.env.PP_ALLOW_BEST_OF_WITHOUT_JUDGE;
  delete process.env.PP_ALLOW_BEST_OF_WITHOUT_JUDGE;
  try {
    const { startBestOfStage } = await importDist("orchestrator/best-of-n.js");
    await assert.rejects(
      () => startBestOfStage({ run_id: "run_does_not_exist_for_this_test_2", kind: "spec", gate_type: "spec", n: 2 }),
      (err) => {
        assert.match(err.message, /best-of-N refused/);
        assert.match(
          err.message,
          /OPENAI_API_KEY|codex login|GEMINI_API_KEY|ANTIGRAVITY_API_KEY|sign in/i,
          `expected credential wording for an installed-but-unconfigured vendor, got: ${err.message}`,
        );
        assert.doesNotMatch(
          err.message,
          /PP_DOCTOR_PROBE_TIMEOUT_MS/,
          `an installed-but-unconfigured vendor is NOT a timeout — must not get budget wording, got: ${err.message}`,
        );
        return true;
      },
    );
  } finally {
    shim.cleanup();
    if (prevAllow === undefined) delete process.env.PP_ALLOW_BEST_OF_WITHOUT_JUDGE;
    else process.env.PP_ALLOW_BEST_OF_WITHOUT_JUDGE = prevAllow;
  }
});

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
