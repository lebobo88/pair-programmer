import Database from "better-sqlite3";
import { DB_PATH, ensureDirs } from "../util/paths.js";
import { SCHEMA_SQL, SCHEMA_VERSION } from "./schema.js";

let _db: Database.Database | null = null;

export function db(): Database.Database {
  if (_db) return _db;
  ensureDirs();
  const conn = new Database(DB_PATH);
  conn.pragma("journal_mode = WAL");
  conn.pragma("foreign_keys = ON");
  conn.pragma("busy_timeout = 5000");
  conn.exec(SCHEMA_SQL);
  applyMigrations(conn);
  conn
    .prepare("INSERT OR REPLACE INTO daemon_meta(key, value) VALUES (?, ?)")
    .run("schema_version", String(SCHEMA_VERSION));
  _db = conn;
  return conn;
}

/**
 * Idempotent ALTER-TABLE migrations for in-place upgrades. SQLite tolerates
 * `ADD COLUMN` only one column at a time. PRAGMA `table_info` lets us check
 * before adding so `CREATE TABLE IF NOT EXISTS` plus this loop together
 * keep both fresh and existing DBs schema-current.
 */
function applyMigrations(conn: Database.Database): void {
  const stageCols = conn.prepare("PRAGMA table_info(stages)").all() as Array<{ name: string }>;
  if (!stageCols.some(c => c.name === "notes_json")) {
    conn.exec("ALTER TABLE stages ADD COLUMN notes_json TEXT");
  }

  // v5: tier-aware Claude delegation.
  const attemptCols = conn.prepare("PRAGMA table_info(attempts)").all() as Array<{ name: string }>;
  if (!attemptCols.some(c => c.name === "attempted_tier")) {
    conn.exec("ALTER TABLE attempts ADD COLUMN attempted_tier TEXT");
  }
  const runCols = conn.prepare("PRAGMA table_info(runs)").all() as Array<{ name: string }>;
  if (!runCols.some(c => c.name === "cli_flags_json")) {
    conn.exec("ALTER TABLE runs ADD COLUMN cli_flags_json TEXT");
  }

  // v7: ecosystem integration columns (Hydra context + Constitution +
  // TheEights handles). All optional — pp degrades to v6 behavior when
  // the ecosystem daemons are absent. Idempotent per column.
  const v7RunCols = [
    "hydra_workflow_id",
    "hydra_envelope_id",
    "hydra_origin_squad",
    "hydra_envelope_type",
    "constitution_sha",
    "constitution_attestation_id",
    "eights_episodic_handle",
    "audit_bom_handle",
  ];
  for (const col of v7RunCols) {
    if (!runCols.some(c => c.name === col)) {
      conn.exec(`ALTER TABLE runs ADD COLUMN ${col} TEXT`);
    }
  }
  // Refresh after mutation so the index check below sees current state.
  const runColsAfter = conn.prepare("PRAGMA table_info(runs)").all() as Array<{ name: string }>;
  if (runColsAfter.some(c => c.name === "hydra_workflow_id")) {
    conn.exec("CREATE INDEX IF NOT EXISTS idx_runs_hydra_workflow ON runs(hydra_workflow_id)");
  }

  const artifactCols = conn.prepare("PRAGMA table_info(artifacts)").all() as Array<{ name: string }>;
  for (const col of ["cell", "eights_memory_id", "eights_handle"]) {
    if (!artifactCols.some(c => c.name === col)) {
      conn.exec(`ALTER TABLE artifacts ADD COLUMN ${col} TEXT`);
    }
  }
  const artifactColsAfter = conn.prepare("PRAGMA table_info(artifacts)").all() as Array<{ name: string }>;
  if (artifactColsAfter.some(c => c.name === "cell")) {
    conn.exec("CREATE INDEX IF NOT EXISTS idx_artifacts_cell ON artifacts(cell) WHERE cell IS NOT NULL");
  }

  const verdictCols = conn.prepare("PRAGMA table_info(verdicts)").all() as Array<{ name: string }>;
  if (!verdictCols.some(c => c.name === "eights_memory_id")) {
    conn.exec("ALTER TABLE verdicts ADD COLUMN eights_memory_id TEXT");
  }

  // CREATE TABLE IF NOT EXISTS already covered by SCHEMA_SQL exec at boot,
  // but be defensive for DBs created at v6 before SCHEMA_SQL included it.
  conn.exec(`
    CREATE TABLE IF NOT EXISTS evolution_proposals (
      id                  TEXT PRIMARY KEY,
      run_id              TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
      resource_rid        TEXT NOT NULL,
      proposed_change     TEXT NOT NULL,
      justification       TEXT NOT NULL,
      signal_count        INTEGER NOT NULL,
      risk_class          TEXT NOT NULL,
      eights_proposal_id  TEXT,
      status              TEXT NOT NULL,
      created_at          TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_evolution_proposals_run    ON evolution_proposals(run_id);
    CREATE INDEX IF NOT EXISTS idx_evolution_proposals_status ON evolution_proposals(status);
  `);
}

export function closeDb(): void {
  if (_db) {
    _db.close();
    _db = null;
  }
}

/** Run a function inside an IMMEDIATE transaction (write lock acquired up front). */
export function txImmediate<T>(fn: () => T): T {
  const conn = db();
  conn.exec("BEGIN IMMEDIATE");
  try {
    const result = fn();
    conn.exec("COMMIT");
    return result;
  } catch (err) {
    try { conn.exec("ROLLBACK"); } catch { /* ignore */ }
    throw err;
  }
}
