/**
 * Shared helpers for the codex/agy MCP servers' subprocess invocations.
 *
 * Two responsibilities:
 *   1. Retry-once on transient subprocess failure (configurable via
 *      CRITIQUE_RETRY_ATTEMPTS / CRITIQUE_RETRY_BACKOFF_MS in config). The
 *      retry is suppressed when stderr matches a "persistent" pattern (model
 *      not found, auth, ENOENT, command-line-too-long) — retrying those just
 *      wastes time.
 *   2. Archive failure context to <cwd>/.harness/critique_failures/ so users
 *      and the judge sub-agent have post-hoc evidence. The path is returned in
 *      the result envelope as `failure_archive_path`.
 *
 * The judge sub-agents receive `exit_code`, `attempts[]`, and
 * `failure_archive_path` in the bridge response and use them to decide whether
 * to retry at the agent layer or surface `judge_tool_failed=true` to the
 * driver. This is defense-in-depth: server retries handle transient infra
 * blips silently; agent halts on truly broken environments.
 *
 * PP-RS-3 (issue 1 + 2): This module maintains a process-wide registry of
 * in-flight child processes and exports:
 *   - trackedExeca()              — drop-in execa wrapper that auto-registers /
 *                                   deregisters; all MCP-path spawns use this.
 *                                   Throws SpawnRefusedError once shutdown begins.
 *   - trackedExecaNoRefuse()      — teardown-safe variant: skips the
 *                                   _spawnRefused guard so worktree cleanup can
 *                                   proceed during shutdown, but still registers
 *                                   the child in ACTIVE_CHILDREN.  Throws
 *                                   SpawnRefusedError once _sealTeardown() is
 *                                   called (the final drain phase).
 *   - abortAllInFlightChildren()  — dynamic drain loop: SIGTERM→SIGKILL each
 *                                   batch, re-snapshot after each pass until
 *                                   empty (catches teardown children spawned
 *                                   mid-drain), then seals teardown so no new
 *                                   children can join after the final pass.
 *                                   While a critical op is in flight the drain
 *                                   uses ABORT_CRITICAL_GRACE_MS (default 10 s)
 *                                   instead of ABORT_GRACEFUL_MS (2 s) before
 *                                   escalating to SIGKILL, allowing small merges
 *                                   to complete atomically.  SIGKILL is always
 *                                   the final backstop.
 *   - enterCriticalOp() /         — bracket a project-root write (git merge /
 *     exitCriticalOp()              cpSync).  The drain loop reads the counter
 *                                   to decide which grace cap to use.
 *   - SpawnRefusedError           — typed sentinel for "daemon shutting down";
 *                                   callers MUST rethrow this before any
 *                                   destructive fallback.
 *   - _activeChildrenSize()       — test-only size accessor.
 */

import { execa, type ExecaError, type Options as ExecaOptions } from "execa";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import {
  CRITIQUE_RETRY_ATTEMPTS,
  CRITIQUE_RETRY_BACKOFF_MS,
  DEFAULT_CLI_TIMEOUT_MS,
} from "../config.js";
import { log } from "../util/logger.js";

// ─── In-flight child-process registry (PP-RS-3, WS7) ─────────────────────────
//
// Shutdown sequence (abortAllInFlightChildren):
//   1. _refuseNewSpawns()   — in-flight trackedExeca calls throw SpawnRefusedError.
//   2. DRAIN LOOP           — repeatedly SIGTERM→SIGKILL ACTIVE_CHILDREN, re-
//                             snapshot after each pass to catch teardown children
//                             spawned between passes.  Loop exits when a pass
//                             completes with an empty registry, or the overall
//                             ABORT_TOTAL_CAP_MS deadline is hit.
//   3. _sealTeardown()      — trackedExecaNoRefuse also throws SpawnRefusedError;
//                             no child can ever join the registry again.
//   4. FINAL DRAIN          — one more pass to confirm the registry is empty
//                             (handles any child spawned between the last loop
//                             pass and the seal).
//   5. Return unconfirmed   — true if any cap-hit survivors remain.
//
// This guarantees that a teardown child spawned between the snapshot and the
// seal is caught by the drain loop (it's in ACTIVE_CHILDREN already), and
// nothing can spawn after the seal.

