import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { nanoid } from "nanoid";
import { errorContent, jsonContent, zodToJsonSchema } from "./helpers.js";
import { buildCritiqueOutputSchema } from "./critique-schema.js";
import { stabilizeCritiqueResult } from "./critique-bridge.js";
import { wrapUntrusted } from "../security/untrusted-envelope.js";
import { computeCost } from "../util/prices.js";
import { SANDBOX_DIR, ensureDirs } from "../util/paths.js";
import { log } from "../util/logger.js";
import { DEFAULT_MODELS } from "../config.js";
import { runCliWithRetry, type CliAttempt } from "./cli-runner.js";
import { getSession, setSession, synthesizeRecap } from "../orchestrator/sub-cli-sessions.js";

// ─── Sandbox policy ──────────────────────────────────────────────────────

const SANDBOX_POLICY = ["read-only", "workspace-write", "danger-full-access"] as const;
type SandboxPolicy = typeof SANDBOX_POLICY[number];

// ─── Schemas ─────────────────────────────────────────────────────────────

const GenerateSchema = z.object({
  prompt:           z.string().min(1),
  cwd:              z.string().min(1),                  // worktree path the daemon already created
  model:            z.string().default(DEFAULT_MODELS.codex_generate),
  sandbox:          z.enum(SANDBOX_POLICY).default("read-only"),
  output_schema:    z.unknown().optional(),             // JSON Schema object; if present, codex --output-schema is used
  timeout_ms:       z.number().int().positive().optional(),
  untrusted_inputs: z.array(z.object({
    label: z.string(),
    text:  z.string(),
  })).optional(),
    skip_recap:       z.boolean().optional(),
    reasoning_effort: z.enum(["minimal", "low", "medium", "high", "xhigh"]).optional(),
});

const CritiqueSchema = z.object({
  artifact_text: z.string().min(1),
  rubric_md:     z.string().min(1),
  cwd:           z.string().min(1),
  model:         z.string().default(DEFAULT_MODELS.codex_critique),
  output_schema: z.unknown().optional(),
  timeout_ms:    z.number().int().positive().optional(),
});

// ─── Tool implementations ────────────────────────────────────────────────

type CodexResult = {
  text: string;
  parsed?: unknown;
  tokens_in: number;
  tokens_out: number;
  cost_usd: number;
  model: string;
  wall_ms: number;
  exit_code: number;
  session_id?: string;
  resumed?: boolean;
  /** Per-call attempt log; ≥1 entry, ≤1 + CRITIQUE_RETRY_ATTEMPTS. */
  attempts?: CliAttempt[];
  /** Path under <cwd>/.harness/critique_failures/ — present only on final non-zero exit. */
  failure_archive_path?: string;
  /** Present when the bridge converted an exit-0 malformed payload into a hard failure. */
  reason?: string;
};

type CodexGenerateInternalOptions = {
  skip_git_repo_check?: boolean;
};

type CodexCliArgOptions = {
  cwd: string;
  sandbox: SandboxPolicy;
  model: string;
  reasoning_effort?: "minimal" | "low" | "medium" | "high" | "xhigh";
  resumeSessionId?: string;
  outputSchemaPath?: string;
  skip_git_repo_check?: boolean;
};

export function buildCodexExecArgs(opts: CodexCliArgOptions): string[] {
  const cliArgs: string[] = ["exec", "--json", "--cd", opts.cwd, "--sandbox", opts.sandbox, "--model", opts.model];
  // The daemon already chooses the target cwd and sandbox; bypass Codex's
  // interactive trust gate for headless MCP runs unless a caller opts out.
  if (opts.skip_git_repo_check ?? true) cliArgs.push("--skip-git-repo-check");
  if (opts.reasoning_effort) cliArgs.push("--config", `model_reasoning_effort=${opts.reasoning_effort}`);
  if (opts.resumeSessionId) cliArgs.push("--resume", opts.resumeSessionId);
  if (opts.outputSchemaPath) cliArgs.push("--output-schema", opts.outputSchemaPath);
  cliArgs.push("-");
  return cliArgs;
}

