import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { nanoid } from "nanoid";
import { errorContent, jsonContent, zodToJsonSchema } from "./helpers.js";
import { buildCritiqueOutputSchema, extractJsonValue } from "./critique-schema.js";
import { stabilizeCritiqueResult } from "./critique-bridge.js";
import { wrapUntrusted } from "../security/untrusted-envelope.js";
import { computeCost } from "../util/prices.js";
import { SANDBOX_DIR, ensureDirs } from "../util/paths.js";
import { log } from "../util/logger.js";
import { DEFAULT_MODELS } from "../config.js";
import { runCliWithRetry, type CliAttempt } from "./cli-runner.js";
import { getSession, setSession, synthesizeRecap } from "../orchestrator/sub-cli-sessions.js";

const GenerateSchema = z.object({
  prompt:           z.string().min(1),
  cwd:              z.string().min(1),
  model:            z.string().default(DEFAULT_MODELS.gemini_generate),
  output_schema:    z.unknown().optional(),
  timeout_ms:       z.number().int().positive().optional(),
  untrusted_inputs: z.array(z.object({
    label: z.string(),
    text:  z.string(),
  })).optional(),
    skip_recap: z.boolean().optional(),
});

const CritiqueSchema = z.object({
  artifact_text: z.string().min(1),
  rubric_md:     z.string().min(1),
  cwd:           z.string().min(1),
  model:         z.string().default(DEFAULT_MODELS.gemini_critique),
  output_schema: z.unknown().optional(),
  timeout_ms:    z.number().int().positive().optional(),
});