/** Graceful-shutdown timeout per child: SIGTERM, then wait, then SIGKILL. */
const ABORT_GRACEFUL_MS = 2_000;

/**
 * Extended SIGTERM grace period for children that are inside a CRITICAL SECTION
 * (e.g. an in-flight git merge or copy-mode cpSync into the user's project root).
 * Allows a small merge to complete atomically before SIGKILL is sent.
 * The overall ABORT_TOTAL_CAP_MS still bounds the total shutdown time.
 */
const ABORT_CRITICAL_GRACE_MS = 10_000;

/** Overall cap so shutdown can't hang forever even if many children stall. */
const ABORT_TOTAL_CAP_MS = 15_000;

/** Min remaining time needed before starting another drain pass (ms). */
const DRAIN_PASS_MIN_BUDGET_MS = 100;

/**
 * Count of critical operations currently in flight (e.g. git merge or cpSync
 * into the user's project root).  Incremented by enterCriticalOp() BEFORE the
 * op begins, decremented in the finally block via exitCriticalOp().
 *
 * The drain loop checks this count when deciding whether to escalate from
 * SIGTERM to SIGKILL: as long as _criticalOpInFlight > 0, each child gets
 * ABORT_CRITICAL_GRACE_MS instead of ABORT_GRACEFUL_MS before SIGKILL.
 * SIGKILL is ALWAYS the final backstop once the critical grace cap is exceeded.
 */
let _criticalOpInFlight = 0;

/** Mark entry into a critical section (project-root write). */
export function enterCriticalOp(): void {
  _criticalOpInFlight++;
}

/** Mark exit from a critical section. Always call from a finally block. */
export function exitCriticalOp(): void {
  if (_criticalOpInFlight > 0) _criticalOpInFlight--;
}

/** Returns true while at least one critical op is in flight. */
export function isCriticalOpInFlight(): boolean {
  return _criticalOpInFlight > 0;
}

/** Test-only: returns the raw counter value. */
export function _criticalOpInFlightCount(): number {
  return _criticalOpInFlight;
}

/** Test-only: reset the critical-op counter. NEVER call in production. */
export function _resetCriticalOpForTest(): void {
  _criticalOpInFlight = 0;
}

interface ChildEntry {
  /** Kill the process with the given signal. */
  kill(signal: NodeJS.Signals): void;
  /** Promise that resolves when the process exits (fulfilled or rejected). */
  exitPromise: Promise<unknown>;
  /** OS PID for diagnostic logging; undefined if spawn failed before assignment. */
  pid: number | undefined;
}

const ACTIVE_CHILDREN = new Set<ChildEntry>();

/**
 * Typed sentinel thrown by trackedExeca (always) and trackedExecaNoRefuse
 * (after _sealTeardown).  Callers that catch git errors MUST check
 * `if (err instanceof SpawnRefusedError) throw err` BEFORE taking any
 * destructive fallback action (copy-mode fallback, rmSync, etc.), because a
 * refusal means the daemon is shutting down — not that git failed.
 */
export class SpawnRefusedError extends Error {
  constructor(message = "daemon shutting down — refusing new child spawn") {
    super(message);
    this.name = "SpawnRefusedError";
  }
}

/**
 * Module-level flag set by shutdown.ts BEFORE the drain loop.
 * Once true, trackedExeca throws SpawnRefusedError on every call.
 */
let _spawnRefused = false;

/**
 * Set by abortAllInFlightChildren() AFTER the drain loop empties the registry,
 * BEFORE the final drain pass.  Once true, trackedExecaNoRefuse also throws
 * SpawnRefusedError — sealing the registry so nothing can spawn between the
 * last drain pass and lock release.
 */
let _teardownSealed = false;

/**
 * Called by shutdown.ts (or abortAllInFlightChildren) as the first action.
 * After this returns, trackedExeca throws on every call.
 */
export function _refuseNewSpawns(): void {
  _spawnRefused = true;
}

/**
 * Called by abortAllInFlightChildren() after the drain loop empties the
 * registry.  After this returns, trackedExecaNoRefuse also throws, sealing
 * the registry permanently.
 */
export function _sealTeardown(): void {
  _teardownSealed = true;
}

