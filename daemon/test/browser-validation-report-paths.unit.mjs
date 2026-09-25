/**
 * browser-validation-report-paths.unit.mjs — Phase M (GitHub #54, epic #42)
 *
 * Guards that two `browser_validation_finalize` calls never write to the same
 * file, and — the assertion whose absence let the defect hide — that the report
 * PP-VG-3 retains still contains what it claimed to retain.
 *
 * ── THE DEFECT ──────────────────────────────────────────────────────────────
 *
 * `browser-validation.ts` named its artifacts `report-${Date.now()}.md` under a
 * comment reading *"Use a timestamp suffix so multiple finalize calls don't
 * clobber each other."* At millisecond granularity it did not: two finalize
 * calls completing in the same millisecond produced the same filename, and
 * `writeFileSync` overwrites silently.
 *
 * That defeats PP-VG-3's severity ratchet in the worst possible way. The
 * ratchet keeps `effective_report_path` pointing at the highest-severity
 * report, so an errors report followed by a clean one in the same millisecond
 * left the gate correctly reporting **"errors retained"** while the retained
 * FILE had been overwritten with the clean report. The gate's answer and its
 * evidence disagreed, and nothing said so.
 *
 * ── HOW IT SURFACED, WHICH IS ITS OWN LESSON ────────────────────────────────
 *
 * As an intermittent `finalize-gates-a.unit.mjs` failure —
 * "new report path is timestamped differently" — that appeared only under
 * full-suite parallel load and never when the file ran alone. It was first
 * misread as the #57 per-test-timeout flake and "fixed" by raising the suite
 * timeout 180s → 240s, which passed once and then failed again. Only the
 * failure's SHAPE gave it away: #57 surfaces as a bare `'test failed'`, and
 * this was a NAMED assertion. `AGENTS.md` now says that discriminator is
 * load-bearing rather than advisory.
 *
 * The existing assertion catches the collision but not the overwrite; this file
 * adds the content check, because the collision is only a nuisance while the
 * silent loss of the retained report is a correctness failure.
 *
 * ANTI-STALL: self-contained. Temp `PP_HOME`, temp project dirs, direct `dist/`
 * imports. No live daemon, no MCP peer, no network.
 */

import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import assert from "node:assert/strict";

// PP_HOME before the first dist import — DB_PATH is resolved at module load, so
// setting it later would open the developer's real state.db.
const SUITE_DIR = mkdtempSync(join(tmpdir(), "pp-bv-report-paths-"));
mkdirSync(join(SUITE_DIR, ".pair-programmer"), { recursive: true });
process.env.PP_HOME = SUITE_DIR;
process.env.EIGHTS_SKIP_AUDIT_CHECK = "1";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DIST = join(__dirname, "..", "dist");
const importDist = (rel) => import(pathToFileURL(join(DIST, rel)).href);

let passed = 0;
let failed = 0;
async function record(name, fn) {
  try {
    await fn();
    console.log(`✓ ${name}`);
    passed++;
  } catch (err) {
    console.error(`✗ ${name}`);
    console.error(`  ${err.stack ?? err.message}`);
    failed++;
  }
}

function makeProject() {
  const dir = mkdtempSync(join(tmpdir(), "pp-bv-proj-"));
  mkdirSync(join(dir, ".harness"), { recursive: true });
  writeFileSync(join(dir, "AGENTS.md"), "# AGENTS\n", "utf8");
  return dir;
}

async function bootstrap(project) {
  const runs = await importDist("orchestrator/runs.js");
  const run = await runs.ensureRun({
    request_text: "browser-validation report path test",
    project_path: project,
    mode: "single",
  });
  const stage = await runs.startStage({ run_id: run.run_id, kind: "code", gate_type: "code_style" });
  return { runs, run, stage };
}

const ERRORS_FINDING = {
  route: "/api",
  step: "load",
  status: "pass",
  console_errors: [],
  network_errors: [{ url: "http://x/api", status: 500 }],
};
const CLEAN_FINDING = { route: "/api", step: "load", status: "pass", console_errors: [], network_errors: [] };

async function bvFinalize(run_id, stage_id, findings) {
  const bv = await importDist("orchestrator/browser-validation.js");
  return bv.browserValidationFinalize({ run_id, stage_id, engine: "playwright", findings });
}

