// J4 — schema v10: judge-override provenance columns on `verdicts`, and the
// reconciliation of the SCHEMA_VERSION gap.
//
// Asserts:
//   1. SCHEMA_VERSION is 10 (it sat at 7 while database.ts already labelled
//      two migration generations "v8" and "v9" — v10 absorbs both).
//   2. SCHEMA_SQL (the inlined string the daemon actually execs) declares the
//      three columns, AND schema.sql — the human-readable mirror — declares
//      them identically. A drift between the two is the exact defect class
//      this assertion exists to catch.
//   3. A FRESH database has the three columns and stamps daemon_meta
//      schema_version = 10.
//   4. A database created from the PRE-CHANGE verdicts CREATE TABLE (raw SQL,
//      no v10 columns) upgrades IN PLACE: applyMigrations adds the columns,
//      the meta row restamps from 7 to 10, and a pre-existing row survives
//      with NULL provenance (there is no backfill).
//
// Runs on temp SQLite files. Criterion 4 boots the daemon's real db() path in
// a CHILD node process because PP_DB_PATH is resolved once at module load —
// no daemon server, no MCP peer, just `node -e`.

import { strict as assert } from "node:assert";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DIST = join(__dirname, "..", "dist");
const SRC = join(__dirname, "..", "src");

const SUITE_DIR = mkdtempSync(join(tmpdir(), "pp-schema-v10-"));
mkdirSync(join(SUITE_DIR, ".pair-programmer"), { recursive: true });
process.env.PP_HOME = SUITE_DIR;
process.env.EIGHTS_SKIP_AUDIT_CHECK = "1";

const { SCHEMA_VERSION, SCHEMA_SQL } = await import(
  pathToFileURL(join(DIST, "db", "schema.js")).href
);
const { db } = await import(pathToFileURL(join(DIST, "db", "database.js")).href);
const Database = (await import("better-sqlite3")).default;

const V10_COLUMNS = ["judge_reasoning_effort", "judge_model_source", "judge_override_reason"];

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

const cols = (conn, table) =>
  conn.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name);

// ─── 1. Version bumped ───────────────────────────────────────────────────

it("SCHEMA_VERSION is 10", () => {
  assert.equal(
    SCHEMA_VERSION,
    10,
    "v10 reconciles the gap left by the unbumped v8/v9 migration labels in database.ts",
  );
});

// ─── 2. SCHEMA_SQL and schema.sql declare the columns identically ────────

it("SCHEMA_SQL declares all three v10 verdict columns", () => {
  for (const col of V10_COLUMNS) {
    assert.ok(SCHEMA_SQL.includes(col), `SCHEMA_SQL must declare ${col}`);
  }
});

it("schema.sql mirrors SCHEMA_SQL for the three v10 verdict columns", () => {
  const sqlPath = join(SRC, "db", "schema.sql");
  assert.ok(existsSync(sqlPath), "schema.sql should exist alongside schema.ts");
  const sql = readFileSync(sqlPath, "utf8");
  for (const col of V10_COLUMNS) {
    assert.ok(sql.includes(col), `schema.sql must declare ${col} to stay in sync with SCHEMA_SQL`);
  }
});

// ─── 3. Fresh database ───────────────────────────────────────────────────

it("a FRESH database has the three columns and stamps schema_version = 10", () => {
  const conn = db();
  const verdictCols = cols(conn, "verdicts");
  for (const col of V10_COLUMNS) {
    assert.ok(verdictCols.includes(col), `fresh DB verdicts table must have ${col}`);
  }
  const meta = conn
    .prepare("SELECT value FROM daemon_meta WHERE key = 'schema_version'")
    .get();
  assert.equal(meta.value, "10");
});

// ─── 4. In-place upgrade from a pre-change verdicts table ────────────────