async function codexGenerate(
  args: z.infer<typeof GenerateSchema>,
  opts: CodexGenerateInternalOptions = {}
): Promise<CodexResult> {
  ensureDirs();
  const sandboxId = nanoid(8);
  const tmpDir = join(SANDBOX_DIR, `codex-${sandboxId}`);
  mkdirSync(tmpDir, { recursive: true });

  let prompt = args.prompt;
  if (args.untrusted_inputs && args.untrusted_inputs.length) {
    const wrapped = args.untrusted_inputs
      .map(u => wrapUntrusted(u.label, u.text))
      .join("\n\n");
    prompt = `${prompt}\n\n${wrapped}`;
  }

  // Session continuity: resume the prior Codex session for this project if
  // one exists, otherwise inject a recap so cold starts have grounding.
  const existing = getSession(args.cwd, "codex");
  let reasoningEffort = args.reasoning_effort;
  // Pin reasoning effort per-invocation when the caller specifies one. The
  // user's ~/.codex/config.toml has `model_reasoning_effort = "xhigh"` as a
  // global default, but critique calls want "high" deterministically. Codex
  // accepts arbitrary config overrides via `--config <key>=<value>`.
  //
  // Belt-and-suspenders: codex CLI 0.128.0 sends the OpenAI API a request
  // that includes default tools (image_gen, web_search), and the API rejects
  // reasoning.effort="minimal" with `400 invalid_request_error`. The error
  // surfaces as a JSONL event on STDOUT (not stderr) before codex exits 1,
  // so without intervention this manifests as an opaque empty-stderr bridge
  // failure. Coerce to "low" (the next supported tier) and warn loudly so
  // any caller that explicitly asked for "minimal" knows we degraded their
  // request — and why. If the user disables the default tools in
  // ~/.codex/config.toml, this can be revisited.
  if (reasoningEffort) {
    if (reasoningEffort === "minimal") {
      process.stderr.write(
        `[pp_codex.generate] reasoning_effort="minimal" is incompatible with codex CLI's default tools (image_gen, web_search) — OpenAI API rejects with 400 invalid_request_error. Coercing to "low".\n`,
      );
      reasoningEffort = "low";
    }
  }
  let resumeSessionId: string | undefined;
  if (existing) {
    resumeSessionId = existing.session_id;
  } else if (!args.skip_recap) {
    const recap = synthesizeRecap(args.cwd, "codex");
    if (recap) prompt = `${recap}\n${prompt}`;
  }
  let outputSchemaPath: string | undefined;
  if (args.output_schema) {
    // Defensive normalization. Some Claude Code drivers pass output_schema
    // as a JSON-encoded string instead of a plain object — that survives
    // the permissive z.unknown() boundary, then JSON.stringify wraps the
    // string in quotes, producing `"\"...\""` on disk. The codex CLI hands
    // that to the OpenAI API, which rejects it with a structured-output
    // schema error. Persistent 5x5 failure with transient classification
    // (no recovery) was observed against ADR critique calls.
    //
    // Normalize: if it's a string, re-parse; if it's neither object nor
    // parseable JSON, fail loudly with a non-transient error.
    let schemaObj: unknown = args.output_schema;
    if (typeof schemaObj === "string") {
      try { schemaObj = JSON.parse(schemaObj); }
      catch (parseErr) {
        throw new Error(
          `pp_codex.generate: output_schema was passed as a string but is not valid JSON ` +
          `(${(parseErr as Error).message}). Pass the JSON Schema as an object, not a stringified one.`,
        );
      }
    }
    if (!schemaObj || typeof schemaObj !== "object" || Array.isArray(schemaObj)) {
      throw new Error(
        `pp_codex.generate: output_schema must be a JSON Schema object (got ${
          schemaObj === null ? "null" : Array.isArray(schemaObj) ? "array" : typeof schemaObj
        }).`,
      );
    }
    const schemaPath = join(tmpDir, "schema.json");
    writeFileSync(schemaPath, JSON.stringify(schemaObj, null, 2), "utf8");
    outputSchemaPath = schemaPath;
  }
  const cliArgs = buildCodexExecArgs({
    cwd: args.cwd,
    sandbox: args.sandbox,
    model: args.model,
    reasoning_effort: reasoningEffort,
    resumeSessionId,
    outputSchemaPath,
    skip_git_repo_check: opts.skip_git_repo_check,
  });

  const run = await runCliWithRetry({
    bin: "codex",
    cliArgs,
    cwd: args.cwd,
    vendor: "codex",
    input: prompt,
    timeout_ms: args.timeout_ms,
  });

  const parsed = parseCodexJsonl(run.stdout);
  const tokens_in  = parsed.tokens_in  ?? 0;
  const tokens_out = parsed.tokens_out ?? 0;
  const cost_usd   = computeCost(args.model, tokens_in, tokens_out);
  const text       = parsed.text ?? run.stdout;

  // Capture session id for continuity. Codex emits this in the session_start
  // event; if we got one, store it under (project_path, "codex").
  if (parsed.session_id) {
    setSession(args.cwd, "codex", parsed.session_id);
  }

  let parsedJson: unknown;
  if (args.output_schema) {
    const trimmed = text.trim();
    if (trimmed) {
      try { parsedJson = JSON.parse(trimmed); } catch { /* leave undefined */ }
    }
  }

  return {
    text,
    parsed: parsedJson,
    tokens_in,
    tokens_out,
    cost_usd,
    model: parsed.model ?? args.model,
    wall_ms: run.wall_ms,
    exit_code: run.exit_code,
    session_id: parsed.session_id,
    resumed: !!existing,
    attempts: run.attempts,
    failure_archive_path: run.failure_archive_path,
  };
}

