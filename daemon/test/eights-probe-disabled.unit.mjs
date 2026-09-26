// Regression guard (cross-vendor judge finding, 2026-09-25): unit tests must
// NEVER spawn or connect to a real TheEights daemon.
//
// Root cause this guards: eights-client.ts's probe() used to fail FAST
// against a real TheEights install because the strict listTools() schema
// threw on TheEights' malformed `eights.evolution.register` tool. Once that
// schema check was made lenient (1385c2c, closing a different bug), probe()
// started SUCCEEDING against a real daemon -- and pp's ~80 unit tests that
// exercise runs.ts code paths (archiveArtifact/recordVerdict/finalizeRun)
// fire eights-writes.ts's fire-and-forget calls into eights-client.ts on
// every run, with no PP_EIGHTS_DAEMON override. On a dev box with a sibling
// TheEights checkout (resolveDaemonEntry() step 4), those fire-and-forget
// calls actually spawned a real `TheEights\daemon\dist\index.js mcp` child,
// which was never closed (fire-and-forget never calls shutdown()) and kept
// the unit test file's own process alive until its test-runner timeout
// forcibly killed it. Reproduced directly: `[eights-daemon] booting pid=...`
// in a hung unit test's own log, with that pid confirmed still alive when
// node cancelled the file (`Get-Process -Id <pid>` succeeded).
//
// The fix: `PP_ECOSYSTEM_DISABLED=1` makes probe() return "unavailable"
// before `resolveDaemonEntry()` is even called -- no StdioClientTransport is
// constructed, no subprocess spawn is attempted, period.
// `scripts/run-tests.mjs` sets this for the entire batched `*.unit.mjs` run.
//
// This file proves the mechanism works in isolation (deliberately does NOT
// set PP_EIGHTS_DAEMON, reproducing the exact fire-and-forget shape that
// caused the regression) AND that scripts/run-tests.mjs still sets the flag
// for the batch that actually matters in CI/local `npm test`.

import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DIST = join(__dirname, "..", "dist");
const importDist = (relPath) => import(pathToFileURL(join(DIST, relPath)).href);

// Deliberately do NOT set PP_EIGHTS_DAEMON -- this reproduces the exact
// shape of the regression (a caller with no explicit override, relying on
// resolveDaemonEntry()'s sibling-install fallback, which DOES exist on this
// dev box at C:\AiAppDeployments\TheEights\daemon\dist\index.js). The ONLY
// thing standing between this test and a real daemon spawn is the flag
// under test.
process.env.PP_ECOSYSTEM_DISABLED = "1";

async function testProbeDisabledNeverSpawns() {
  const mod = await importDist("ecosystem/eights-client.js");

  assert.equal(mod.isAvailableSync(), false, "isAvailableSync starts false");

  const startedAt = Date.now();
  const ok = await mod.isAvailable();
  const elapsedMs = Date.now() - startedAt;

  assert.equal(ok, false, "isAvailable() must be false when PP_ECOSYSTEM_DISABLED=1");
  assert.equal(mod.isAvailableSync(), false, "isAvailableSync stays false");
  // A real spawn attempt (even one that ultimately fails) involves process
  // creation + at least one connect handshake; the production probe timeout
  // alone is 3000ms. A same-process short-circuit with no I/O resolves in
  // low single-digit milliseconds. 500ms is a generous ceiling that would
  // still fail if probe() were spawning anything.
  assert.ok(
    elapsedMs < 500,
    `isAvailable() took ${elapsedMs}ms with PP_ECOSYSTEM_DISABLED=1 -- ` +
      `this should be a same-process short-circuit with no subprocess spawn ` +
      `and no network I/O; a slow result here means the disable flag stopped ` +
      `working and probe() is reaching resolveDaemonEntry()/StdioClientTransport again`
  );
  assert.equal(
    mod.getConnectedDaemonPidForTesting(),
    null,
    "no daemon subprocess pid should ever be recorded when the probe is disabled"
  );
  console.log(`✓ PP_ECOSYSTEM_DISABLED=1 short-circuits probe() with no spawn (${elapsedMs}ms)`);
}

function testRunTestsScriptSetsTheFlag() {
  const runTestsPath = join(__dirname, "..", "scripts", "run-tests.mjs");
  const src = readFileSync(runTestsPath, "utf8");
  assert.match(
    src,
    /process\.env\.PP_ECOSYSTEM_DISABLED\s*=\s*["']1["']/,
    "scripts/run-tests.mjs must set PP_ECOSYSTEM_DISABLED=1 around the batched " +
      "*.unit.mjs run -- its absence means a future edit silently re-exposed every " +
      "unit test to a real TheEights spawn via fire-and-forget eights-writes.ts calls"
  );
  // The flag must be set BEFORE the unit-file batch `run(...)` call and
  // cleared before the smoke-test `run(...)` calls that follow it (those
  // legitimately probe TheEights, gated on PP_LIVE_EIGHTS=1) -- assert
  // ordering, not just presence, so a reordering regression is caught too.
  const setIdx = src.indexOf('process.env.PP_ECOSYSTEM_DISABLED = "1"');
  const unitRunIdx = src.indexOf("...unitFiles");
  const smokeRunIdx = src.indexOf('join("test", "eights-integration.smoke.mjs")');
  assert.ok(setIdx >= 0 && unitRunIdx >= 0 && smokeRunIdx >= 0, "expected anchors not found in run-tests.mjs");
  assert.ok(setIdx < unitRunIdx, "PP_ECOSYSTEM_DISABLED must be set BEFORE the unit-file batch run");
  assert.ok(unitRunIdx < smokeRunIdx, "the unit-file batch must run before the smoke tests");
  console.log("✓ scripts/run-tests.mjs sets PP_ECOSYSTEM_DISABLED=1 before the unit-file batch");
}

async function main() {
  await testProbeDisabledNeverSpawns();
  testRunTestsScriptSetsTheFlag();
  console.log("✓ eights-probe-disabled.unit.mjs: all assertions passed");
}

main().catch((err) => {
  console.error("✗ eights-probe-disabled.unit.mjs failed:", err);
  process.exit(1);
});
