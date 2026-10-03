// Phase H (GitHub #49) — schema v11: the execution_events table plus
// runs.surfaced_reason. MED-1 fix (run_p8JPpVhDonUA retry): this file did
// not exist even though schema-v10.unit.mjs's comment already pointed at
// it. It also carries the HIGH-1 fresh-schema proof: a database built
// straight from SCHEMA_SQL — never touched by applyMigrations — must
// already have both v11 objects, because a database that only reaches them
// via the migration is broken the moment someone stands up a brand-new DB
// file (the exact defect HIGH-1 found: SCHEMA_SQL's `runs` table lacked
// `surfaced_reason`, so a fresh DB's StopFailure UPDATE would throw even
// though an upgraded v10 DB worked fine).
//
// Asserts:
//   1. SCHEMA_VERSION has reached 11.
//   2. SCHEMA_SQL (what the daemon actually execs) and schema.sql (the
//      human-readable mirror) both declare execution_events AND
//      runs.surfaced_reason — a drift between the two is HIGH-1's exact
//      failure mode.
//   3. HIGH-1 proof: executing SCHEMA_SQL ALONE (no applyMigrations at all)
//      against a bare temp file yields both objects, and a StopFailure-shaped
//      UPDATE against runs.surfaced_reason succeeds without error.
//   4. A FRESH database opened through the real db() path (SCHEMA_SQL +
//      applyMigrations) has both objects and stamps schema_version = 11.
//   5. AC-H10/AC-H11: a v10-shaped fixture (execution_events absent,
//      runs.surfaced_reason absent, meta stamped 10) upgrades IN PLACE
//      through the real db() path: gains both objects, restamps to 11,
//      and every pre-existing runs/attempts/verdicts row survives
//      unchanged. Running the boot path again against the same file is a
//      no-op (idempotent) — table_info output is identical before/after
//      the second boot.
//   6. AC-H12: PRAGMA foreign_key_list(execution_events) is empty (R5c —
//      run_id is deliberately not a FK).
//
// Runs on temp SQLite files. Criteria 4-6 boot the daemon's real db() path
// in a CHILD node process because PP_DB_PATH is resolved once at module
// load — no daemon server, no MCP peer, just `node -e` (same pattern as
// schema-v10.unit.mjs).

import { strict as assert } from "node:assert";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DIST = join(__dirname, "..", "dist");
const SRC = join(__dirname, "..", "src");

const SUITE_DIR = mkdtempSync(join(tmpdir(), "pp-schema-v11-"));
mkdirSync(join(SUITE_DIR, ".pair-programmer"), { recursive: true });
process.env.PP_HOME = SUITE_DIR;
process.env.EIGHTS_SKIP_AUDIT_CHECK = "1";

const { SCHEMA_VERSION, SCHEMA_SQL } = await import(
  pathToFileURL(join(DIST, "db", "schema.js")).href
);
const { db } = await import(pathToFileURL(join(DIST, "db", "database.js")).href);
const Database = (await import("better-sqlite3")).default;

let passed = 0;
let failed = 0;

function it(label, fn) {
  try {
    fn();
    passed++;
    console.log(`✓ ${label}`);
  } catch (err) {
    failed++;
    console.error(`✗ ${label}`);
    console.error(`  ${err.message}`);
  }
}