/**
 * Returns true once shutdown has begun (i.e. _refuseNewSpawns() has been
 * called), including after teardown is sealed.
 *
 * WHY THIS EXISTS — the killed-mid-flight case:
 *   `instanceof SpawnRefusedError` only guards spawns that were REFUSED before
 *   starting.  A git child that was already running when the shutdown drain
 *   sends SIGTERM/SIGKILL rejects as an ordinary ExecaError (killed process),
 *   NOT SpawnRefusedError.  Without this predicate, those kills look like a
 *   genuine git failure and trigger destructive fallbacks (copy-mode, rmSync).
 *
 *   Callers MUST use the combined guard:
 *     if (err instanceof SpawnRefusedError || isShuttingDown()) throw err;
 *   BEFORE any destructive/copy/rmSync fallback.  This covers both:
 *     - refused-before-spawn  → SpawnRefusedError
 *     - killed-mid-flight     → isShuttingDown() === true
 *
 *   Normal (non-shutdown) git failures when isShuttingDown() is false still
 *   take their legitimate fallback (e.g. non-git repo → copy-mode is correct).
 */
export function isShuttingDown(): boolean {
  return _spawnRefused;
}

/**
 * Drop-in replacement for execa() that registers the child process in
 * ACTIVE_CHILDREN for the duration of its execution.  All MCP-path spawns
 * (tdd-gate, artifact-validators, copilot probe, cli-runner retry loop) MUST
 * use this instead of calling execa() directly.
 *
 * Throws SpawnRefusedError synchronously once _refuseNewSpawns() has been
 * called.  Callers MUST use the combined guard
 * `if (err instanceof SpawnRefusedError || isShuttingDown()) throw err`
 * before any destructive fallback — a refusal/kill is not a git/CLI failure,
 * it is a shutdown signal.
 *
 * Returns the same ResultPromise that execa() would return; callers await it
 * exactly as before.
 */
export function trackedExeca(
  file: string,
  args?: readonly string[],
  options?: ExecaOptions,
// eslint-disable-next-line @typescript-eslint/no-explicit-any
): ReturnType<typeof execa<any>> {
  if (_spawnRefused) {
    throw new SpawnRefusedError();
  }
  return _spawnTracked(file, args, options);
}

/**
 * Teardown-safe variant of trackedExeca.
 *
 * WHY THIS EXISTS: worktree cleanup (git worktree remove --force, git branch
 * -D) runs during teardownCandidates() and release(), which can be called while
 * shutdown is already in progress (_spawnRefused=true).  Routing teardown git
 * calls through the refusing trackedExeca would throw and leave orphaned
 * worktrees on disk.  trackedExecaNoRefuse skips the _spawnRefused guard so
 * teardown ALWAYS completes while the drain loop is running.
 *
 * DRAIN LOOP + SEAL contract:
 *   abortAllInFlightChildren() runs a dynamic drain loop that re-snapshots
 *   ACTIVE_CHILDREN after each pass, so any child spawned mid-drain (including
 *   from a teardown callback that the previous pass's SIGTERM triggered) is
 *   caught by the next pass.  Once the loop sees an empty registry, it calls
 *   _sealTeardown() so trackedExecaNoRefuse ALSO throws SpawnRefusedError —
 *   nothing can join after the seal.
 *
 * Both trackedExeca and trackedExecaNoRefuse register identically in
 * ACTIVE_CHILDREN; abortAllInFlightChildren() sees no distinction.
 * janitor.ts is the last-resort sync fallback for worktrees neither path
 * could clean up.
 */
export function trackedExecaNoRefuse(
  file: string,
  args?: readonly string[],
  options?: ExecaOptions,
// eslint-disable-next-line @typescript-eslint/no-explicit-any
): ReturnType<typeof execa<any>> {
  // Sealed after the drain loop empties: nothing may spawn after the final pass.
  if (_teardownSealed) {
    throw new SpawnRefusedError("daemon shutting down — teardown sealed, refusing new child spawn");
  }
  // Intentionally does NOT check _spawnRefused — teardown must proceed while
  // the drain loop is running.
  return _spawnTracked(file, args, options);
}

/**
 * Internal: spawn the child and register it in ACTIVE_CHILDREN.
 * Called by both trackedExeca (after refuse-guard) and trackedExecaNoRefuse
 * (after seal-guard).  Both variants register identically.
 * abortAllInFlightChildren() treats them identically.
 */