export async function codexCritique(
  args: z.infer<typeof CritiqueSchema>,
  opts: CodexGenerateInternalOptions = {}
): Promise<CodexResult> {
  // Pin the critique model and reasoning effort regardless of what the
  // sub-agent passes. Sub-agent prompts (judge-cross-vendor / judge-same-
  // vendor) ALSO require gpt-5.4, but Claude Code drivers have repeatedly
  // invented model ids (gpt-5.5, gpt-5-codex, o1, etc.) which the installed
  // codex CLI does not serve, failing the critique with "model not found"
  // and blowing up the run. Belt-and-suspenders: the wrapper enforces.
  const pinnedModel = DEFAULT_MODELS.codex_critique;
  if (args.model && args.model !== pinnedModel) {
    process.stderr.write(
      `[pp_codex.critique] ignoring model="${args.model}" passed by caller; pinning to "${pinnedModel}" (high reasoning). The judge agent contract requires this model.\n`,
    );
  }
  const wrappedArtifact = wrapUntrusted("artifact-under-review", args.artifact_text);
  const judgePrompt =
    `You are an impartial code/spec/design judge. Apply the rubric below to the artifact.\n` +
    `Return a JSON object with fields: outcome ("pass" | "fail" | "revise"), critique_md, and score_entries (an array of { dimension, score } entries where score is numeric 0..1).\n\n` +
    `## Rubric\n${args.rubric_md}\n\n` +
    `## Artifact\n${wrappedArtifact}\n`;
  const useDefaultSchema = !args.output_schema;
  const invoke = async () => await codexGenerate({
    prompt: judgePrompt,
    cwd: args.cwd,
    model: pinnedModel,
    sandbox: "read-only",
    skip_recap: true,
    reasoning_effort: "high",
    output_schema: args.output_schema ?? buildCritiqueOutputSchema(),
    timeout_ms: args.timeout_ms,
  }, opts);
  if (!useDefaultSchema) return await invoke();
  return await stabilizeCritiqueResult(invoke, { cwd: args.cwd, vendor: "codex" });
}

// ─── JSONL parsing ───────────────────────────────────────────────────────
// Codex --json emits one event per line. Different versions vary slightly,
// so we extract defensively: token counts from any field that looks like
// {tokens|usage} on a final event, and concatenate text-bearing events.

