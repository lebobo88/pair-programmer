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
  // Every tool call spawns a fresh stdio daemon process (pp_harness isn't
  // pooled), so a `record_verdict` write can land while a sibling process is
  // mid cold-start (new Database, SCHEMA_SQL, applyMigrations) holding an
  // IMMEDIATE write lock. 5000ms was tuned for a single long-lived daemon
  // contending with itself, not for concurrent cold starts; under load it
  // was observed to expire before the lock cleared, silently dropping a
  // PASS verdict. 15000ms gives a concurrent cold-start writer enough room
  // to finish its schema/migration work and release the lock without
  // masking a genuine deadlock (a real deadlock never clears regardless of
  // the timeout value — SQLITE_BUSY retry with backoff, added separately,
  // is what recovers from ordinary lock contention within this window).
  conn.pragma("busy_timeout = 15000");
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
  // v8: engineer self-verification surface (R3-tail post-mortem, 2026-05-21).
  // Stores findings_closed[], findings_unaddressed[], anti_pattern_hits[],
  // and touched_hashes_path so the cross-vendor judge in Fix 1.4 can
  // reconcile engineer self-claims against the on-disk diff. The harness
  // uses presence of findings_closed to gate finalize_stage on a
  // cross-vendor re-judge (Fix 0.2). NULL = legacy attempt or non-engineer
  // producer (no self-claim surface to reconcile against).
  if (!attemptCols.some(c => c.name === "notes_json")) {
    conn.exec("ALTER TABLE attempts ADD COLUMN notes_json TEXT");
  }
  // v9: agent_type provenance (2026-05-23 Hydra dispatch fix). Stores the
  // Claude Code subagent_type the parent driver used (e.g. "engineer",
  // "spec-author", "designer"). NULL = legacy attempt with no subagent
  // recorded. The strict-mode guard in recordAttempt rejects
  // agent_type="general-purpose" unless PP_STRICT_AGENT_TYPE=0 so the
  // Hydra supervisor can't silently downgrade typed dispatch to the
  // generic catch-all subagent — that defect was tracked as eights
  // prop_885cc22f for R6 and is closed by this migration.
  if (!attemptCols.some(c => c.name === "agent_type")) {
    conn.exec("ALTER TABLE attempts ADD COLUMN agent_type TEXT");
  }
  const runCols = conn.prepare("PRAGMA table_info(runs)").all() as Array<{ name: string }>;
  if (!runCols.some(c => c.name === "cli_flags_json")) {
    conn.exec("ALTER TABLE runs ADD COLUMN cli_flags_json TEXT");
  }
  // RA-4: surfaced-run operator ack. acked_at stores the ISO timestamp when an
  // operator explicitly dismissed a surfaced run they preserved-and-merged
  // manually. acked_reason stores the operator's explanation for the audit
  // trail. Both columns are NULL until ack_run is called; banner queries
  // filter WHERE acked_at IS NULL so acknowledged runs disappear from the
  // session startup nag.
  if (!runCols.some(c => c.name === "acked_at")) {
    conn.exec("ALTER TABLE runs ADD COLUMN acked_at TEXT");
  }
  if (!runCols.some(c => c.name === "acked_reason")) {
    conn.exec("ALTER TABLE runs ADD COLUMN acked_reason TEXT");
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
  // v8: evidence_ref column on artifacts (R3-tail post-mortem Fix 1.2,
  // 2026-05-21). When an artifact lives at the project tree (normal
  // path), missability loads it from project_path. When it's archived as
  // a patch under `.harness/<run_id>/<path>` instead, the project-tree
  // load returns empty and missability checks silently fail. evidence_ref
  // lets the producer point at the document that DOES carry the intent
  // (e.g., `docs/decisions/DR-2026-018.md`); missability loads THAT file
  // and runs its regex against THAT content. R3-tail finalize surfaced
  // as 5 false-fail because of this gap.
  if (!artifactCols.some(c => c.name === "evidence_ref")) {
    conn.exec("ALTER TABLE artifacts ADD COLUMN evidence_ref TEXT");
  }
  const artifactColsAfter = conn.prepare("PRAGMA table_info(artifacts)").all() as Array<{ name: string }>;
  if (artifactColsAfter.some(c => c.name === "cell")) {
    conn.exec("CREATE INDEX IF NOT EXISTS idx_artifacts_cell ON artifacts(cell) WHERE cell IS NOT NULL");
  }

  const verdictCols = conn.prepare("PRAGMA table_info(verdicts)").all() as Array<{ name: string }>;
  if (!verdictCols.some(c => c.name === "eights_memory_id")) {
    conn.exec("ALTER TABLE verdicts ADD COLUMN eights_memory_id TEXT");
  }
  // v8: verdict retraction columns (R3-tail post-mortem Fix 1.3,
  // 2026-05-21). A verdict can be retracted when later evidence shows it
  // was wrong — typical R3-tail case: a cross-vendor judge in a late
  // round flagged a finding that turned out to be a HTTP-standard-reading
  // bias (Codex on optional Idempotency-Key) or a baseline hallucination
  // (Gemini citing fixes that were never scoped). Verdicts persist for
  // audit, but retracted ones are skipped by replay queries.
  if (!verdictCols.some(c => c.name === "superseded_by")) {
    conn.exec("ALTER TABLE verdicts ADD COLUMN superseded_by TEXT");
  }
  if (!verdictCols.some(c => c.name === "retracted_reason")) {
    conn.exec("ALTER TABLE verdicts ADD COLUMN retracted_reason TEXT");
  }
  if (!verdictCols.some(c => c.name === "retracted_at")) {
    conn.exec("ALTER TABLE verdicts ADD COLUMN retracted_at TEXT");
  }
  // v8: judge hallucination suspicion flag (R3-tail post-mortem Fix 1.4).
  // Set when a verdict's findings_provenance claims a quoted_text that
  // doesn't appear in the cited file. Doesn't auto-retract — the operator
  // can choose to retract via Fix 1.3 — but flags for HITL review so the
  // hallucination doesn't silently drive downstream gates.
  if (!verdictCols.some(c => c.name === "hallucination_suspected")) {
    conn.exec("ALTER TABLE verdicts ADD COLUMN hallucination_suspected INTEGER NOT NULL DEFAULT 0");
  }
  if (!verdictCols.some(c => c.name === "hallucination_details")) {
    conn.exec("ALTER TABLE verdicts ADD COLUMN hallucination_details TEXT");
  }
  // v9: client-supplied idempotency token on record_verdict. Every tool call
  // spawns a fresh stdio daemon process, so a transport error can arrive
  // after the write already committed; a caller that retries on that error
  // must not create a second verdict row (and must not fire a second
  // writeVerdictMemory into TheEights — the pp-watcher duplicate-memory
  // flood class). The partial unique index allows unlimited legacy rows
  // with idempotency_token IS NULL (pre-v9 rows, and any caller that opts
  // out) while still rejecting a genuine duplicate token.
  if (!verdictCols.some(c => c.name === "idempotency_token")) {
    conn.exec("ALTER TABLE verdicts ADD COLUMN idempotency_token TEXT");
  }
  conn.exec(
    "CREATE UNIQUE INDEX IF NOT EXISTS idx_verdicts_idempotency_token " +
    "ON verdicts(idempotency_token) WHERE idempotency_token IS NOT NULL"
  );

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

const RETRYABLE_SQLITE_CODES = new Set(["SQLITE_BUSY", "SQLITE_BUSY_SNAPSHOT", "SQLITE_LOCKED"]);

/**
 * Heuristic match for SQLite lock-contention errors: a known busy/locked
 * `.code` from better-sqlite3, or (as a fallback for wrapped/rethrown
 * errors that lose the `.code`) a message matching "database is locked" /
 * "database table is locked". It does not attempt to distinguish these
 * from any other error shape that happens to carry the same code or
 * message text, and does not match `SQLITE_CONSTRAINT_UNIQUE` or other
 * validation/constraint failures, which are expected to fail on the first
 * attempt rather than be retried.
 */
function isLockContentionError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const code = (err as { code?: unknown }).code;
  if (typeof code === "string" && RETRYABLE_SQLITE_CODES.has(code)) return true;
  const message = (err as { message?: unknown }).message;
  return typeof message === "string" && /database is locked|database table is locked/i.test(message);
}

