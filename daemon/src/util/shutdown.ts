/**
 * Shared, idempotent shutdown helper — PP-RS-3 / PP-RS-4.
 *
 * Called from:
 *   - index.ts SIGTERM/SIGINT handlers          (void shutdownAndExit(...))
 *   - index.ts unhandledRejection/uncaughtException handlers  (PP-RS-4)
 *   - each run*McpServer transport.onclose / stdin "end"      (PP-RS-3)
 *
 * The `shuttingDown` guard makes it safe to call from all those sites
 * simultaneously — only the first invocation does real work; subsequent
 * calls are no-ops.
 *
 * shutdownAndExit is async (PP-RS-3 issue 2): it awaits abortAllInFlightChildren()
 * so project locks are only released after every child has been confirmed dead
 * (SIGTERM → 2 s grace → SIGKILL).  Callers use `void shutdownAndExit(...)`.
 *
 * Cap-hit invariant (PP-RS-3 final): if abortAllInFlightChildren() returns true
 * (any child unconfirmed after ABORT_TOTAL_CAP_MS), ALL locks are conservatively
 * retained rather than released.  Releasing a lock while its child may still be
 * alive violates the "never release lock while child alive" invariant.  The janitor
 * TTL reaper handles retained locks.
 */

import { listActiveLocks } from "./lock.js";
import { log } from "./logger.js";
import { abortAllInFlightChildren, _refuseNewSpawns } from "../mcp/cli-runner.js";

let shuttingDown = false;

/** True once the first shutdownAndExit call has been made. */
export function isShuttingDown(): boolean {
  return shuttingDown;
}

export interface ShutdownOpts {
  /**
   * Whether to call process.exit after cleanup.
   * Default true. Set false only in unit tests that mock process.exit.
   */
  exit?: boolean;
  /** Exit code override. Default: 0 for clean reasons, 1 for crash reasons. */
  exitCode?: number;
}

/**
 * Idempotent async shutdown:
 *   1. Sets `shuttingDown` guard (re-entrant calls return immediately).
 *   2. Awaits abortAllInFlightChildren() — SIGTERM → 2 s grace → SIGKILL.
 *   3. Releases all active project locks — UNLESS any child was unconfirmed at
 *      the cap deadline, in which case ALL locks are retained conservatively.
 *      Releasing a lock while its child may still be alive violates the
 *      "never release lock while child is alive" invariant.  The janitor TTL
 *      reaper handles retained locks.
 *   4. Calls process.exit (unless opts.exit === false).
 *
 * All callers use `void shutdownAndExit(...)` so they do not block on the
 * returned Promise; the guard ensures only one invocation runs to completion.
 */
export async function shutdownAndExit(reason: string, opts: ShutdownOpts = {}): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;

  const { exit = true, exitCode } = opts;

  // Step 0: Refuse all future spawns BEFORE taking the registry snapshot.
  // This closes the post-snapshot spawn race: no new child can be added to
  // ACTIVE_CHILDREN between _refuseNewSpawns() and the Array.from() snapshot
  // inside abortAllInFlightChildren(), so the snapshot is complete-by-construction.
  _refuseNewSpawns();

  // Step 1: Abort in-flight CLI children and wait for confirmed exit.
  // Returns true when any children were unconfirmed-alive at the cap deadline.
  const hadUnconfirmedSurvivors = await abortAllInFlightChildren();

  // Step 2: Release every project lock held by this process — but only when
  // all children were confirmed terminated.  If any survivor remains after the
  // cap, conservatively retain ALL locks: we cannot safely release a lock while
  // the process that holds it may still be running.  The janitor TTL reaper
  // will remove retained locks once the stale-lock window expires.
  const locks = listActiveLocks();
  if (hadUnconfirmedSurvivors) {
    log.error(
      { reason, lock_count: locks.length },
      "shutdown: unconfirmed child(ren) remain after cap — retaining ALL locks for janitor TTL reap",
    );
    for (const lock of locks) {
      log.warn(
        { project_path: lock.projectPath },
        "lock retained — child not confirmed terminated; leaving for janitor TTL reap",
      );
    }
  } else {
    log.info(
      { reason, lock_count: locks.length },
      "shutdown: all children confirmed terminated — releasing project locks",
    );
    for (const lock of locks) {
      try {
        lock.release();
      } catch (err) {
        log.warn(
          { err, project_path: lock.projectPath },
          "shutdown: lock.release failed",
        );
      }
    }
  }

  if (exit) {
    // Use code 1 for crash-class reasons; 0 for clean disconnect/signal.
    const code =
      exitCode !== undefined
        ? exitCode
        : reason === "unhandledRejection" || reason === "uncaughtException"
          ? 1
          : 0;
    process.exit(code);
  }
}
