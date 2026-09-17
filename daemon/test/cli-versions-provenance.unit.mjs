// Unit test for gpt-5.6-terra finding #4: startRun must persist WHICH CLI
// version probes (if any) timed out, alongside the resolved versions
// themselves. Without this, a probe that merely exceeded
// PP_DOCTOR_PROBE_TIMEOUT_MS is indistinguishable on replay from a CLI that
// was genuinely not installed at run-start.
//
// CHOICE MADE: confine no special-casing to doctor() alone — persist the
// provenance directly in runs.cli_versions_json as an additive
// `probe_timeouts` sibling key (`{ codex: "1.2.3", agy: null, ...,
// probe_timeouts: ["agy"] }`). This keeps the DB schema unchanged (no
// migration), keeps existing readers of the per-CLI keys unaffected, and
// keeps the field co-located with the versions it annotates instead of a
// second column that could drift out of sync with cli_versions_json.
//
// Against a temp SQLite DB (no daemon, no MCP peer). startRun() itself has no
// injectable CLI-version-probe seam (captureCliVersions() is called with no
// args), so a genuine timeout is induced the same way
// copilot-fallback-runtime.unit.mjs induces genuine CLI behaviour: a
// PATH-shimmed `agy` that hangs forever, combined with a very small
// PP_DOCTOR_PROBE_TIMEOUT_MS. This drives the REAL captureCliVersions/tryCmd/
// trackedExeca path end-to-end — a hard-coded empty probe_timeouts array (or
// one that never actually raced a hang) would fail this test, whereas the
// previous version (no shim, default 15s budget, real CLIs that all resolve
// well under that) could never time out and would pass either way.

import { strict as assert } from "node:assert";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join, delimiter } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { execSync } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DIST = join(__dirname, "..", "dist");

const SUITE_DIR = mkdtempSync(join(tmpdir(), "pp-cli-versions-provenance-"));
mkdirSync(join(SUITE_DIR, ".pair-programmer"), { recursive: true });
process.env.PP_HOME = SUITE_DIR;
process.env.EIGHTS_SKIP_AUDIT_CHECK = "1";

const runs = await import(pathToFileURL(join(DIST, "orchestrator", "runs.js")).href);
const { db } = await import(pathToFileURL(join(DIST, "db", "database.js")).href);

let passed = 0, failed = 0;
async function it(label, fn) {
  try { await fn(); passed++; console.log(`✓ ${label}`); }
  catch (err) { failed++; console.error(`✗ ${label}`); console.error(`  ${err.message}`); }
}

let seq = 0;
function scaffoldProject() {
  const project = mkdtempSync(join(tmpdir(), `pp-cvp-${seq++}-`));
  mkdirSync(join(project, ".harness"), { recursive: true });
  writeFileSync(join(project, "AGENTS.md"), "# AGENTS\n", "utf8");
  try {
    execSync("git init -q", { cwd: project, stdio: "ignore" });
    execSync("git -c user.email=t@t -c user.name=t commit -q --allow-empty -m init", { cwd: project, stdio: "ignore" });
  } catch { /* head_sha simply stays null */ }
  return project;
}

/** Put a hanging `agy` (never exits) FIRST on PATH so a real spawn of it never resolves. */
function installHangingAgyShim() {
  const dir = mkdtempSync(join(tmpdir(), "pp-shim-agy-hang-"));
  // Windows resolves a bare `agy` via PATHEXT, so the shim must be `.cmd`.
  // 60s (not 3600s, per P1b hardening): the daemon is now expected to
  // process-tree-kill this on timeout, but should it ever leak, a stray
  // process should not be able to outlive the test suite by an hour.
  writeFileSync(join(dir, "agy.cmd"), `@echo off\r\n:loop\r\ntimeout /t 60 >nul\r\ngoto loop\r\n`, "utf8");
  // POSIX equivalent so this is not silently a no-op off Windows.
  writeFileSync(join(dir, "agy"), `#!/bin/sh\nwhile true; do sleep 60; done\n`, { encoding: "utf8", mode: 0o755 });
  const prevPath = process.env.PATH;
  process.env.PATH = dir + delimiter + prevPath;
  return {
    cleanup() {
      process.env.PATH = prevPath;
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

await it("startRun persists cli_versions_json with a probe_timeouts sibling key (empty when nothing timed out)", async () => {
  const project = scaffoldProject();
  const r = await runs.startRun({ request_text: "cli versions fixture (all fast)", project_path: project, mode: "single" });
  const row = db().prepare("SELECT cli_versions_json FROM runs WHERE id = ?").get(r.run_id);
  assert.ok(row.cli_versions_json, "cli_versions_json must be populated");
  const parsed = JSON.parse(row.cli_versions_json);
  assert.ok(Array.isArray(parsed.probe_timeouts), "probe_timeouts must be an array, even when empty");
  for (const cli of ["codex", "agy", "claude", "git", "node"]) {
    assert.ok(Object.prototype.hasOwnProperty.call(parsed, cli), `cli_versions_json must still carry the ${cli} key`);
  }
});

await it("startRun persists the SPECIFIC timed-out CLI name in cli_versions_json.probe_timeouts when its --version probe genuinely hangs", async () => {
  const prevBudget = process.env.PP_DOCTOR_PROBE_TIMEOUT_MS;
  const shim = installHangingAgyShim();
  process.env.PP_DOCTOR_PROBE_TIMEOUT_MS = "500";
  try {
    const project = scaffoldProject();
    const r = await runs.startRun({ request_text: "cli versions fixture (agy hangs)", project_path: project, mode: "single" });
    const row = db().prepare("SELECT cli_versions_json FROM runs WHERE id = ?").get(r.run_id);
    const parsed = JSON.parse(row.cli_versions_json);
    assert.equal(parsed.agy, null, "a timed-out probe must still resolve the version to null");
    assert.ok(
      Array.isArray(parsed.probe_timeouts) && parsed.probe_timeouts.includes("agy"),
      `probe_timeouts must name "agy" as the CLI whose probe timed out, got ${JSON.stringify(parsed.probe_timeouts)}`,
    );
  } finally {
    shim.cleanup();
    if (prevBudget === undefined) delete process.env.PP_DOCTOR_PROBE_TIMEOUT_MS;
    else process.env.PP_DOCTOR_PROBE_TIMEOUT_MS = prevBudget;
  }
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