/**
 * Run `fn` with `Date.now()` pinned to a constant, so every finalize call
 * inside it lands in the "same millisecond".
 *
 * ── WHY PINNING, RATHER THAN A TIGHT LOOP ───────────────────────────────────
 *
 * The first version of this file just made ten rapid calls and asserted the
 * paths differed, on the assumption that some would collide. They did not: on
 * this machine each call takes more than a millisecond, so the test passed
 * **even with the fix reverted** — it hoped for the race rather than forcing
 * it, and would have gone green while proving nothing. That is the same
 * hope-for-the-condition vacuity a cross-vendor judge caught earlier in this
 * campaign, reproduced two phases later.
 *
 * Pinning makes the collision certain and machine-independent. It is a real
 * condition, not a contrivance: the bug's whole trigger is two writes sharing a
 * millisecond, and under full-suite parallel load that is exactly what happened
 * often enough to make `finalize-gates-a` flaky.
 */
async function withFrozenClock(fn) {
  const realNow = Date.now;
  const frozen = realNow.call(Date);
  Date.now = () => frozen;
  try {
    return await fn();
  } finally {
    Date.now = realNow;
  }
}

// ── The collision, FORCED ──────────────────────────────────────────────────
await record("finalize calls sharing one millisecond still produce DISTINCT report paths", async () => {
  const project = makeProject();
  const { run, stage } = await bootstrap(project);

  const paths = await withFrozenClock(async () => {
    const out = [];
    for (let i = 0; i < 5; i += 1) {
      const r = await bvFinalize(run.run_id, stage.stage_id, [i === 0 ? ERRORS_FINDING : CLEAN_FINDING]);
      out.push(r.report_path);
    }
    return out;
  });

  const unique = new Set(paths);
  assert.equal(
    unique.size,
    paths.length,
    `report paths collided under a frozen clock: ${paths.length - unique.size} duplicate(s) among ` +
      `${JSON.stringify(paths)}. A collision means writeFileSync overwrote a previous report silently — ` +
      `which is the defect, since the comment above the naming code claims collision safety.`,
  );
});

// ── The assertion whose absence let the overwrite hide ─────────────────────
await record("the report PP-VG-3 retains still CONTAINS the errors it retained", async () => {
  const project = makeProject();
  const { run, stage } = await bootstrap(project);

  // Errors first, then clean calls in the SAME frozen millisecond — the exact
  // condition under which the old naming overwrote the retained errors report.
  const retained = await withFrozenClock(async () => {
    const first = await bvFinalize(run.run_id, stage.stage_id, [ERRORS_FINDING]);
    assert.equal(first.severity, "errors", "the seeding call must be errors");
    const path = first.report_path;

    for (let i = 0; i < 3; i += 1) {
      const r = await bvFinalize(run.run_id, stage.stage_id, [CLEAN_FINDING]);
      assert.equal(r.severity, "clean", "the follow-up calls must be clean");
      assert.equal(r.effective_severity, "errors", "the ratchet must not downgrade");
      assert.equal(r.effective_report_path, path, "the retained path must not move");
    }
    return path;
  });

  // THE POINT. The gate says it retained an errors report; read the file and
  // check that it actually is one. Before the fix, a clean call landing in the
  // same millisecond overwrote this file while every assertion above still
  // passed — the gate's answer and its evidence disagreeing, silently.
  const body = readFileSync(join(project, retained), "utf8");
  assert.match(
    body,
    /500|errors/i,
    `the retained report at ${retained} no longer describes the errors it was retained for. Its content ` +
      `was overwritten by a later clean call — the ratchet reported "errors retained" over clean evidence.`,
  );
  assert.doesNotMatch(
    body,
    /severity:\s*clean/i,
    `the retained report at ${retained} reads as clean; it was overwritten by a later finalize call`,
  );
});

// ── Non-vacuity: prove the reports are actually being written ──────────────
await record("each finalize writes both a findings JSON and a markdown report (non-vacuity)", async () => {
  const project = makeProject();
  const { run, stage } = await bootstrap(project);
  await bvFinalize(run.run_id, stage.stage_id, [ERRORS_FINDING]);
  await bvFinalize(run.run_id, stage.stage_id, [CLEAN_FINDING]);

  // Directory is `browser-validation` (hyphen); the stage-notes KEYS use
  // `browser_validation_*` (underscore). Getting that wrong is how this
  // assertion first failed, and the mismatch is easy to reproduce.
  const dir = join(project, ".harness", run.run_id, "browser-validation");
  const files = readdirSync(dir);
  const reports = files.filter(f => f.startsWith("report-") && f.endsWith(".md"));
  const findings = files.filter(f => f.startsWith("findings-") && f.endsWith(".json"));
  assert.equal(reports.length, 2, `expected 2 report files, found ${JSON.stringify(files)}`);
  assert.equal(findings.length, 2, `expected 2 findings files, found ${JSON.stringify(files)}`);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