function _spawnTracked(
  file: string,
  args?: readonly string[],
  options?: ExecaOptions,
// eslint-disable-next-line @typescript-eslint/no-explicit-any
): ReturnType<typeof execa<any>> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const child = execa(file, args as string[], options as any);
  // Wrap the child promise so we can await exit without .kill() interfering.
  const exitPromise: Promise<unknown> = child.then(
    () => { /* resolved */ },
    () => { /* rejected — process exited non-zero or was killed; that's fine */ },
  );
  const entry: ChildEntry = {
    pid: child.pid,
    kill: (signal) => {
      try { child.kill(signal); } catch { /* best-effort */ }
    },
    exitPromise,
  };
  ACTIVE_CHILDREN.add(entry);
  // Auto-deregister when the process finishes (success or failure).
  void exitPromise.then(() => ACTIVE_CHILDREN.delete(entry));
  return child;
}

/**
 * Terminate all registered in-flight CLI child processes and await confirmed exit.
 *
 * Algorithm (WS7 dynamic drain + seal):
 *
 *   Pre-condition: _refuseNewSpawns() has been called (trackedExeca throws).
 *
 *   DRAIN LOOP (while teardown children may still join):
 *     Repeat until a pass starts with ACTIVE_CHILDREN empty OR the overall
 *     ABORT_TOTAL_CAP_MS deadline is hit:
 *       1. Snapshot the current ACTIVE_CHILDREN.
 *       2. For each entry: SIGTERM → wait ABORT_GRACEFUL_MS → SIGKILL → wait
 *          remaining budget.  Confirmed exits are removed from the set.
 *       3. After the pass, re-check ACTIVE_CHILDREN.  If empty: DONE.
 *          If not: teardown children joined during this pass; loop again.
 *
 *   SEAL:
 *     _sealTeardown() — trackedExecaNoRefuse now also throws SpawnRefusedError.
 *
 *   FINAL DRAIN:
 *     One more pass for children spawned between the last loop pass and the
 *     seal (extremely narrow race; handled for correctness).
 *
 *   RETURN: true if any cap-hit survivors remain in ACTIVE_CHILDREN.
 *     shutdownAndExit conservatively retains locks when any survivor exists.
 *     The janitor TTL reaper will clean up retained locks.
 */
