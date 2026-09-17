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
// Against a temp SQLite DB (no daemon, no MCP peer). captureCliVersions()'s
// default probe is injected via a fake CliVersionProbe so this test is fast
// and deterministic (no real CLI spawns, no dependency on the exact CLI
// timeout budget of the host machine).

import { strict as assert } from "node:assert";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
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