type GeminiResult = {
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

async function geminiGenerate(args: z.infer<typeof GenerateSchema>): Promise<GeminiResult> {
  ensureDirs();
  const sandboxId = nanoid(8);
  const tmpDir = join(SANDBOX_DIR, `gemini-${sandboxId}`);
  mkdirSync(tmpDir, { recursive: true });

  let prompt = args.prompt;
  if (args.untrusted_inputs && args.untrusted_inputs.length) {
    const wrapped = args.untrusted_inputs.map(u => wrapUntrusted(u.label, u.text)).join("\n\n");
    prompt = `${prompt}\n\n${wrapped}`;
  }

  // Session continuity: resume the prior gemini session for this project if
  // one exists; otherwise inject a recap so cold starts have grounding.
  const existing = getSession(args.cwd, "gemini");
  if (!existing && !args.skip_recap) {
    const recap = synthesizeRecap(args.cwd, "gemini");
    if (recap) prompt = `${recap}\n${prompt}`;
  }

  if (args.output_schema) {
    prompt += `\n\nReturn ONLY a JSON object that conforms to this JSON Schema (no prose, no fences):\n${JSON.stringify(args.output_schema)}\n`;
  }
  // gemini >=0.40 removed --prompt-file. Use `-p ""` to force headless
  // (non-interactive) mode and pipe the prompt via stdin (CLI help:
  // "Appended to input on stdin (if any)."). Avoids Windows 8191-char
  // CMDLINE limit that the file-path workaround was originally for.
  const cliArgs = ["--model", args.model, "-p", "", "--output-format", "json"];
  // Resume flag: gemini CLI uses `--resume <id>`, NOT `--session <uuid>`
  // (which is rejected as "Unknown argument: session"). `--session-id` exists
  // but is for *fresh* sessions seeded with a manual UUID. Resume is the
  // common path for the harness's session-continuity logic.
  if (existing) cliArgs.push("--resume", existing.session_id);

  const run = await runCliWithRetry({
    bin: "gemini",
    cliArgs,
    cwd: args.cwd,
    vendor: "gemini",
    input: prompt,
    timeout_ms: args.timeout_ms,
  });

  const parsed = parseGeminiOutput(run.stdout);
  const tokens_in  = parsed.tokens_in  ?? 0;
  const tokens_out = parsed.tokens_out ?? 0;
  const cost_usd   = computeCost(args.model, tokens_in, tokens_out);
  const text       = parsed.text ?? run.stdout;

  if (parsed.session_id) {
    setSession(args.cwd, "gemini", parsed.session_id);
  }

  let parsedJson: unknown;
  if (args.output_schema) {
    const extracted = extractJsonValue(text);
    if (extracted.found) parsedJson = extracted.value;
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

export async function geminiCritique(args: z.infer<typeof CritiqueSchema>): Promise<GeminiResult> {
  const pinnedModel = DEFAULT_MODELS.gemini_critique;
  if (args.model && args.model !== pinnedModel) {
    process.stderr.write(
      `[pp_gemini.critique] ignoring model="${args.model}" passed by caller; pinning to "${pinnedModel}". The judge agent contract requires this model.\n`,
    );
  }
  const wrappedArtifact = wrapUntrusted("artifact-under-review", args.artifact_text);
  const judgePrompt =
    `You are an impartial cross-vendor judge for the pair-programmer harness. Apply the rubric below to the artifact.\n` +
    `Return a JSON object with fields: outcome ("pass" | "fail" | "revise"), critique_md, and score_entries (an array of { dimension, score } entries where score is numeric 0..1).\n\n` +
    `## Rubric\n${args.rubric_md}\n\n` +
    `## Artifact\n${wrappedArtifact}\n`;
  const useDefaultSchema = !args.output_schema;
  const invoke = async () => await geminiGenerate({
    prompt: judgePrompt,
    cwd: args.cwd,
    model: pinnedModel,
    skip_recap: true,
    output_schema: args.output_schema ?? buildCritiqueOutputSchema(),
    timeout_ms: args.timeout_ms,
  });
  if (!useDefaultSchema) return await invoke();
  return await stabilizeCritiqueResult(invoke, { cwd: args.cwd, vendor: "gemini" });
}

function parseGeminiOutput(stdout: string): {
  text?: string;
  tokens_in?: number;
  tokens_out?: number;
  model?: string;
  session_id?: string;
} {
  const out: { text?: string; tokens_in?: number; tokens_out?: number; model?: string; session_id?: string } = {};
  const trimmed = stdout.trim();
  if (!trimmed) return out;

  const captureSession = (evt: Record<string, unknown>): void => {
    const candidate =
      (typeof evt.session_id === "string" && evt.session_id) ||
      (typeof evt.sessionId === "string" && evt.sessionId) ||
      (typeof (evt.session as { id?: string } | undefined)?.id === "string" && (evt.session as { id?: string }).id) ||
      undefined;
    if (candidate && !out.session_id) out.session_id = candidate as string;
  };

  // Gemini CLI --output-format json may emit one envelope or JSONL events.
  if (trimmed.startsWith("{")) {
    try {
      const evt = JSON.parse(trimmed) as Record<string, unknown>;
      const text = (evt.response ?? evt.text ?? evt.candidates ?? evt.output) as unknown;
      if (typeof text === "string") out.text = text;
      else if (Array.isArray(text)) {
        // candidates: [{ content: { parts: [{ text: "..." }] } }]
        const first = text[0] as { content?: { parts?: Array<{ text?: string }> } } | undefined;
        const part = first?.content?.parts?.[0]?.text;
        if (typeof part === "string") out.text = part;
      }
      const usage = (evt.usageMetadata ?? evt.usage ?? {}) as Record<string, unknown>;
      if (typeof usage.promptTokenCount === "number")     out.tokens_in  = usage.promptTokenCount;
      if (typeof usage.candidatesTokenCount === "number") out.tokens_out = usage.candidatesTokenCount;
      if (typeof evt.modelVersion === "string")           out.model      = evt.modelVersion;
      captureSession(evt);
      return out;
    } catch { /* fall through to JSONL */ }
  }

  let textBuf = "";
  for (const line of trimmed.split(/\r?\n/)) {
    const ln = line.trim();
    if (!ln || ln[0] !== "{") continue;
    try {
      const evt = JSON.parse(ln) as Record<string, unknown>;
      const text = (evt.text ?? evt.delta ?? evt.response) as unknown;
      if (typeof text === "string") textBuf += text;
      const usage = (evt.usageMetadata ?? evt.usage) as Record<string, unknown> | undefined;
      if (usage) {
        if (typeof usage.promptTokenCount === "number")     out.tokens_in  = (out.tokens_in ?? 0) + usage.promptTokenCount;
        if (typeof usage.candidatesTokenCount === "number") out.tokens_out = (out.tokens_out ?? 0) + usage.candidatesTokenCount;
      }
      captureSession(evt);
    } catch { /* ignore */ }
  }
  if (textBuf) out.text = textBuf;
  if (!out.text) out.text = trimmed;
  return out;
}

const TOOLS = [
  {
    name: "generate",
    description:
      "Run the Gemini CLI in headless mode against a working directory. Returns text plus token counts and cost. Pass output_schema (JSON Schema object) to ask for structured JSON. Untrusted inputs are wrapped in a no-instructions XML envelope.",
    schema: GenerateSchema,
    handler: (args: unknown) => geminiGenerate(GenerateSchema.parse(args)),
  },
  {
    name: "critique",
    description:
      "Use Gemini as a cross-vendor judge. Wraps the artifact in an untrusted envelope and applies the rubric_md. Returns a structured verdict (outcome | critique_md | score).",
    schema: CritiqueSchema,
    handler: (args: unknown) => geminiCritique(CritiqueSchema.parse(args)),
  },
];

export async function runGeminiMcpServer(): Promise<void> {
  const server = new Server(
    { name: "pp_gemini", version: "0.1.0" },
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
  log.info("pp_gemini MCP server running on stdio");
}