it("a PRE-CHANGE database upgrades in place and gains the three columns", () => {
  const legacyDir = mkdtempSync(join(tmpdir(), "pp-schema-v10-legacy-"));
  const legacyPath = join(legacyDir, "state.db");

  // The verdicts CREATE TABLE exactly as it stood before J4 — no
  // judge_reasoning_effort / judge_model_source / judge_override_reason.
  // `attempts` is stubbed only far enough to satisfy the FK; every other table
  // is created by SCHEMA_SQL on boot.
  const legacy = new Database(legacyPath);
  legacy.pragma("journal_mode = WAL");
  // Stand up the CURRENT schema first so every sibling table and index this
  // DB needs exists, then drop `verdicts` and rebuild it in its pre-change
  // shape. Hand-stubbing only `attempts` would leave SCHEMA_SQL's indexes
  // with nothing to bind to on the next boot.
  legacy.exec(SCHEMA_SQL);
  legacy.exec(`
    DROP TABLE IF EXISTS verdicts;
    CREATE TABLE verdicts (
      id                  TEXT PRIMARY KEY,
      attempt_id          TEXT NOT NULL REFERENCES attempts(id) ON DELETE CASCADE,
      judge_producer      TEXT NOT NULL,
      judge_model_id      TEXT NOT NULL,
      rubric_id           TEXT,
      outcome             TEXT NOT NULL,
      critique_md         TEXT,
      score_json          TEXT,
      cross_vendor        INTEGER NOT NULL DEFAULT 0,
      created_at          TEXT NOT NULL
    );
  `);
  // SCHEMA_SQL turns foreign_keys ON; switch it back off on this fixture
  // connection so the orphan attempt_id below is accepted. The row exists
  // purely to prove the ALTER-based migration preserves pre-existing data —
  // standing up a full valid attempt/stage/run chain would add no coverage.
  legacy.pragma("foreign_keys = OFF");
  legacy
    .prepare(
      `INSERT INTO verdicts(id, attempt_id, judge_producer, judge_model_id,
                            outcome, cross_vendor, created_at)
       VALUES ('verdict_legacy', 'att_legacy', 'codex', 'gpt-5.6-terra', 'pass', 1,
               '2026-01-01T00:00:00.000Z')`,
    )
    .run();
  // Stamp the pre-change version so the restamp is observable.
  legacy
    .prepare("INSERT OR REPLACE INTO daemon_meta(key, value) VALUES ('schema_version', '7')")
    .run();

  // Sanity: the fixture really is missing the columns.
  const before = cols(legacy, "verdicts");
  for (const col of V10_COLUMNS) {
    assert.ok(!before.includes(col), `pre-change fixture must NOT already have ${col}`);
  }
  legacy.close();

  // Boot the daemon's REAL db() over that exact file. PP_DB_PATH is read once
  // at paths.js module load, so this has to happen in a child process — the
  // suite's own PP_HOME is already bound.
  const probe = `
    (async () => {
      const { pathToFileURL } = await import("node:url");
      const { db } = await import(pathToFileURL(${JSON.stringify(join(DIST, "db", "database.js"))}).href);
      const conn = db();
      const columns = conn.prepare("PRAGMA table_info(verdicts)").all().map(c => c.name);
      const meta = conn.prepare("SELECT value FROM daemon_meta WHERE key = 'schema_version'").get();
      const row = conn.prepare("SELECT judge_model_source FROM verdicts WHERE id = 'verdict_legacy'").get();
      const count = conn.prepare("SELECT COUNT(*) AS c FROM verdicts").get().c;
      process.stdout.write(JSON.stringify({
        columns,
        schema_version: meta ? meta.value : null,
        legacy_row_count: count,
        legacy_source: row ? row.judge_model_source : "MISSING",
      }));
    })();
  `;
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", probe], {
    env: {
      ...process.env,
      PP_DB_PATH: legacyPath,
      PP_HOME: legacyDir,
      EIGHTS_SKIP_AUDIT_CHECK: "1",
    },
    encoding: "utf8",
  });
  assert.equal(child.status, 0, `child boot failed:\n${child.stderr}`);

  const report = JSON.parse(child.stdout.trim());
  for (const col of V10_COLUMNS) {
    assert.ok(report.columns.includes(col), `upgraded DB verdicts table must have ${col}`);
  }
  assert.equal(report.schema_version, "10", "meta row must restamp 7 -> 10 in place");
  assert.equal(report.legacy_row_count, 1, "the pre-existing verdict row must survive the upgrade");
  assert.equal(
    report.legacy_source,
    null,
    "a legacy row's judge_model_source reads NULL — the migration must not backfill a provenance it cannot know",
  );
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
