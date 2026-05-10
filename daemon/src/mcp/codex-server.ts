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
};

async function codexGenerate(args: z.infer<typeof GenerateSchema>): Promise<CodexResult> {
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
  const cliArgs: string[] = ["exec", "--json", "--cd", args.cwd, "--sandbox", args.sandbox, "--model", args.model];
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
  if (args.reasoning_effort) {
    let effort: typeof args.reasoning_effort = args.reasoning_effort;
    if (effort === "minimal") {
      process.stderr.write(
        `[pp_codex.generate] reasoning_effort="minimal" is incompatible with codex CLI's default tools (image_gen, web_search) — OpenAI API rejects with 400 invalid_request_error. Coercing to "low".\n`,
      );
      effort = "low";
    }
    cliArgs.push("--config", `model_reasoning_effort=${effort}`);
  }
  if (existing) {
    cliArgs.push("--resume", existing.session_id);
  } else if (!args.skip_recap) {
    const recap = synthesizeRecap(args.cwd, "codex");
    if (recap) prompt = `${recap}\n${prompt}`;
  }
  if (args.output_schema) {
    const schemaPath = join(tmpDir, "schema.json");
    writeFileSync(schemaPath, JSON.stringify(args.output_schema, null, 2), "utf8");
    cliArgs.push("--output-schema", schemaPath);
  }
  // Pass the prompt via stdin (using `-` as the explicit stdin marker per
  // `codex exec --help`) instead of as a positional CLI arg. This bypasses the
  // Windows 8191-char CMDLINE limit that previously caused critique calls to
  // fail with "The command line is too long." on artifacts of any real size.
  cliArgs.push("-");

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

async function codexCritique(args: z.infer<typeof CritiqueSchema>): Promise<CodexResult> {
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
    `Return a JSON object with fields: outcome (\"pass\" | \"fail\" | \"revise\"), critique_md, score (a record of rubric dimensions to numeric 0..1).\n\n` +
    `## Rubric\n${args.rubric_md}\n\n` +
    `## Artifact\n${wrappedArtifact}\n`;
  return codexGenerate({
    prompt: judgePrompt,
    cwd: args.cwd,
    model: pinnedModel,
    sandbox: "read-only",
    skip_recap: true,
    reasoning_effort: "high",
    output_schema: args.output_schema ?? {
      type: "object",
      properties: {
        outcome:     { type: "string", enum: ["pass", "fail", "revise"] },
        critique_md: { type: "string" },
        score:       { type: "object", additionalProperties: { type: "number" } },
      },
      required: ["outcome", "critique_md"],
      additionalProperties: false,
    },
    timeout_ms: args.timeout_ms,
  });
}

// ─── JSONL parsing ───────────────────────────────────────────────────────
// Codex --json emits one event per line. Different versions vary slightly,
// so we extract defensively: token counts from any field that looks like
// {tokens|usage} on a final event, and concatenate text-bearing events.

function parseCodexJsonl(stdout: string): {
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
    const text = (evt.text ?? evt.content ?? evt.delta ?? "") as string | undefined;
    if (typeof text === "string" && text && (t.includes("text") || t.includes("message") || t.includes("output") || t === "")) {
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
