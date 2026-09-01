/**
 * force-unlock-staleness.unit.mjs
 *
 * Finding E2-6: `force_unlock` refused to release a `.harness/.lock` whose
 * holder PID (4200) was long dead and whose lock was 10 days old, while the
 * startup janitor swept that exact same file moments later. Two tools in one
 * daemon disagreeing about staleness, with the one named "force" being the
 * one that refuses.
 *
 * forceUnlock must now use the janitor's own staleness rules: dead holder
 * PID, OR age beyond STALE_LOCK_MS (even with a live PID, since PIDs get
 * recycled), OR unparseable metadata. A live holder younger than the
 * threshold is still refused.
 *
 * Real lock files on disk, a really-dead PID (a child process spawned and
 * awaited to exit), real backdated mtimes — no mocks.
 *
 * Tests:
 *   1. Dead holder PID  -> released:true, was_stale:true, file gone.
 *   2. Current process PID, fresh -> released:false, was_stale:false, file kept.
 *   3. Current process PID, older than STALE_LOCK_MS -> released:true,
 *      was_stale:true (parity with the janitor, which sweeps on age alone).
 *   4. No lock file      -> released:true, was_stale:false (idempotent).
 *   5. Unparseable lock  -> released:true, was_stale:true, holder:null.
 *   6. Parity control: a lock forceUnlock refuses is one the janitor also
 *      leaves alone (same threshold constant).
 *
 * Anti-stall contract:
 *   - Direct dist function calls, no MCP server, no daemon socket.
 *   - Isolated PP_HOME and scratch project dirs under the OS temp dir.
 *   - Run: node --test test/force-unlock-staleness.unit.mjs
 */

import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  existsSync,
  rmSync,
  utimesSync,
} from "node:fs";
import assert from "node:assert/strict";
import { describe, it, before } from "node:test";

// Set PP_HOME BEFORE any dist import so nothing touches the real DB.
const SUITE_DIR = mkdtempSync(join(tmpdir(), "pp-force-unlock-"));
mkdirSync(join(SUITE_DIR, ".pair-programmer"), { recursive: true });
process.env.PP_HOME = SUITE_DIR;
process.env.EIGHTS_SKIP_AUDIT_CHECK = "1";

const __dirname = dirname(fileURLToPath(import.meta.url));
const distLock = pathToFileURL(join(__dirname, "..", "dist", "util", "lock.js")).href;

let forceUnlock;
let STALE_LOCK_MS;
let isPidAlive;

before(async () => {
  const mod = await import(distLock);
  forceUnlock = mod.forceUnlock;
  STALE_LOCK_MS = mod.STALE_LOCK_MS;
  isPidAlive = mod.isPidAlive;
});

/** A PID that is guaranteed dead: spawn a child, wait for its exit, reuse it. */
function deadPid() {
  const res = spawnSync(process.execPath, ["-e", "process.exit(0)"], {
    stdio: "ignore",
  });
  assert.equal(res.status, 0, "helper child should exit cleanly");
  assert.ok(typeof res.pid === "number" && res.pid > 0, "helper child should report a pid");
  return res.pid;
}

/** Fresh scratch project with a `.harness/.lock` holding `meta`. */
function projectWithLock(meta, { ageMs = 0 } = {}) {
  const project = mkdtempSync(join(SUITE_DIR, "proj-"));
  const lockPath = join(project, ".harness", ".lock");
  mkdirSync(dirname(lockPath), { recursive: true });
  writeFileSync(
    lockPath,
    typeof meta === "string" ? meta : JSON.stringify(meta, null, 2),
    "utf8",
  );
  if (ageMs > 0) {
    const when = new Date(Date.now() - ageMs);
    utimesSync(lockPath, when, when);
  }
  return { project, lockPath };
}

describe("force_unlock staleness parity with the janitor (E2-6)", () => {
  it("releases a lock whose holder PID is dead, reporting was_stale:true", () => {
    const pid = deadPid();
    assert.equal(isPidAlive(pid), false, "spawned-and-exited pid must probe as dead");

    const { project, lockPath } = projectWithLock({
      pid,
      started_at: new Date().toISOString(),
    });

    const res = forceUnlock(project);

    assert.equal(res.released, true, "dead-PID lock must be released");
    assert.equal(res.was_stale, true, "dead-PID lock must be reported stale");
    assert.equal(res.holder?.pid, pid, "holder metadata must be surfaced");
    assert.equal(existsSync(lockPath), false, "lock file must be gone from disk");
  });

  it("refuses a fresh lock held by the current (live) process", () => {
    const { project, lockPath } = projectWithLock({
      pid: process.pid,
      started_at: new Date().toISOString(),
    });

    const res = forceUnlock(project);

    assert.equal(res.released, false, "a live holder's fresh lock must NOT be released");
    assert.equal(res.was_stale, false, "a live holder's fresh lock is not stale");
    assert.equal(res.holder?.pid, process.pid, "holder metadata must be surfaced");
    assert.equal(existsSync(lockPath), true, "lock file must survive on disk");
  });

  it("releases a live-PID lock that outlived the janitor's threshold", () => {
    const ageMs = STALE_LOCK_MS + 60_000;
    const { project, lockPath } = projectWithLock(
      { pid: process.pid, started_at: new Date(Date.now() - ageMs).toISOString() },
      { ageMs },
    );

    const res = forceUnlock(project);

    assert.equal(res.released, true, "an expired lock must be released even with a live PID");
    assert.equal(res.was_stale, true, "an expired lock must be reported stale");
    assert.equal(existsSync(lockPath), false, "lock file must be gone from disk");
  });

  it("is idempotent when no lock file exists", () => {
    const project = mkdtempSync(join(SUITE_DIR, "proj-none-"));
    const res = forceUnlock(project);
    assert.equal(res.released, true);
    assert.equal(res.was_stale, false);
    assert.equal(res.holder, null);
  });

  it("releases an unparseable lock file", () => {
    const { project, lockPath } = projectWithLock("not json at all");
    const res = forceUnlock(project);
    assert.equal(res.released, true, "unparseable lock has no holder to protect");
    assert.equal(res.was_stale, true);
    assert.equal(res.holder, null);
    assert.equal(existsSync(lockPath), false);
  });

  it("keeps a just-under-threshold live lock (boundary is not off by a sweep)", () => {
    const ageMs = Math.max(0, STALE_LOCK_MS - 60_000);
    const { project, lockPath } = projectWithLock(
      { pid: process.pid, started_at: new Date(Date.now() - ageMs).toISOString() },
      { ageMs },
    );

    const res = forceUnlock(project);

    assert.equal(res.released, false, "under the threshold with a live PID stays locked");
    assert.equal(res.was_stale, false);
    assert.equal(existsSync(lockPath), true);

    rmSync(lockPath, { force: true });
  });
});
