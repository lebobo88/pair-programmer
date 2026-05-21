import {
  mkdirSync,
  openSync,
  closeSync,
  existsSync,
  rmSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import { projectLockPath } from "./paths.js";

/**
 * Per-project advisory file lock with PID + timestamp metadata.
 *
 * Acquisition writes `{pid, started_at}` JSON to the lock file. On a
 * collision, the caller can ask `acquireOrReapStale(maxAgeMs)` to inspect
 * the existing lock and reap it when:
 *   - the recorded PID is no longer alive, OR
 *   - the lock's `started_at` is older than `maxAgeMs`.
 *
 * This is what unblocks a project whose previous run crashed without
 * releasing — historically operators had to `rm -f .harness/.lock` by hand
 * (or wait 6h for the janitor sweep). The contents are JSON for forward
 * compatibility; old plain-text locks are treated as opaque and only
 * removed via the timestamp path.
 */

export type LockMetadata = {
  pid: number;
  started_at: string;          // ISO 8601
  host?: string;
};

export class ProjectLockBusyError extends Error {
  constructor(
    public readonly projectPath: string,
    public readonly holder: LockMetadata | null,
    public readonly reason: "alive" | "unparseable",
  ) {
    super(
      `project ${projectPath} is locked by ${
        holder ? `pid=${holder.pid} started_at=${holder.started_at}` : "an unparseable lock file"
      }`,
    );
    this.name = "ProjectLockBusyError";
  }
}

/**
 * Process-wide registry of every ProjectLock instance currently holding a
 * lock file. The SIGTERM/SIGINT handler in src/index.ts iterates this set
 * and calls release() on each so a killed daemon doesn't strand its locks
 * for the janitor's 30-min TTL sweep. Instances register on acquire and
 * deregister on release.
 */
const ACTIVE_LOCKS = new Set<ProjectLock>();
export function listActiveLocks(): ProjectLock[] {
  return Array.from(ACTIVE_LOCKS);
}

export class ProjectLock {
  private fd: number | null = null;
  constructor(public readonly projectPath: string) {}

  /** Backwards-compatible strict acquire — throws if the lock exists. */
  acquire(): void {
    const path = projectLockPath(this.projectPath);
    mkdirSync(dirname(path), { recursive: true });
    this.fd = openSync(path, "wx");
    this.writeMetadata(path);
    ACTIVE_LOCKS.add(this);
  }

  /**
   * Try to acquire; if the lock exists, inspect it and reap when stale.
   * Returns `{acquired: true}` on success, or throws `ProjectLockBusyError`
   * when the lock is held by a live process AND younger than `maxAgeMs`.
   */
  acquireOrReapStale(maxAgeMs = 30 * 60 * 1000): { acquired: true; reaped?: LockMetadata } {
    const path = projectLockPath(this.projectPath);
    mkdirSync(dirname(path), { recursive: true });

    try {
      this.fd = openSync(path, "wx");
      this.writeMetadata(path);
      ACTIVE_LOCKS.add(this);
      return { acquired: true };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    }

    const holder = readLockMetadata(path);
    const reapReason = staleReason(holder, maxAgeMs);
    if (!reapReason) throw new ProjectLockBusyError(this.projectPath, holder, "alive");

    // Reap and retry once.
    try { rmSync(path, { force: true }); } catch { /* ignore */ }
    this.fd = openSync(path, "wx");
    this.writeMetadata(path);
    ACTIVE_LOCKS.add(this);
    return { acquired: true, reaped: holder ?? undefined };
  }

  release(): void {
    if (this.fd !== null) {
      closeSync(this.fd);
      this.fd = null;
    }
    const path = projectLockPath(this.projectPath);
    if (existsSync(path)) {
      try { rmSync(path); } catch { /* ignore */ }
    }
    ACTIVE_LOCKS.delete(this);
  }

  private writeMetadata(path: string): void {
    const meta: LockMetadata = {
      pid: process.pid,
      started_at: new Date().toISOString(),
      host: process.env.COMPUTERNAME ?? process.env.HOSTNAME ?? undefined,
    };
    try { writeFileSync(path, JSON.stringify(meta, null, 2), "utf8"); } catch { /* best-effort */ }
  }
}

export type ForceUnlockResult =
  | { released: true; was_stale: boolean; holder: LockMetadata | null }
  | { released: false; was_stale: false; holder: LockMetadata | null };

/**
 * Force-unlock a project lock. Validates the holder PID is dead via the
 * standard `process.kill(pid, 0)` probe before removing the sentinel —
 * refusing to break a live daemon's lock. If no lock file exists, returns
 * released:true with holder:null (idempotent). If the holder is alive,
 * returns released:false so the operator knows another live daemon owns
 * it. P3: paired with the SIGTERM/SIGINT handler in src/index.ts which
 * proactively releases everything held by this process on shutdown.
 */
export function forceUnlock(projectPath: string): ForceUnlockResult {
  const path = projectLockPath(projectPath);
  if (!existsSync(path)) {
    return { released: true, was_stale: false, holder: null };
  }
  const holder = readLockMetadata(path);
  if (holder && isPidAlive(holder.pid)) {
    return { released: false, was_stale: false, holder };
  }
  // Either no parseable metadata or PID is dead — safe to remove.
  try { rmSync(path, { force: true }); } catch { /* ignore */ }
  return { released: true, was_stale: true, holder };
}

export function readLockMetadata(path: string): LockMetadata | null {
  try {
    const raw = readFileSync(path, "utf8");
    if (!raw.trim()) return null;
    const obj = JSON.parse(raw) as Partial<LockMetadata>;
    if (typeof obj.pid !== "number" || typeof obj.started_at !== "string") return null;
    return { pid: obj.pid, started_at: obj.started_at, host: obj.host };
  } catch {
    return null;
  }
}

/**
 * Returns a non-null string if the lock should be reaped, null if it is
 * still considered live. Reaps when PID is dead (any age), or when the
 * lock is older than maxAgeMs regardless of liveness, or when metadata is
 * unparseable AND the file's mtime is older than maxAgeMs.
 */
export function staleReason(holder: LockMetadata | null, maxAgeMs: number): string | null {
  if (!holder) {
    // Unparseable lock — defer to the janitor's mtime sweep; don't reap
    // from this hot path without metadata.
    return null;
  }
  if (!isPidAlive(holder.pid)) return `pid ${holder.pid} not alive`;
  const ageMs = Date.now() - Date.parse(holder.started_at);
  if (Number.isFinite(ageMs) && ageMs > maxAgeMs) return `lock age ${Math.round(ageMs / 1000)}s exceeds ${Math.round(maxAgeMs / 1000)}s`;
  return null;
}

/** Cross-platform "is this pid still running" probe. */
export function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  // Probing your own PID always returns true and is meaningless; treat as
  // alive to avoid self-reaping in tests.
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    // EPERM = process exists but we can't signal it; ESRCH = no such process.
    return code === "EPERM";
  }
}
