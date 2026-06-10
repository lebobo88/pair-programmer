/**
 * GitHub Copilot CLI fallback for Codex and Gemini sub-CLIs.
 *
 * When the primary CLI (codex or gemini) fails after all retry attempts,
 * `attemptCopilotFallback` retries the same operation through the `copilot`
 * binary. The fallback is transparent to MCP consumers — callers of
 * `pp_codex.generate` / `pp_gemini.critique` etc. receive the same result
 * types regardless of which CLI produced the output.
 *
 * Copilot is spawned in a temp directory (not the project dir) to avoid
 * loading the project's plugin.json and its MCP servers, which adds ~30s
 * of startup overhead.
 */

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { nanoid } from "nanoid";
import { COPILOT_FALLBACK_ENABLED } from "../config.js";
import { runCliWithRetry, trackedExeca, type CliAttempt, type CliRunResult } from "./cli-runner.js";
import { log } from "../util/logger.js";

// ─── Copilot availability probe ─────────────────────────────────────────

let _copilotAvailable: boolean | null = null;

export async function isCopilotAvailable(): Promise<boolean> {
  if (_copilotAvailable !== null) return _copilotAvailable;
  try {
    // trackedExeca so the probe child is registered in ACTIVE_CHILDREN and
    // aborted on shutdown (issue 1: all MCP-path spawns tracked).
    await trackedExeca("copilot", ["--version"], {
      timeout: 5000,
      windowsHide: true,
      reject: true,
    });
    _copilotAvailable = true;
  } catch {
    _copilotAvailable = false;
  }
  log.info({ available: _copilotAvailable }, "copilot CLI availability probe");
  return _copilotAvailable;
}

/** Reset the cached probe (used in tests). */
export function _resetCopilotAvailability(): void {
  _copilotAvailable = null;
}

// ─── Arg builder ────────────────────────────────────────────────────────

export type CopilotMode = "generate" | "critique";

export interface CopilotRunOptions {
  prompt: string;
  cwd: string;
  model: string;
  mode: CopilotMode;
  reasoning_effort?: "low" | "medium" | "high" | "xhigh";
  output_schema?: unknown;
  timeout_ms?: number;
}

export function buildCopilotArgs(opts: CopilotRunOptions): string[] {
  const fallbackDir = join(tmpdir(), `pp-copilot-${nanoid(6)}`);
  mkdirSync(fallbackDir, { recursive: true });

  const args: string[] = [
    "-p", "",
    "--model", opts.model,
    "--output-format", "json",
    "-s",
    "-C", fallbackDir,
    "--no-auto-update",
    "--no-custom-instructions",
    "--disable-builtin-mcps",
    "--no-ask-user",
    "--allow-all-tools",
  ];

  if (opts.reasoning_effort) {
    args.push("--reasoning-effort", opts.reasoning_effort);
  }

  if (opts.mode === "critique") {
    args.push("--deny-tool", "shell", "--deny-tool", "write");
  }

  return args;
}

// ─── JSONL parser ───────────────────────────────────────────────────────

export function parseCopilotJsonl(stdout: string): {
  text?: string;
  tokens_in?: number;
  tokens_out?: number;
  model?: string;
  session_id?: string;
} {
  const out: {
    text?: string;
    tokens_in?: number;
    tokens_out?: number;
    model?: string;
    session_id?: string;
  } = {};

  let deltaText = "";

  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed[0] !== "{") continue;

    let evt: Record<string, unknown>;
    try {
      evt = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      continue;
    }

    const type = evt.type as string | undefined;
    const data = evt.data as Record<string, unknown> | undefined;

    if (!type || !data) {
      // Top-level result event (no nested data)
      if (type === "result") {
        if (typeof evt.sessionId === "string") out.session_id = evt.sessionId;
      }
      continue;
    }

    if (type === "assistant.message" && !type.includes("delta") && !type.includes("start")) {
      if (typeof data.content === "string" && data.content) {
        out.text = data.content;
      }
      if (typeof data.model === "string") {
        out.model = data.model;
      }
      if (typeof data.outputTokens === "number") {
        out.tokens_out = data.outputTokens;
      }
    }

    if (type === "assistant.message_delta") {
      if (typeof data.deltaContent === "string") {
        deltaText += data.deltaContent;
      }
    }

    if (type === "result") {
      if (typeof data.sessionId === "string") out.session_id = data.sessionId;
      // result event may have data wrapper or be top-level
      if (!out.session_id && typeof evt.sessionId === "string") {
        out.session_id = evt.sessionId;
      }
    }
  }

  // Fall back to concatenated deltas if no final message was captured
  if (!out.text && deltaText) {
    out.text = deltaText;
  }

  return out;
}

// ─── Fallback runner ────────────────────────────────────────────────────

export async function runCopilotFallback(opts: CopilotRunOptions): Promise<CliRunResult> {
  let prompt = opts.prompt;

  // Copilot has no --output-schema flag; append schema as a prompt instruction
  if (opts.output_schema) {
    prompt += `\n\nReturn ONLY a JSON object that conforms to this JSON Schema (no prose, no fences):\n${JSON.stringify(opts.output_schema)}\n`;
  }

  const cliArgs = buildCopilotArgs(opts);

  return await runCliWithRetry({
    bin: "copilot",
    cliArgs,
    cwd: opts.cwd,
    vendor: "copilot",
    input: prompt,
    timeout_ms: opts.timeout_ms,
  });
}

// ─── Generic fallback wrapper ───────────────────────────────────────────

export async function attemptCopilotFallback<TResult extends {
  exit_code: number;
  wall_ms: number;
  attempts?: CliAttempt[];
  failure_archive_path?: string;
}>(
  primaryResult: TResult,
  opts: CopilotRunOptions,
  parseResult: (run: CliRunResult) => Partial<TResult>,
): Promise<TResult> {
  if (primaryResult.exit_code === 0) return primaryResult;
  if (!COPILOT_FALLBACK_ENABLED) return primaryResult;

  const available = await isCopilotAvailable();
  if (!available) {
    log.warn("copilot fallback skipped: binary not found on PATH");
    return primaryResult;
  }

  log.info({ model: opts.model, mode: opts.mode }, "attempting copilot CLI fallback");

  const fallbackRun = await runCopilotFallback(opts);

  const mergedAttempts: CliAttempt[] = [
    ...(primaryResult.attempts ?? []),
    ...fallbackRun.attempts,
  ];

  if (fallbackRun.exit_code !== 0) {
    log.warn(
      { exit_code: fallbackRun.exit_code, model: opts.model },
      "copilot fallback also failed",
    );
    return {
      ...primaryResult,
      attempts: mergedAttempts,
      failure_archive_path:
        fallbackRun.failure_archive_path ?? primaryResult.failure_archive_path,
    };
  }

  const parsed = parseResult(fallbackRun);
  return {
    ...primaryResult,
    ...parsed,
    exit_code: 0,
    wall_ms: primaryResult.wall_ms + fallbackRun.wall_ms,
    attempts: mergedAttempts,
    failure_archive_path: undefined,
  };
}