export async function abortAllInFlightChildren(): Promise<boolean> {
  const overallDeadline = Date.now() + ABORT_TOTAL_CAP_MS;

  // ── DRAIN LOOP ────────────────────────────────────────────────────────────
  // Re-snapshot on every iteration so teardown children spawned between passes
  // are caught.  Loop terminates when a pass starts empty (no more children to
  // kill) or the overall deadline is exceeded.
  while (ACTIVE_CHILDREN.size > 0) {
    const remaining = overallDeadline - Date.now();
    if (remaining < DRAIN_PASS_MIN_BUDGET_MS) {
      log.warn("shutdown: ABORT_TOTAL_CAP_MS hit during drain loop; breaking");
      break;
    }

    const entries = Array.from(ACTIVE_CHILDREN);
    log.info({ count: entries.length }, "shutdown: drain pass — aborting in-flight CLI children");

    const passDeadline = overallDeadline; // share the overall deadline across passes

    const perChildTasks = entries.map(async (entry) => {
      // 1. Send SIGTERM.
      entry.kill("SIGTERM");

      // 2. Await real exit, bounded by grace period.
      // If a critical op (project-root merge/copy) is in flight, use the longer
      // ABORT_CRITICAL_GRACE_MS so a small merge can finish atomically before we
      // escalate to SIGKILL.  SIGKILL is always the final backstop.
      const baseGrace = _criticalOpInFlight > 0 ? ABORT_CRITICAL_GRACE_MS : ABORT_GRACEFUL_MS;
      const gracePeriod = Math.min(
        baseGrace,
        Math.max(0, passDeadline - Date.now()),
      );
      if (_criticalOpInFlight > 0) {
        log.info(
          { pid: entry.pid, critical_ops: _criticalOpInFlight, grace_ms: gracePeriod },
          "shutdown: critical op in flight — awaiting extended SIGTERM grace before SIGKILL",
        );
      }
      const exitedAfterTerm = await Promise.race([
        entry.exitPromise.then(() => true),
        sleep(gracePeriod).then(() => false),
      ]);

      if (!exitedAfterTerm) {
        // 3. Grace period expired — escalate to SIGKILL.
        // If a critical op is still in flight here, the critical-grace cap was
        // exceeded; SIGKILL is inevitable.  The caller must detect this and emit
        // a recovery note (see best-of-n.ts mergeInterrupted path).
        log.warn({ pid: entry.pid, critical_ops: _criticalOpInFlight }, "shutdown: child did not exit after SIGTERM grace; sending SIGKILL");
        entry.kill("SIGKILL");

        // 4. Await the REAL exit event after SIGKILL (not a fixed sleep).
        const remainingAfterKill = Math.max(0, passDeadline - Date.now());
        const exitedAfterKill = await Promise.race([
          entry.exitPromise.then(() => true),
          sleep(remainingAfterKill).then(() => false),
        ]);

        if (!exitedAfterKill) {
          // 5. Hard cap hit for this entry — entry remains for survivor detection.
          log.warn(
            { pid: entry.pid },
            "shutdown: child not confirmed terminated before cap; entry retained in registry",
          );
          return;
        }
      }

      // Exit confirmed — remove from the live set.
      ACTIVE_CHILDREN.delete(entry);
    });

    // Apply the pass-level overall cap.
    await Promise.race([
      Promise.allSettled(perChildTasks),
      sleep(Math.max(0, overallDeadline - Date.now())).then(() => {
        log.warn("shutdown: overall cap hit during drain pass; breaking loop");
      }),
    ]);
    // Loop head re-checks ACTIVE_CHILDREN.size; if children were added during
    // this pass (teardown spawning new children), the next iteration catches them.
  }

  // ── SEAL ─────────────────────────────────────────────────────────────────
  // Prevent any further spawns from trackedExecaNoRefuse.  Called here so the
  // seal happens after the drain loop has emptied (or capped out on) the
  // registry.
  _sealTeardown();

  // ── FINAL DRAIN ──────────────────────────────────────────────────────────
  // Extremely narrow window: a child could have been spawned between the last
  // loop pass and the seal above.  One final pass handles that race.
  if (ACTIVE_CHILDREN.size > 0) {
    log.info(
      { count: ACTIVE_CHILDREN.size },
      "shutdown: final drain pass after teardown seal",
    );
    const finalEntries = Array.from(ACTIVE_CHILDREN);
    await Promise.allSettled(
      finalEntries.map(async (entry) => {
        entry.kill("SIGTERM");
        const remainingFinal = Math.max(0, overallDeadline - Date.now());
        const exited = await Promise.race([
          entry.exitPromise.then(() => true),
          sleep(remainingFinal).then(() => false),
        ]);
        if (exited) {
          ACTIVE_CHILDREN.delete(entry);
        } else {
          entry.kill("SIGKILL");
          // Best-effort: don't wait further if deadline is gone.
          const afterKill = Math.max(0, overallDeadline - Date.now());
          const exitedK = await Promise.race([
            entry.exitPromise.then(() => true),
            sleep(afterKill).then(() => false),
          ]);
          if (exitedK) ACTIVE_CHILDREN.delete(entry);
        }
      }),
    );
  }

  // After all passes: any entry still in ACTIVE_CHILDREN is a genuine cap-hit
  // survivor.  Return true so shutdownAndExit retains locks conservatively.
  if (ACTIVE_CHILDREN.size > 0) {
    log.warn(
      { remaining: ACTIVE_CHILDREN.size },
      "shutdown: registry non-empty after drain+seal — cap-hit children not confirmed terminated",
    );
    return true;
  }
  return false;
}

/**
 * TEST-ONLY: inject a fake ChildEntry into ACTIVE_CHILDREN so tests can
 * simulate a child whose exitPromise never settles within the abort cap.
 * Never call this in production code.
 */
export function _registerFakeChildForTest(entry: ChildEntry): void {
  ACTIVE_CHILDREN.add(entry);
}

/** Test-only: returns the current registry size without mutating it. */
export function _activeChildrenSize(): number {
  return ACTIVE_CHILDREN.size;
}

/** Test-only: returns whether new spawns are currently refused. */
export function _isSpawnRefused(): boolean {
  return _spawnRefused;
}

/** Test-only: returns whether teardown has been sealed. */
export function _isTeardownSealed(): boolean {
  return _teardownSealed;
}