export function parseCodexJsonl(stdout: string): {
  text?: string;
  tokens_in?: number;
  tokens_out?: number;
  model?: string;
  session_id?: string;
} {
  const out: { text: string; tokens_in: number; tokens_out: number; model: string | undefined; session_id: string | undefined } = {
    text: "",
    tokens_in: 0,
    tokens_out: 0,
    model: undefined,
    session_id: undefined,
  };
  const lines = stdout.split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed[0] !== "{") continue;
    let evt: Record<string, unknown>;
    try { evt = JSON.parse(trimmed) as Record<string, unknown>; } catch { continue; }

    const t = (evt.type ?? evt.event ?? "") as string;
    const text = extractCodexEventText(evt);
    if (typeof text === "string" && text && (
      t.includes("text") ||
      t.includes("message") ||
      t.includes("output") ||
      t === "item.completed" ||
      t === ""
    )) {
      out.text += text;
    }

    // Capture a session id from any event that carries one. Codex versions
    // vary — common keys are session_id, sessionId, session.id.
    const sessionCandidate =
      (typeof evt.session_id === "string" && evt.session_id) ||
      (typeof evt.sessionId === "string" && evt.sessionId) ||
      (typeof (evt.session as { id?: string } | undefined)?.id === "string" && (evt.session as { id?: string }).id) ||
      undefined;
    if (sessionCandidate && !out.session_id) out.session_id = sessionCandidate as string;

    if (t.includes("complete") || t.includes("usage") || evt.tokens || evt.usage) {
      const usage = (evt.usage ?? evt.tokens ?? evt) as Record<string, unknown>;
      const tin  = num(usage.input_tokens ?? usage.prompt_tokens ?? usage.tokens_in);
      const tout = num(usage.output_tokens ?? usage.completion_tokens ?? usage.tokens_out);
      if (tin  !== null) out.tokens_in  = Math.max(out.tokens_in,  tin);
      if (tout !== null) out.tokens_out = Math.max(out.tokens_out, tout);
      if (typeof evt.model === "string") out.model = evt.model;
    }
  }
  return out.text ? out : { ...out, text: undefined };
}

function extractCodexEventText(evt: Record<string, unknown>): string | undefined {
  const direct = evt.text ?? evt.content ?? evt.delta;
  if (typeof direct === "string" && direct) return direct;

  const item = evt.item as { type?: unknown; text?: unknown; content?: unknown } | undefined;
  if (!item || typeof item !== "object") return undefined;
  if (typeof item.text === "string" && item.text) return item.text;
  if (!Array.isArray(item.content)) return undefined;

  const parts = item.content
    .map(entry => {
      if (!entry || typeof entry !== "object") return "";
      const record = entry as { text?: unknown };
      return typeof record.text === "string" ? record.text : "";
    })
    .filter(Boolean);
  return parts.length ? parts.join("") : undefined;
}

function num(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && /^\d+(\.\d+)?$/.test(v)) return Number(v);
  return null;
}

// ─── MCP server ──────────────────────────────────────────────────────────

const TOOLS = [
  {
    name: "generate",
    description:
      "Run `codex exec` headless against a worktree. Returns text plus token counts and cost. Pass output_schema (JSON Schema object) to constrain the response. Untrusted inputs (file content) should go in `untrusted_inputs` — the daemon wraps them in a no-instructions XML envelope before passing to Codex. Default sandbox is read-only; promote to workspace-write only when the active stage is an editing stage.",
    schema: GenerateSchema,
    handler: (args: unknown) => codexGenerate(GenerateSchema.parse(args)),
  },
  {
    name: "critique",
    description:
      "Use Codex as a judge. Wraps the artifact in an untrusted envelope and applies the rubric_md. Returns a structured verdict (outcome | critique_md | score).",
    schema: CritiqueSchema,
    handler: (args: unknown) => codexCritique(CritiqueSchema.parse(args)),
  },
];

export async function runCodexMcpServer(): Promise<void> {
  const server = new Server(
    { name: "pp_codex", version: "0.1.0" },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOLS.map(t => ({
      name: t.name,
      description: t.description,
      inputSchema: zodToJsonSchema(t.schema),
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: args } = req.params;
    const tool = TOOLS.find(t => t.name === name);
    if (!tool) return errorContent(new Error(`unknown tool: ${name}`));
    try {
      const result = await tool.handler(args ?? {});
      return jsonContent(result);
    } catch (err) {
      return errorContent(err);
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  log.info("pp_codex MCP server running on stdio");
}

// Suppress unused variable warning on `existsSync`/`readFileSync` if not used yet.
void existsSync; void readFileSync;
