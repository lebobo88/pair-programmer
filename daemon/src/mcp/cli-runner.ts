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
 */

import { execa, type ExecaError } from "execa";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import {
  CRITIQUE_RETRY_ATTEMPTS,
  CRITIQUE_RETRY_BACKOFF_MS,
  DEFAULT_CLI_TIMEOUT_MS,
} from "../config.js";
import { log } from "../util/logger.js";

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
  vendor: "codex" | "gemini";
  /**
   * If provided, written to the subprocess's stdin (and stdin closed). Use this
   * for codex `exec -` to bypass the Windows 8191-char command-line limit on
   * large prompts. When set, stdio is forced to ["pipe", "pipe", "pipe"].
   */
  input?: string;
  /** Per-call timeout. Falls back to DEFAULT_CLI_TIMEOUT_MS. */
  timeout_ms?: number;
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
      const result = await execa(opts.bin, opts.cliArgs, {
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
    failure_archive_path = archiveFailure(opts, attempts, lastStderr, lastStdout);
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

function archiveFailure(opts: CliRunOptions, attempts: CliAttempt[], stderr: string, stdout: string): string | undefined {
  try {
    const dir = join(opts.cwd, ".harness", "critique_failures");
    mkdirSync(dir, { recursive: true });
    const ts = Date.now();
    const path = join(dir, `${opts.vendor}_${ts}.txt`);
    const sanitizedArgs = opts.cliArgs.map(sanitizePath);
    const totalPromptChars = opts.cliArgs.reduce((n, a) => n + a.length, 0);
    const stdoutTail = stdout.length > 4096 ? stdout.slice(-4096) : stdout;
    const stdoutHeader = stdout.length > 4096
      ? `## stdout (last 4096 of ${stdout.length} chars; codex --json emits errors here)`
      : `## stdout (full; codex --json emits errors here)`;
    const body =
      `# ${opts.vendor} bridge failure\n` +
      `timestamp_unix_ms: ${ts}\n` +
      `cwd: ${sanitizePath(opts.cwd)}\n` +
      `bin: ${opts.bin}\n` +
      `attempts: ${attempts.length}\n` +
      attempts
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
