/**
 * Shared helpers for the codex/gemini MCP servers' subprocess invocations.
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
 *   - trackedExeca()            — drop-in execa wrapper that auto-registers /
 *                                 deregisters; all MCP-path spawns use this.
 *   - abortAllInFlightChildren() — async: SIGTERM, 2s grace, SIGKILL on
 *                                 timeout; awaits each exit so locks are only
 *                                 released after children are confirmed dead.
 *   - _activeChildrenSize()     — test-only size accessor.
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

// ─── In-flight child-process registry (PP-RS-3, issues 1, 2, post-snapshot) ──
//
// trackedExeca() is the single choke-point: every MCP-triggered subprocess
// goes through it so shutdownAndExit() can SIGTERM → SIGKILL all of them
// before releasing project locks.
//
// Post-snapshot spawn race (PP-RS-3 revision): once shutdown begins, no new
// child is allowed to start.  trackedExeca checks _spawnRefused before calling
// execa() — if true it throws synchronously.  shutdown.ts calls
// _refuseNewSpawns() as its very first action (before the registry snapshot),
// closing the race window entirely.

/** Graceful-shutdown timeout per child: SIGTERM, then wait, then SIGKILL. */
const ABORT_GRACEFUL_MS = 2_000;

/** Overall cap so shutdown can't hang forever even if many children stall. */
const ABORT_TOTAL_CAP_MS = 8_000;

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
 * Module-level flag set by shutdown.ts BEFORE taking the registry snapshot.
 * Once true, trackedExeca refuses all new spawns, making the snapshot complete-
 * by-construction: no child can be added between _refuseNewSpawns() and the
 * Array.from(ACTIVE_CHILDREN) call in abortAllInFlightChildren().
 */
let _spawnRefused = false;

/**
 * Called by shutdown.ts as its first action.  After this returns, trackedExeca
 * throws on every call so no new child can join the registry.
 */
export function _refuseNewSpawns(): void {
  _spawnRefused = true;
}

/**
 * Drop-in replacement for execa() that registers the child process in
 * ACTIVE_CHILDREN for the duration of its execution.  All MCP-path spawns
 * (tdd-gate, artifact-validators, copilot probe, cli-runner retry loop) MUST
 * use this instead of calling execa() directly.
 *
 * Throws synchronously with "daemon shutting down — refusing new child spawn"
 * once _refuseNewSpawns() has been called.  MCP tool handlers already treat a
 * failed CLI spawn as an error result (the execa call is wrapped in try/catch
 * or returns a non-zero exit), so this rejection surfaces gracefully to the
 * caller without crashing the server.
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
    throw new Error("daemon shutting down — refusing new child spawn");
  }
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
 * Algorithm (PP-RS-3 issue 2 — corrected):
 *   For each child still in ACTIVE_CHILDREN at call time:
 *     1. Send SIGTERM.
 *     2. Await its exitPromise with ABORT_GRACEFUL_MS timeout.
 *     3. If not exited: send SIGKILL, then await its exitPromise AGAIN with a
 *        short bounded wait (NOT a fixed sleep — we wait for the real exit event).
 *     4. Remove the entry from ACTIVE_CHILDREN only after its exitPromise settles.
 *     5. If the entry is still not confirmed after the overall ABORT_TOTAL_CAP_MS
 *        deadline, log a warning naming the child and proceed (best-effort).
 *
 * The registry is NOT pre-cleared: entries are removed one-by-one as each child's
 * exit is confirmed, so a concurrent re-entrant call that reaches the size-0 guard
 * is only reached when the set is actually empty.  shutdownAndExit awaits this
 * function before releasing locks, guaranteeing [child exits] → [lock release].
 *
 * Returns true if any children were left UNCONFIRMED at the cap deadline.
 * shutdownAndExit uses this to conservatively retain ALL locks when any survivor
 * exists — releasing a lock while its child may still be alive violates the
 * invariant.  The janitor TTL reaper will clean up retained locks.
 */
export async function abortAllInFlightChildren(): Promise<boolean> {
  if (ACTIVE_CHILDREN.size === 0) return false;
  // Snapshot the live entries.  New entries added concurrently (unlikely during
  // shutdown, but possible) are left in ACTIVE_CHILDREN for the idempotency
  // guard to catch on a hypothetical second call.
  const entries = Array.from(ACTIVE_CHILDREN);
  log.info({ count: entries.length }, "shutdown: aborting in-flight CLI children");

  const overallDeadline = Date.now() + ABORT_TOTAL_CAP_MS;

  const perChildTasks = entries.map(async (entry) => {
    // 1. Send SIGTERM.
    entry.kill("SIGTERM");

    // 2. Await real exit, bounded by grace period.
    const gracePeriod = Math.min(
      ABORT_GRACEFUL_MS,
      Math.max(0, overallDeadline - Date.now()),
    );
    const exitedAfterTerm = await Promise.race([
      entry.exitPromise.then(() => true),
      sleep(gracePeriod).then(() => false),
    ]);

    if (!exitedAfterTerm) {
      // 3. Grace period expired — escalate to SIGKILL.
      log.warn("shutdown: child did not exit after SIGTERM grace; sending SIGKILL");
      entry.kill("SIGKILL");

      // 4. Await the REAL exit event after SIGKILL (not a fixed sleep).
      //    Bound by whatever remains of the overall deadline.
      const remainingAfterKill = Math.max(0, overallDeadline - Date.now());
      const exitedAfterKill = await Promise.race([
        entry.exitPromise.then(() => true),
        sleep(remainingAfterKill).then(() => false),
      ]);

      if (!exitedAfterKill) {
        // 5. Hard cap hit — log and proceed without confirmed exit.
        //    Do NOT remove from set here — entry remains so the caller can
        //    detect that this child is an unconfirmed survivor.
        log.warn(
          { pid: entry.pid },
          "shutdown: child not confirmed terminated before cap; entry retained in registry",
        );
        return;
      }
    }

    // Entry's exit confirmed — remove from the live set.
    ACTIVE_CHILDREN.delete(entry);
  });

  // Apply the overall cap across the whole batch.
  await Promise.race([
    Promise.allSettled(perChildTasks),
    sleep(ABORT_TOTAL_CAP_MS).then(() => {
      log.warn("shutdown: overall ABORT_TOTAL_CAP_MS hit; proceeding");
    }),
  ]);

  // After the sweep: any entry still in ACTIVE_CHILDREN is a genuine cap-hit
  // survivor (not confirmed terminated).  Return true so shutdownAndExit can
  // conservatively retain locks rather than release-under-live-child.
  if (ACTIVE_CHILDREN.size > 0) {
    log.warn(
      { remaining: ACTIVE_CHILDREN.size },
      "shutdown: registry non-empty after abort sweep — cap-hit children not confirmed terminated",
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

/**
 * Test-only: reset the spawn-refused flag so a test that runs after a
 * shutdownAndExit call can still exercise trackedExeca / abortAllInFlightChildren
 * directly.  NEVER call this in production code.
 */
export function _resetSpawnRefusedForTest(): void {
  _spawnRefused = false;
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
  /** Binary to invoke, e.g. "codex" or "gemini". */
  bin: string;
  /** CLI args, including `--model`, `--prompt-file`, etc. */
  cliArgs: string[];
  /** Working directory to spawn the subprocess in (also used for the failure archive). */
  cwd: string;
  /** Vendor tag used in the archive filename and log breadcrumb. */
  vendor: "codex" | "gemini" | "copilot";
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
  vendor: "codex" | "gemini" | "copilot";
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
 * (Codex JSONL, Gemini text/JSON) on the returned stdout.
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
