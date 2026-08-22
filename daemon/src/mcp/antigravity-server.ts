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
import { shutdownAndExit } from "../util/shutdown.js";
import { getSession, setSession, synthesizeRecap } from "../orchestrator/sub-cli-sessions.js";

const GenerateSchema = z.object({
  prompt:           z.string().min(1),
  cwd:              z.string().min(1),
  model:            z.string().default(DEFAULT_MODELS.agy_generate),
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
  model:         z.string().default(DEFAULT_MODELS.agy_critique),
  output_schema: z.unknown().optional(),
  timeout_ms:    z.number().int().positive().optional(),
});

type AntigravityResult = {
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

/**
 * Soft cap on a headless `-p` prompt's length. The Antigravity CLI (agy) has
 * no `--prompt-file` or stdin-based prompt input for print mode (as the old
 * Gemini CLI had via `-p "" ` + stdin) — the full prompt MUST be passed as
 * the literal `-p` argument value. Very large prompts (a full artifact_text +
 * rubric_md for a critique call, for example) risk hitting the Windows
 * command-line length ceiling that historically bit this harness at ~8191
 * chars. There is currently no better alternative in agy, so this is a
 * best-effort warning, not a truncation — truncating would silently corrupt
 * the critique/generate call, which is worse than attempting it as-is.
 */
const PROMPT_LENGTH_WARN_THRESHOLD = 7500;

async function agyGenerate(args: z.infer<typeof GenerateSchema>): Promise<AntigravityResult> {
  ensureDirs();
  const sandboxId = nanoid(8);
  const tmpDir = join(SANDBOX_DIR, `agy-${sandboxId}`);
  mkdirSync(tmpDir, { recursive: true });

  let prompt = args.prompt;
  if (args.untrusted_inputs && args.untrusted_inputs.length) {
    const wrapped = args.untrusted_inputs.map(u => wrapUntrusted(u.label, u.text)).join("\n\n");
    prompt = `${prompt}\n\n${wrapped}`;
  }

  // Session continuity: resume the prior agy conversation for this project if
  // one exists; otherwise inject a recap so cold starts have grounding.
  const existing = getSession(args.cwd, "agy");
  if (!existing && !args.skip_recap) {
    const recap = synthesizeRecap(args.cwd, "agy");
    if (recap) prompt = `${recap}\n${prompt}`;
  }

  if (args.output_schema) {
    prompt += `\n\nReturn ONLY a JSON object that conforms to this JSON Schema (no prose, no fences):\n${JSON.stringify(args.output_schema)}\n`;
  }

  if (prompt.length > PROMPT_LENGTH_WARN_THRESHOLD) {
    log.warn(
      { promptChars: prompt.length, cwd: args.cwd },
      "agy prompt exceeds the safe command-line length threshold — agy has no stdin/file prompt input, so this call risks failing on the OS command-line limit",
    );
  }

  // agy's `-p`/`--print` mode takes the prompt as the flag's OWN argument
  // value and does NOT read stdin when `-p` is present (confirmed against
  // agy 1.1.1: `-p ""` + stdin input errors "empty prompt"; passing the
  // prompt text directly as the `-p` value is the only working invocation).
  // There is also no `--output-format json` flag — headless stdout is plain
  // text (the raw model response), so parseAgyOutput below does not attempt
  // any structured-envelope parsing.
  //
  // `--dangerously-skip-permissions` + `--sandbox`: agy is a full agentic
  // coding CLI (multi-file editing, tool/shell calling), unlike the old
  // Gemini CLI's plain text-completion `-p` mode. Without auto-approval, a
  // prompt that causes agy to reach for a tool call would hang waiting for
  // an interactive confirmation that never comes in this headless daemon
  // context (bounded only by --print-timeout). `--sandbox` restricts
  // terminal command execution as defense-in-depth for critique calls,
  // where the prompt embeds untrusted artifact_text via wrapUntrusted().
  const cliArgs = [
    "--model", args.model,
    "--sandbox",
    "--dangerously-skip-permissions",
    "--print-timeout", `${Math.max(1, Math.ceil((args.timeout_ms ?? 300_000) / 1000))}s`,
  ];
  // Resume flag: agy has no session id in headless stdout to capture, so we
  // track only "has this project talked to agy before" (see
  // sub-cli-sessions.ts) and pass --continue to resume the most recent
  // conversation for this workspace directory.
  if (existing) cliArgs.push("--continue");
  cliArgs.push("-p", prompt);

  const run = await runCliWithRetry({
    bin: "agy",
    cliArgs,
    cwd: args.cwd,
    vendor: "agy",
    timeout_ms: args.timeout_ms,
  });

  const parsed = parseAgyOutput(run.stdout);
  const text = parsed.text ?? run.stdout;
  // Cost-telemetry fallback. agy's headless print mode surfaces no usage
  // envelope at all (no --output-format json equivalent exists), so this
  // char-based estimate (~4 chars/token, OpenAI-style heuristic) is always
  // used rather than being a fallback of last resort as it was for gemini.
  const estimateTokens = (s: string): number => Math.max(1, Math.ceil((s ?? "").length / 4));
  const tokens_in  = estimateTokens(prompt);
  const tokens_out = estimateTokens(text);
  const cost_usd   = computeCost(args.model, tokens_in, tokens_out);

  // No session id is recoverable from plain-text stdout; record a sentinel so
  // future calls for this project know a prior turn happened and pass
  // --continue (see comment above).
  if (run.exit_code === 0) {
    setSession(args.cwd, "agy", "continue");
  }

  let parsedJson: unknown;
  if (args.output_schema) {
    const extracted = extractJsonValue(text);
    if (extracted.found) parsedJson = extracted.value;
  }

  const result: AntigravityResult = {
    text,
    parsed: parsedJson,
    tokens_in,
    tokens_out,
    cost_usd,
    model: args.model,
    wall_ms: run.wall_ms,
    exit_code: run.exit_code,
    session_id: run.exit_code === 0 ? "continue" : undefined,
    resumed: !!existing,
    attempts: run.attempts,
    failure_archive_path: run.failure_archive_path,
  };

  // No copilot fallback: a correctly-attributed failure (non-zero exit_code,
  // preserved attempts and failure_archive_path) is strictly preferable to a
  // silently mis-attributed success. The removed fallback could satisfy a
  // cross-vendor guarantee with the wrong vendor — vendorFor("copilot") ===
  // "openai" makes a copilot critique of a codex attempt genuinely same-vendor,
  // yet was recorded cross_vendor=1. Availability must not be purchased with
  // provenance. (AGY-SILENT-VENDOR-FALLTHROUGH, run_jc1UxeCMvyZR)
  return result;
}

export async function agyCritique(args: z.infer<typeof CritiqueSchema>): Promise<AntigravityResult> {
  const pinnedModel = DEFAULT_MODELS.agy_critique;
  if (args.model && args.model !== pinnedModel) {
    process.stderr.write(
      `[pp_agy.critique] ignoring model="${args.model}" passed by caller; pinning to "${pinnedModel}". The judge agent contract requires this model.\n`,
    );
  }
  const wrappedArtifact = wrapUntrusted("artifact-under-review", args.artifact_text);
  const judgePrompt =
    `You are an impartial cross-vendor judge for the pair-programmer harness. Apply the rubric below to the artifact.\n` +
    `Return a JSON object with fields: outcome ("pass" | "fail" | "revise"), critique_md, and score_entries (an array of { dimension, score } entries where score is numeric 0..1).\n\n` +
    `## Rubric\n${args.rubric_md}\n\n` +
    `## Artifact\n${wrappedArtifact}\n`;
  const useDefaultSchema = !args.output_schema;
  const invoke = async () => await agyGenerate({
    prompt: judgePrompt,
    cwd: args.cwd,
    model: pinnedModel,
    skip_recap: true,
    output_schema: args.output_schema ?? buildCritiqueOutputSchema(),
    timeout_ms: args.timeout_ms,
  });
  if (!useDefaultSchema) return await invoke();
  return await stabilizeCritiqueResult(invoke, { cwd: args.cwd, vendor: "agy" });
}

/**
 * agy's headless `-p`/`--print` mode has no `--output-format json` equivalent
 * — stdout IS the model's raw response text, with no wrapping envelope, no
 * usage metadata, and no session id (unlike the old Gemini CLI's
 * `--output-format json`, which emitted a JSON/JSONL envelope this function
 * used to parse). This is intentionally a pass-through, kept as a named
 * function so future agy versions that add structured output have a single
 * place to extend.
 */
function parseAgyOutput(stdout: string): { text?: string } {
  const trimmed = stdout.trim();
  return trimmed ? { text: trimmed } : {};
}

const TOOLS = [
  {
    name: "generate",
    description:
      "Run the Antigravity CLI (agy) in headless mode against a working directory. Returns text plus token counts and cost. Pass output_schema (JSON Schema object) to ask for structured JSON. Untrusted inputs are wrapped in a no-instructions XML envelope.",
    schema: GenerateSchema,
    handler: (args: unknown) => agyGenerate(GenerateSchema.parse(args)),
  },
  {
    name: "critique",
    description:
      "Use Antigravity (agy) as a cross-vendor judge. Wraps the artifact in an untrusted envelope and applies the rubric_md. Returns a structured verdict (outcome | critique_md | score).",
    schema: CritiqueSchema,
    handler: (args: unknown) => agyCritique(CritiqueSchema.parse(args)),
  },
];

export async function runAntigravityMcpServer(): Promise<void> {
  const server = new Server(
    { name: "pp_agy", version: "0.1.0" },
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
  log.info("pp_agy MCP server running on stdio");

  // PP-RS-3 (issue 3): chain onto any onclose the SDK installed during connect.
  const _sdkOnclose = transport.onclose;
  transport.onclose = () => {
    try { _sdkOnclose?.(); } catch { /* best-effort */ }
    void shutdownAndExit("transport_close");
  };
  process.stdin.once("end", () => void shutdownAndExit("stdin_end"));
}