/**
 * Test-only: reset all shutdown flags so tests that run sequentially can
 * exercise the full lifecycle more than once.  NEVER call in production code.
 */
export function _resetSpawnRefusedForTest(): void {
  _spawnRefused = false;
  _teardownSealed = false;
  _criticalOpInFlight = 0;
}

/**
 * Stderr substrings that indicate a *persistent* failure where retrying would
 * just produce the same outcome. Auth, missing binary, missing model, etc.
 */
const PERSISTENT_STDERR_PATTERNS = [
  /command line is too long/i,
  /enoent/i,
  /not found/i,
  /eacces/i,
  /authentication failed/i,
  /invalid api key/i,
  /model[^\n]{0,80}not found/i,
  /unsupported model/i,
  /no such model/i,
];

export type CliAttempt = {
  exit_code: number;
  stderr_tail: string;
  wall_ms: number;
  /** "transient" | "persistent" — set after classification, only on failure */
  classification?: "transient" | "persistent";
};

export type CliRunResult = {
  stdout: string;
  stderr: string;
  exit_code: number;
  wall_ms: number;
  attempts: CliAttempt[];
  failure_archive_path?: string;
};

export interface CliRunOptions {
  /** Binary to invoke, e.g. "codex" or "agy". */
  bin: string;
  /** CLI args, including `--model`, `--prompt-file`, etc. */
  cliArgs: string[];
  /** Working directory to spawn the subprocess in (also used for the failure archive). */
  cwd: string;
  /** Vendor tag used in the archive filename and log breadcrumb. */
  vendor: "codex" | "agy" | "copilot";
  /**
   * If provided, written to the subprocess's stdin (and stdin closed). Use this
   * for codex `exec -` to bypass the Windows 8191-char command-line limit on
   * large prompts. When set, stdio is forced to ["pipe", "pipe", "pipe"].
   */
  input?: string;
  /** Per-call timeout. Falls back to DEFAULT_CLI_TIMEOUT_MS. */
  timeout_ms?: number;
}

export interface CliFailureArchiveOptions {
  cwd: string;
  vendor: "codex" | "agy" | "copilot";
  attempts: CliAttempt[];
  stdout: string;
  stderr?: string;
  cliArgs?: string[];
  bin?: string;
  exit_code?: number;
  reason?: string;
}

export function isPersistentStderr(stderr: string): boolean {
  if (!stderr) return false;
  return PERSISTENT_STDERR_PATTERNS.some(re => re.test(stderr));
}

/**
 * Run the sub-CLI with one server-side retry on transient failure. Each
 * attempt's outcome is captured into `attempts[]`. Persistent failures (per
 * `isPersistentStderr`) skip the retry to avoid wasting wall-clock.
 *
 * On final non-zero exit, archives the failure context to
 * <cwd>/.harness/critique_failures/<vendor>_<unix_ms>.txt and returns the
 * path in `failure_archive_path` so callers can include it in their response.
 *
 * Note: this function does not interpret stdout. Callers do their own parsing
 * (Codex JSONL, agy plain text) on the returned stdout.
 */
