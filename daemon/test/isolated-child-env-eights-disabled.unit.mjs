// Regression guard (host decision, 2026-09-26): `isolatedChildEnv()`
// (test/fixtures/isolated-env.mjs) is the ONE shared helper every daemon-
// spawning test/smoke in daemon/test builds its child env through. Before
// this fix, it only scrubbed/relocated the two PP ledger-location vars
// (PP_DB_PATH/PP_HOME) -- it never touched HOME/USERPROFILE/EIGHTS_HOME, so
// every child spawned through it inherited the OPERATOR'S REAL HOME. On a
// dev box with the TheEights sibling checkout present (the well-known
// fallback in eights-client.ts's resolveDaemonEntry()), that meant SEVEN
// files (test/artifact-validators.smoke.mjs, test/best-of-data-loss.mjs,
// test/smoke.mjs, test/cost-derivation.unit.mjs [x4 call sites],
// test/execution-events.unit.mjs, test/hook-transport.unit.mjs,
// test/mcp-instructions.unit.mjs) could each reach a REAL TheEights daemon
// against the operator's REAL ~/.eights -- see
// .harness/evidence/l1b-artifact-validators-smoke-eights-hermeticity.md for
// the full file:line inventory.
//
// This guards the CENTRAL fix (not any one call site): isolatedChildEnv()
// with no `eights` option must build an env that (a) sets
// PP_ECOSYSTEM_DISABLED="1", (b) never sets EIGHTS_HOME, and -- the
// falsifiable, real-world-accurate check, not a hand-rolled re-implementation
// of the guard -- (c) a REAL child process that imports the compiled
// eights-client.js and inherits ONLY that built env (nothing else from this
// test's own process.env) reports isAvailable()===false, resolving fast
// (same-process short-circuit, no subprocess spawn), exactly like
// eights-probe-disabled.unit.mjs proves for a hand-set PP_ECOSYSTEM_DISABLED.

import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";
import { isolatedChildEnv } from "./fixtures/isolated-env.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DIST = join(__dirname, "..", "dist");

function testBuiltEnvShape() {
  const { env } = isolatedChildEnv({ extra: { EIGHTS_SKIP_AUDIT_CHECK: "1" }, prefix: "pp-guard-home-" });
  assert.equal(
    env.PP_ECOSYSTEM_DISABLED,
    "1",
    "isolatedChildEnv() with no `eights` option must default PP_ECOSYSTEM_DISABLED=1",
  );
  assert.equal(
    env.EIGHTS_HOME,
    undefined,
    "isolatedChildEnv() with no `eights` option must never set EIGHTS_HOME (nothing to redirect if the probe never runs)",
  );
  console.log("✓ isolatedChildEnv() with no `eights` option sets PP_ECOSYSTEM_DISABLED=1 and no EIGHTS_HOME");
}

function testOptInStillNeverUsesRealHome() {
  const { env } = isolatedChildEnv({ eights: { enabled: true }, prefix: "pp-guard-optin-home-" });
  assert.notEqual(
    env.PP_ECOSYSTEM_DISABLED,
    "1",
    "an explicit eights.enabled=true opt-in must not also disable the ecosystem",
  );
  assert.ok(
    typeof env.EIGHTS_HOME === "string" && env.EIGHTS_HOME.length > 0,
    "opting in without an explicit PP_EIGHTS_DAEMON/EIGHTS_HOME override must redirect EIGHTS_HOME to an isolated temp dir, never fall through to the real ~/.eights",
  );
  console.log(`✓ eights.enabled=true opt-in redirects EIGHTS_HOME to an isolated temp dir (${env.EIGHTS_HOME}), never the real ~/.eights`);
}

// The falsifiable, real-world check: spawn an ACTUAL child process (mirrors
// what every one of the seven call sites in the inventory does) whose ENTIRE
// env is isolatedChildEnv()'s output -- nothing merged in from this test's
// own process.env -- and prove the production eights-client.js code path
// (not a re-implementation) reports unavailable, fast, with no daemon pid.
function testRealChildProcessNeverSpawns() {
  const { env, ppHome } = isolatedChildEnv({ extra: { EIGHTS_SKIP_AUDIT_CHECK: "1" }, prefix: "pp-guard-child-home-" });
  const scriptDir = mkdtempSync(join(tmpdir(), "pp-guard-child-script-"));
  const scriptPath = join(scriptDir, "probe-check.mjs");
  const eightsClientHref = pathToFileURL(join(DIST, "ecosystem", "eights-client.js")).href;
  writeFileSync(
    scriptPath,
    [
      `const mod = await import(${JSON.stringify(eightsClientHref)});`,
      "const startedAt = Date.now();",
      "const ok = await mod.isAvailable();",
      "const elapsedMs = Date.now() - startedAt;",
      "const pid = mod.getConnectedDaemonPidForTesting();",
      "process.stdout.write(JSON.stringify({ ok, elapsedMs, pid }));",
    ].join("\n"),
    "utf8",
  );

  let raw;
  try {
    // execFileSync with an explicit `env` replaces the child's env entirely
    // (no implicit inherit-and-merge with this test's own process.env) --
    // this is the same isolation guarantee every isolatedChildEnv() call
    // site relies on when it hands this `env` to StdioClientTransport/
    // execaSync.
    raw = execFileSync(process.execPath, [scriptPath], { env, encoding: "utf8", timeout: 15_000 });
  } finally {
    try { rmSync(scriptDir, { recursive: true, force: true }); } catch { /* best-effort */ }
    try { rmSync(ppHome, { recursive: true, force: true }); } catch { /* best-effort */ }
  }

  const { ok, elapsedMs, pid } = JSON.parse(raw);
  assert.equal(ok, false, "a real child process spawned with isolatedChildEnv()'s built env must report isAvailable()===false");
  assert.equal(pid, null, "no daemon subprocess pid should ever be recorded -- proves no real TheEights (or fixture) was spawned");
  assert.ok(
    elapsedMs < 500,
    `child process's isAvailable() took ${elapsedMs}ms -- a real spawn attempt (even a failing one) costs far more than a same-process short-circuit; ` +
      "this would regress if isolatedChildEnv()'s default stopped disabling the ecosystem probe",
  );
  console.log(`✓ a real child process spawned with isolatedChildEnv()'s built env never reaches TheEights (${elapsedMs}ms, isAvailable=false, pid=null)`);
}

function main() {
  testBuiltEnvShape();
  testOptInStillNeverUsesRealHome();
  testRealChildProcessNeverSpawns();
  console.log("✓ isolated-child-env-eights-disabled.unit.mjs: all assertions passed");
}

main();