const tableInfo = (conn, table) => conn.prepare(`PRAGMA table_info(${table})`).all();
const colNames = (conn, table) => tableInfo(conn, table).map(c => c.name);
const tableExists = (conn, name) =>
  !!conn.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`).get(name);

// ─── 1. Version bumped ───────────────────────────────────────────────────

it("SCHEMA_VERSION has reached 11", () => {
  assert.ok(SCHEMA_VERSION >= 11, "v11 adds execution_events + runs.surfaced_reason (GitHub #49)");
});

// ─── 2. SCHEMA_SQL and schema.sql declare both v11 objects identically ───

it("SCHEMA_SQL declares execution_events AND runs.surfaced_reason", () => {
  assert.ok(SCHEMA_SQL.includes("execution_events"), "SCHEMA_SQL must declare execution_events");
  assert.ok(SCHEMA_SQL.includes("surfaced_reason"), "SCHEMA_SQL must declare runs.surfaced_reason (HIGH-1)");
});

it("schema.sql mirrors SCHEMA_SQL for both v11 objects", () => {
  const sqlPath = join(SRC, "db", "schema.sql");
  assert.ok(existsSync(sqlPath), "schema.sql should exist alongside schema.ts");
  const sql = readFileSync(sqlPath, "utf8");
  assert.ok(sql.includes("execution_events"), "schema.sql must declare execution_events");
  assert.ok(sql.includes("surfaced_reason"), "schema.sql must declare runs.surfaced_reason");
});

// ─── 3. HIGH-1 proof: SCHEMA_SQL ALONE, no applyMigrations at all ────────

it("HIGH-1: a database built from SCHEMA_SQL ALONE (never migrated) has both v11 objects", () => {
  const dir = mkdtempSync(join(tmpdir(), "pp-schema-v11-fresh-"));
  const path = join(dir, "state.db");
  const conn = new Database(path);
  conn.pragma("foreign_keys = ON");
  // Deliberately exec ONLY SCHEMA_SQL — no applyMigrations() call at all —
  // to prove the declared schema is sufficient on its own. If this fails
  // while the full db() path (test below) passes, the defect is back to
  // being "the column only exists after a migration runs", which is
  // exactly what broke a fresh database before the HIGH-1 fix.
  conn.exec(SCHEMA_SQL);

  assert.ok(tableExists(conn, "execution_events"), "SCHEMA_SQL alone must create execution_events");
  assert.ok(
    colNames(conn, "runs").includes("surfaced_reason"),
    "SCHEMA_SQL alone must declare runs.surfaced_reason — this is the HIGH-1 regression check",
  );

  // Prove the StopFailure UPDATE path (dispatcher.ts's surface-api-killed-run)
  // actually works against this fresh, non-migrated database rather than
  // merely having the column present in PRAGMA output.
  conn
    .prepare(
      `INSERT INTO runs(id, project_path, request_text, mode, status, started_at)
       VALUES ('run_fresh_probe', '/tmp/proj', '(test)', 'single', 'running', '2026-01-01T00:00:00.000Z')`,
    )
    .run();
  assert.doesNotThrow(() => {
    conn
      .prepare(`UPDATE runs SET status = 'surfaced', surfaced_reason = ? WHERE id = ? AND status IN ('pending','running')`)
      .run("rate_limit", "run_fresh_probe");
  }, "StopFailure-shaped UPDATE against a SCHEMA_SQL-only database must not throw");
  const row = conn.prepare(`SELECT status, surfaced_reason FROM runs WHERE id = ?`).get("run_fresh_probe");
  assert.equal(row.status, "surfaced");
  assert.equal(row.surfaced_reason, "rate_limit");

  conn.close();
});

// ─── 4. Fresh database via the real db() path ────────────────────────────

it("a FRESH database (real db() path) has both v11 objects and stamps schema_version = 11", () => {
  const conn = db();
  assert.ok(tableExists(conn, "execution_events"), "fresh DB must have execution_events");
  assert.ok(colNames(conn, "runs").includes("surfaced_reason"), "fresh DB runs table must have surfaced_reason");
  const idx = conn.prepare(`PRAGMA index_list(execution_events)`).all().map(i => i.name);
  assert.ok(idx.includes("idx_execution_events_call_key"), "idx_execution_events_call_key must exist");
  assert.ok(idx.includes("idx_execution_events_run"), "idx_execution_events_run must exist");
  assert.ok(idx.includes("idx_execution_events_kind"), "idx_execution_events_kind must exist");
  const meta = conn.prepare("SELECT value FROM daemon_meta WHERE key = 'schema_version'").get();
  assert.equal(meta.value, String(SCHEMA_VERSION));
});

it("AC-H12: execution_events declares no foreign key on run_id (R5c)", () => {
  const conn = db();
  const fks = conn.prepare(`PRAGMA foreign_key_list(execution_events)`).all();
  assert.deepEqual(fks, [], "execution_events must declare zero foreign keys");
});

// ─── 5. In-place upgrade from a v10-shaped fixture ───────────────────────

it("AC-H10/AC-H11: a v10-shaped database upgrades in place, restamps to 11, is idempotent, and loses no row", () => {
  const legacyDir = mkdtempSync(join(tmpdir(), "pp-schema-v11-legacy-"));
  const legacyPath = join(legacyDir, "state.db");

  // Stand up the CURRENT schema so every sibling table/index this DB needs
  // exists, then rebuild `runs` in its pre-v11 shape (no surfaced_reason)
  // and drop execution_events, mirroring schema-v10.unit.mjs's approach of
  // rebuilding only the tables the phase actually changed.
  const legacy = new Database(legacyPath);
  legacy.pragma("journal_mode = WAL");
  legacy.exec(SCHEMA_SQL);
  legacy.pragma("foreign_keys = OFF");
  legacy.exec(`DROP TABLE IF EXISTS execution_events;`);
  legacy.exec(`
    CREATE TABLE runs_v10 (
      id                       TEXT PRIMARY KEY,
      session_id               TEXT,
      project_path             TEXT NOT NULL,
      request_text             TEXT NOT NULL,
      team                     TEXT,
      mode                     TEXT NOT NULL,
      forum                    TEXT,
      n                        INTEGER,
      status                   TEXT NOT NULL,
      profile_snapshot_json    TEXT,
      taxonomy_mapping_json    TEXT,
      head_sha                 TEXT,
      tree_dirty_hash          TEXT,
      cli_versions_json        TEXT,
      cli_flags_json           TEXT,
      hydra_workflow_id        TEXT,
      hydra_envelope_id        TEXT,
      hydra_origin_squad       TEXT,
      hydra_envelope_type      TEXT,
      constitution_sha         TEXT,
      constitution_attestation_id TEXT,
      eights_episodic_handle   TEXT,
      audit_bom_handle         TEXT,
      started_at               TEXT NOT NULL,
      finished_at              TEXT
    );
    -- acked_at/acked_reason are pre-v11 columns added by applyMigrations
    -- (RA-4), not by SCHEMA_SQL — since this fixture is built by execing
    -- SCHEMA_SQL alone (no applyMigrations), the source runs table does
    -- not have them either, so they are intentionally absent here too.
    -- Irrelevant to what v11 changes (execution_events, surfaced_reason).
    INSERT INTO runs_v10 (
      id, session_id, project_path, request_text, team, mode, forum, n, status,
      profile_snapshot_json, taxonomy_mapping_json, head_sha, tree_dirty_hash,
      cli_versions_json, cli_flags_json, hydra_workflow_id, hydra_envelope_id,
      hydra_origin_squad, hydra_envelope_type, constitution_sha,
      constitution_attestation_id, eights_episodic_handle, audit_bom_handle,
      started_at, finished_at
    )
    SELECT
      id, session_id, project_path, request_text, team, mode, forum, n, status,
      profile_snapshot_json, taxonomy_mapping_json, head_sha, tree_dirty_hash,
      cli_versions_json, cli_flags_json, hydra_workflow_id, hydra_envelope_id,
      hydra_origin_squad, hydra_envelope_type, constitution_sha,
      constitution_attestation_id, eights_episodic_handle, audit_bom_handle,
      started_at, finished_at
    FROM runs;
    DROP TABLE runs;
    ALTER TABLE runs_v10 RENAME TO runs;
  `);

  legacy
    .prepare(
      `INSERT INTO runs(id, project_path, request_text, mode, status, started_at)
       VALUES ('run_v10_legacy', '/tmp/proj', '(legacy)', 'single', 'running', '2026-01-01T00:00:00.000Z')`,
    )
    .run();
  legacy
    .prepare(
      `INSERT INTO stages(id, run_id, kind, gate_type, status, started_at)
       VALUES ('stage_v10_legacy', 'run_v10_legacy', 'code', 'code_style', 'passed', '2026-01-01T00:00:00.000Z')`,
    )
    .run();
  legacy
    .prepare(
      `INSERT INTO attempts(id, stage_id, producer, model_id, status, retry_index, created_at)
       VALUES ('attempt_v10_legacy', 'stage_v10_legacy', 'claude', 'claude-sonnet-5', 'ok', 0, '2026-01-01T00:00:00.000Z')`,
    )
    .run();
  legacy
    .prepare(
      `INSERT INTO verdicts(id, attempt_id, judge_producer, judge_model_id, outcome, cross_vendor, created_at)
       VALUES ('verdict_v10_legacy', 'attempt_v10_legacy', 'codex', 'gpt-5.6-terra', 'pass', 1, '2026-01-01T00:00:00.000Z')`,
    )
    .run();
  legacy.prepare("INSERT OR REPLACE INTO daemon_meta(key, value) VALUES ('schema_version', '10')").run();

  // Sanity: the fixture really is v10-shaped.
  assert.ok(!tableExists(legacy, "execution_events"), "fixture must NOT already have execution_events");
  assert.ok(!colNames(legacy, "runs").includes("surfaced_reason"), "fixture must NOT already have runs.surfaced_reason");
  legacy.close();

  const probe = `
    (async () => {
      const { pathToFileURL } = await import("node:url");
      const { db } = await import(pathToFileURL(${JSON.stringify(join(DIST, "db", "database.js"))}).href);
      const conn = db();
      const runCols = conn.prepare("PRAGMA table_info(runs)").all().map(c => c.name);
      const execEventsExists = !!conn.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='execution_events'").get();
      const meta = conn.prepare("SELECT value FROM daemon_meta WHERE key = 'schema_version'").get();
      const runsRow = conn.prepare("SELECT id, status FROM runs WHERE id = 'run_v10_legacy'").get();
      const attemptsRow = conn.prepare("SELECT id, model_id FROM attempts WHERE id = 'attempt_v10_legacy'").get();
      const verdictsRow = conn.prepare("SELECT id, outcome FROM verdicts WHERE id = 'verdict_v10_legacy'").get();
      const runsCount = conn.prepare("SELECT COUNT(*) AS c FROM runs").get().c;
      const attemptsCount = conn.prepare("SELECT COUNT(*) AS c FROM attempts").get().c;
      const verdictsCount = conn.prepare("SELECT COUNT(*) AS c FROM verdicts").get().c;
      const tableInfoBeforeSecondBoot = conn.prepare("PRAGMA table_info(runs)").all();
      process.stdout.write(JSON.stringify({
        runCols, execEventsExists,
        schema_version: meta ? meta.value : null,
        runsRow, attemptsRow, verdictsRow,
        runsCount, attemptsCount, verdictsCount,
        tableInfoBeforeSecondBoot,
      }));
    })();
  `;
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", probe], {
    env: { ...process.env, PP_DB_PATH: legacyPath, PP_HOME: legacyDir, EIGHTS_SKIP_AUDIT_CHECK: "1" },
    encoding: "utf8",
  });
  assert.equal(child.status, 0, `child boot failed:\n${child.stderr}`);
  const report = JSON.parse(child.stdout.trim());

  assert.ok(report.execEventsExists, "upgraded DB must gain execution_events");
  assert.ok(report.runCols.includes("surfaced_reason"), "upgraded DB runs table must gain surfaced_reason");
  assert.equal(report.schema_version, String(SCHEMA_VERSION), `meta row must restamp 10 -> ${SCHEMA_VERSION} in place`);

  // No row lost or rewritten (AC-H10).
  assert.equal(report.runsCount, 1);
  assert.equal(report.attemptsCount, 1);
  assert.equal(report.verdictsCount, 1);
  assert.equal(report.runsRow.id, "run_v10_legacy");
  assert.equal(report.runsRow.status, "running", "pre-existing run's status must be untouched by the migration");
  assert.equal(report.attemptsRow.model_id, "claude-sonnet-5");
  assert.equal(report.verdictsRow.outcome, "pass");

  // Idempotence (AC-H11, R5d): boot again against the now-v11 file and
  // confirm table_info(runs) is byte-identical to what the FIRST boot's
  // post-migration state already was.
  const probe2 = `
    (async () => {
      const { pathToFileURL } = await import("node:url");
      const { db } = await import(pathToFileURL(${JSON.stringify(join(DIST, "db", "database.js"))}).href);
      const conn = db();
      const tableInfoAfterSecondBoot = conn.prepare("PRAGMA table_info(runs)").all();
      const meta = conn.prepare("SELECT value FROM daemon_meta WHERE key = 'schema_version'").get();
      process.stdout.write(JSON.stringify({ tableInfoAfterSecondBoot, schema_version: meta ? meta.value : null }));
    })();
  `;
  const child2 = spawnSync(process.execPath, ["--input-type=module", "-e", probe2], {
    env: { ...process.env, PP_DB_PATH: legacyPath, PP_HOME: legacyDir, EIGHTS_SKIP_AUDIT_CHECK: "1" },
    encoding: "utf8",
  });
  assert.equal(child2.status, 0, `second-boot child failed:\n${child2.stderr}`);
  const report2 = JSON.parse(child2.stdout.trim());
  assert.deepEqual(
    report2.tableInfoAfterSecondBoot,
    report.tableInfoBeforeSecondBoot,
    "re-running the migration path against an already-v11 database must not change PRAGMA table_info(runs) at all",
  );
  assert.equal(report2.schema_version, String(SCHEMA_VERSION));
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