export async function runCliWithRetry(opts: CliRunOptions): Promise<CliRunResult> {
  const totalAttempts = 1 + Math.max(0, CRITIQUE_RETRY_ATTEMPTS);
  const attempts: CliAttempt[] = [];
  let lastStdout = "";
  let lastStderr = "";
  let lastExit = 0;

  for (let i = 0; i < totalAttempts; i++) {
    const start = Date.now();
    let stdout = "";
    let stderr = "";
    let exitCode = 0;
    try {
      // trackedExeca registers the child in ACTIVE_CHILDREN automatically.
      const result = await trackedExeca(opts.bin, opts.cliArgs, {
        cwd: opts.cwd,
        timeout: opts.timeout_ms ?? DEFAULT_CLI_TIMEOUT_MS,
        reject: false,
        windowsHide: true,
        stdio: opts.input !== undefined ? ["pipe", "pipe", "pipe"] : ["ignore", "pipe", "pipe"],
        ...(opts.input !== undefined ? { input: opts.input } : {}),
      });
      stdout = toStr(result.stdout);
      stderr = toStr(result.stderr);
      exitCode = result.exitCode ?? 0;
    } catch (err) {
      const e = err as ExecaError;
      stdout = toStr(e.stdout);
      stderr = toStr(e.stderr);
      exitCode = (e.exitCode as number | undefined) ?? 1;
    }
    const wall_ms = Date.now() - start;
    const persistent = exitCode !== 0 && isPersistentStderr(stderr);
    attempts.push({
      exit_code: exitCode,
      stderr_tail: stderr.slice(-512),
      wall_ms,
      classification: exitCode === 0 ? undefined : persistent ? "persistent" : "transient",
    });
    lastStdout = stdout;
    lastStderr = stderr;
    lastExit = exitCode;

    if (exitCode === 0) break;

    log.warn(
      { vendor: opts.vendor, exitCode, attempt: i + 1, persistent, stderr_tail: stderr.slice(-512) },
      `${opts.vendor} returned non-zero`
    );

    if (persistent) break;
    if (i === totalAttempts - 1) break;
    await sleep(CRITIQUE_RETRY_BACKOFF_MS);
  }

  let failure_archive_path: string | undefined;
  if (lastExit !== 0) {
    failure_archive_path = archiveCliFailureContext({
      cwd: opts.cwd,
      vendor: opts.vendor,
      attempts,
      stdout: lastStdout,
      stderr: lastStderr,
      cliArgs: opts.cliArgs,
      bin: opts.bin,
      exit_code: lastExit,
    });
  }

  return {
    stdout: lastStdout,
    stderr: lastStderr,
    exit_code: lastExit,
    wall_ms: attempts.reduce((acc, a) => acc + a.wall_ms, 0),
    attempts,
    failure_archive_path,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function toStr(v: unknown): string {
  if (v == null) return "";
  if (typeof v === "string") return v;
  if (Array.isArray(v)) return v.map(item => (typeof item === "string" ? item : "")).join("\n");
  if (v instanceof Uint8Array) return Buffer.from(v).toString("utf8");
  return String(v);
}

export function archiveCliFailureContext(opts: CliFailureArchiveOptions): string | undefined {
  try {
    const dir = join(opts.cwd, ".harness", "critique_failures");
    mkdirSync(dir, { recursive: true });
    const ts = Date.now();
    const path = join(dir, `${opts.vendor}_${ts}.txt`);
    const cliArgs = opts.cliArgs ?? [];
    const sanitizedArgs = cliArgs.map(sanitizePath);
    const totalPromptChars = cliArgs.reduce((n, a) => n + a.length, 0);
    const stdout = opts.stdout ?? "";
    const stderr = opts.stderr ?? "";
    const stdoutTail = stdout.length > 4096 ? stdout.slice(-4096) : stdout;
    const stdoutHeader = stdout.length > 4096
      ? `## stdout (last 4096 of ${stdout.length} chars; codex --json emits errors here)`
      : `## stdout (full; codex --json emits errors here)`;
    const body =
      `# ${opts.vendor} bridge failure\n` +
      `timestamp_unix_ms: ${ts}\n` +
      `cwd: ${sanitizePath(opts.cwd)}\n` +
      (opts.bin ? `bin: ${opts.bin}\n` : "") +
      `attempts: ${opts.attempts.length}\n` +
      (opts.exit_code !== undefined ? `final_exit_code: ${opts.exit_code}\n` : "") +
      (opts.reason ? `bridge_reason: ${opts.reason}\n` : "") +
      opts.attempts
        .map(
          (a, i) =>
            `  attempt[${i}]: exit=${a.exit_code} wall_ms=${a.wall_ms} class=${a.classification ?? "ok"}`
        )
        .join("\n") +
      `\ncli_args_sanitized: ${JSON.stringify(sanitizedArgs)}\n` +
      `cli_args_total_chars: ${totalPromptChars}\n` +
      `\n## stderr (full)\n${stderr}\n` +
      `\n${stdoutHeader}\n${stdoutTail}\n`;
    writeFileSync(path, body, "utf8");
    return path;
  } catch (err) {
    log.warn({ err, vendor: opts.vendor }, "failed to archive critique failure");
    return undefined;
  }
}

/** Replace the user's home dir with `~` so failure archives don't leak it. */
function sanitizePath(s: string): string {
  const home = homedir();
  if (!home) return s;
  return s.split(home).join("~");
}
