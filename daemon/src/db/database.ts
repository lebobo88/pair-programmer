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