/** Synchronous sleep (better-sqlite3 is sync end-to-end; there is no `await` point to yield at here). */
function sleepSync(ms: number): void {
  if (ms <= 0) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Run `fn` inside an IMMEDIATE transaction, retrying with exponential
 * backoff ONLY on genuine SQLite lock-contention errors (SQLITE_BUSY /
 * SQLITE_LOCKED / "database is locked").
 *
 * better-sqlite3's `busy_timeout` pragma already makes SQLite retry
 * internally, at the C level, for up to that many ms before it raises
 * SQLITE_BUSY — this is a second, application-level layer for the case
 * where contention outlives that window (e.g. several fresh daemon
 * processes cold-starting and writing at once, per-call, since pp_harness
 * isn't a pooled long-lived process). It does nothing to a real deadlock:
 * a transaction that can never acquire the lock exhausts `maxAttempts` and
 * re-throws, it does not retry forever.
 *
 * A constraint or validation error is re-thrown on the very first attempt
 * — retrying it would just reproduce the same failure.
 *
 * Wall-time budget (why `maxAttempts` defaults to 3, not 5): every attempt
 * can independently block for up to `busy_timeout` (15000ms, see the
 * `PRAGMA busy_timeout` above) inside SQLite's own busy handler before this
 * function even sees SQLITE_BUSY. Callers of this function (currently just
 * `recordVerdict`) ride the MCP dispatcher's default 120s tool timeout, not
 * a harness-specific long-tool allowance. At 5 attempts the worst case was
 * 5 * 15000ms = 75000ms of pure SQLite blocking, plus backoff sleeps
 * (50+100+200+400ms, ~900ms with jitter) = ~75.9s — 63% of that 120s
 * window, leaving too little headroom for a cold daemon start plus the
 * actual insert/critique work stacked on top, which could reproduce the
 * very timeout this retry layer exists to survive.
 *
 * At the new default of 3 attempts: 3 * 15000ms = 45000ms, plus backoff
 * (50+100ms, ~180ms with jitter) = ~45.2s worst case — 38% of the 120s
 * window, leaving ~75s of headroom. `maxWallMs` (default 60000ms) is a
 * second, explicit backstop: even if `busy_timeout` or `maxAttempts` are
 * changed later, no caller can be retried past 60s of measured wall time
 * (half the dispatcher's 120s budget) — the loop checks elapsed time
 * before each retry sleep and re-throws immediately once the budget is
 * spent, rather than starting an attempt it can't complete in time to
 * still leave headroom.
 */
export function txImmediateWithRetry<T>(
  fn: () => T,
  opts: { maxAttempts?: number; baseDelayMs?: number; maxWallMs?: number } = {},
): T {
  const maxAttempts = opts.maxAttempts ?? 3;
  const baseDelayMs = opts.baseDelayMs ?? 50;
  const maxWallMs = opts.maxWallMs ?? 60_000;
  const startedAt = Date.now();
  for (let attempt = 1; ; attempt++) {
    try {
      return txImmediate(fn);
    } catch (err) {
      if (!isLockContentionError(err) || attempt >= maxAttempts) throw err;
      if (Date.now() - startedAt >= maxWallMs) throw err;
      // Exponential backoff (50, 100, 200, 400ms...) with +/-20% jitter so
      // several sibling processes retrying together don't re-collide in lockstep.
      const delay = baseDelayMs * 2 ** (attempt - 1);
      sleepSync(Math.round(delay * (0.8 + Math.random() * 0.4)));
    }
  }
}
