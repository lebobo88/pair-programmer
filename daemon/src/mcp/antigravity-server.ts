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
import {
  DEFAULT_MODELS,
  JUDGE_REASONING_EFFORTS,
  JUDGE_OVERRIDE_SOURCES,
  resolveJudgeSelection,
  type JudgeReasoningEffort,
  type JudgeOverrideSource,
} from "../config.js";
import { resolveAgyInvocation } from "./agy-model.js";
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
  /**
   * Reasoning effort, for parity with pp_codex.generate. agy encodes effort in
   * the model id itself, so this is folded into the canonical id by
   * `resolveAgyInvocation` — `--effort` is NEVER passed on the command line
   * (a suffixed id plus `--effort` is a hard CLI error).
   */
  reasoning_effort: z.enum(JUDGE_REASONING_EFFORTS).optional(),
  /**
   * Start a NEW agy conversation instead of resuming this project's prior one.
   * Set by critique, which must be a stateless adjudication -- see the
   * `--continue` comment below.
   */
  fresh_session: z.boolean().optional(),
});

/**
 * Shared critique option surface (J5) — IDENTICAL to `pp_codex.critique`'s.
 * A judge call must read the same way whichever vendor serves it.
 *
 * `model` is optional with NO default: omitting it takes agy's pinned default
 * via `resolveJudgeSelection`. A model or effort outside the vendor allow-list
 * is REJECTED LOUDLY (throws) rather than silently discarded, and any selection
 * deviating from the pin requires both `override_source` and a non-empty
 * `override_reason`.
 */
const CritiqueSchema = z.object({
  artifact_text:    z.string().min(1),
  rubric_md:        z.string().min(1),
  cwd:              z.string().min(1),
  model:            z.string().optional(),
  reasoning_effort: z.enum(JUDGE_REASONING_EFFORTS).optional(),
  escalate:         z.boolean().optional(),
  override_source:  z.enum(JUDGE_OVERRIDE_SOURCES).optional(),
  override_reason:  z.string().optional(),
  output_schema:    z.unknown().optional(),
  timeout_ms:       z.number().int().positive().optional(),
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
  /**
   * Resolved judge reasoning effort (critique path). agy encodes effort in the
   * model id, so this mirrors the suffix of `model`.
   */
  reasoning_effort?: JudgeReasoningEffort;
  /** Provenance of the resolved judge selection (critique path only). */
  override_source?: JudgeOverrideSource;
  /** Operator justification carried alongside a non-default selection. */
  override_reason?: string;
  /**
   * agy's headless stream-json envelope reports no served model id, so unlike
   * the codex lane there is nothing to compare the pin against. Left undefined.
   */
  model_reported_by_cli?: string;
};

/**
 * Test-only DI seam for `agyCritique`, mirroring `CodexGenerateInternalOptions`
 * (codex-server.ts). When provided, `_invoke` replaces the real `agyGenerate`
 * call so tests can capture the resolved `genArgs` without spawning the agy
 * CLI. Production code never sets this.
 */
export type AgyCritiqueInternalOptions = {
  _invoke?: (genArgs: z.infer<typeof GenerateSchema>) => Promise<AntigravityResult>;
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
  //
  // agy serves EFFORT-SUFFIXED model ids and rejects a suffixed id combined
  // with `--effort`. `resolveAgyInvocation` collapses (model, reasoning_effort)
  // into ONE canonical served id, so a bare family or a family+effort pair is
  // canonicalized here and `--effort` is never emitted. An unserved id throws
  // rather than being guessed at — a wrong guess lands in the cost ledger as
  // provenance.
  const invocation = resolveAgyInvocation({
    model: args.model,
    reasoning_effort: args.reasoning_effort,
  });
  const effectiveModel = invocation.model_id;

  const cliArgs = [
    "--model", effectiveModel,
    "--sandbox",
    "--dangerously-skip-permissions",
    "--print-timeout", `${Math.max(1, Math.ceil((args.timeout_ms ?? 300_000) / 1000))}s`,
  ];
  // Resume flag: agy has no session id in headless stdout to capture, so we
  // track only "has this project talked to agy before" (see
  // sub-cli-sessions.ts) and pass --continue to resume the most recent
  // conversation for this workspace directory.
  // 2026-08-23. `--continue` resumes THIS PROJECT'S most recent agy
  // conversation, and the sentinel that triggers it is written on every
  // exit_code===0 -- so once a project has talked to agy once, every later
  // call resumes an ever-growing conversation. Two failures follow:
  //
  //   CORRECTNESS, and this is the serious one. A cross-vendor critique must
  //   be an INDEPENDENT adjudication. Resuming means judge N+1 sees judge N's
  //   conversation, so a verdict is contaminated by whatever artifact was
  //   judged before it -- the opposite of what cross-vendor judging is for.
  //
  //   LIVENESS. Observed today: a resumed conversation came back at
  //   step_index 15 emitting only step_update events and never reaching a
  //   `result`, so the bridge saw empty stdout, exited in ~40ms and reported
  //   the uninformative "empty output". The identical prompt WITHOUT
  //   `--continue` returned SUCCESS immediately.
  //
  // So callers that need a stateless turn pass fresh_session.
  if (existing && !args.fresh_session) cliArgs.push("--continue");

  // 2026-08-23. The prompt goes over STDIN, not as an argv value.
  //
  // The old form was `-p <prompt>`, which puts the entire prompt in one argv
  // element. Windows caps a process command line at 32,767 characters, so any
  // critique prompt longer than that died with "Argument list too long" —
  // surfacing as exit 0 with EMPTY STDOUT in ~46ms, which the bridge reported
  // as the uninformative "empty output". Reproduced exactly: 30,000 chars
  // succeeds, 40,000 chars fails. A cross-vendor judge prompt carrying a spec
  // plus an artifact clears 32k routinely, so the cross-vendor gate lost its
  // second vendor precisely on the largest and most important reviews.
  //
  // agy 1.1.19 supports `--input-format stream-json`, which reads one NDJSON
  // message per line from stdin and requires `--output-format stream-json`.
  // That removes the length ceiling entirely. (The previous comment here —
  // "agy has no stdin/file prompt input" and "there is also no
  // --output-format json flag" — was true of an older agy and is now stale;
  // `agy --help` lists both.)
  //
  // Wire format, established empirically against 1.1.19: the input line is
  // {"event":"user","message":{"role":"user","content":"<text>"}} — note
  // `event`, not `type`, and a plain string `content`. A `type`-keyed message
  // is rejected with 'stream input message is missing the "event" field'.
  // `-p ""` is still required: it selects print mode, and the flag demands an
  // argument even when the prompt arrives on stdin.
  cliArgs.push(
    "--input-format", "stream-json",
    "--output-format", "stream-json",
    "-p", "",
  );

  const stdinPayload =
    JSON.stringify({ event: "user", message: { role: "user", content: prompt } }) + String.fromCharCode(10);

  const run = await runCliWithRetry({
    bin: "agy",
    cliArgs,
    cwd: args.cwd,
    vendor: "agy",
    timeout_ms: args.timeout_ms,
    input: stdinPayload,
  });

  const parsed = parseAgyOutput(run.stdout);
  const text = parsed.text ?? run.stdout;

  // An ERROR result exits 0, so the status must be checked explicitly.
  // Without this, a rejected stream-input message is indistinguishable from a
  // critique that legitimately had nothing to say — which is exactly the
  // "structurally valid envelope carrying nothing" failure this campaign has
  // already been burned by once, on the codex bridge.
  if (parsed.status === "ERROR") {
    throw new Error(
      `agy returned status=ERROR: ${parsed.error ?? "no error message"}. ` +
      `This is a bridge/CLI failure, not a model verdict — do not record it.`
    );
  }

  // Real usage when the stream-json envelope reports it; the char-based
  // estimate (~4 chars/token) survives only as a fallback for the plain-text
  // path. Before stream-json there was no usage envelope at all, so every agy
  // cost figure in the ledger prior to 2026-08-23 is an estimate.
  const estimateTokens = (s: string): number => Math.max(1, Math.ceil((s ?? "").length / 4));
  const tokens_in  = parsed.tokens_in  ?? estimateTokens(prompt);
  const tokens_out = parsed.tokens_out ?? estimateTokens(text);
  const cost_usd   = computeCost(effectiveModel, tokens_in, tokens_out);

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
    model: effectiveModel,
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

export async function agyCritique(
  args: z.infer<typeof CritiqueSchema>,
  opts: AgyCritiqueInternalOptions = {},
): Promise<AntigravityResult> {
  // Resolve against JUDGE_MODEL_POLICY.agy. `resolveJudgeSelection` routes the
  // agy branch through `resolveAgyInvocation`, so a bare family, a suffixed id,
  // and a family+effort pair all canonicalize to one served id — and an
  // unserved id or a suffix/effort conflict THROWS instead of being silently
  // replaced by the pin, which used to hide caller bugs.
  const selection = resolveJudgeSelection({ producer: "agy", ...args });
  const effectiveModel = selection.model;
  const wrappedArtifact = wrapUntrusted("artifact-under-review", args.artifact_text);
  const judgePrompt =
    `You are an impartial cross-vendor judge for the pair-programmer harness. Apply the rubric below to the artifact.\n` +
    `Return a JSON object with fields: outcome ("pass" | "fail" | "revise"), critique_md, and score_entries (an array of { dimension, score } entries where score is numeric 0..1).\n\n` +
    `## Rubric\n${args.rubric_md}\n\n` +
    `## Artifact\n${wrappedArtifact}\n`;
  const useDefaultSchema = !args.output_schema;
  const genArgs: z.infer<typeof GenerateSchema> = {
    prompt: judgePrompt,
    cwd: args.cwd,
    model: effectiveModel,
    reasoning_effort: selection.reasoning_effort,
    skip_recap: true,
    // A critique is a stateless adjudication: never resume a prior
    // conversation, or this verdict inherits the last one's context.
    fresh_session: true,
    output_schema: args.output_schema ?? buildCritiqueOutputSchema(),
    timeout_ms: args.timeout_ms,
  };
  // Injected invoker when provided (test DI seam); the real agyGenerate
  // otherwise. Mirrors CodexGenerateInternalOptions._invoke.
  const invoker = opts._invoke ?? agyGenerate;
  const invoke = async () => await invoker(genArgs);
  const result = useDefaultSchema
    ? await stabilizeCritiqueResult(invoke, { cwd: args.cwd, vendor: "agy" })
    : await invoke();

  // Annotate the envelope so the effective model and effort are readable by
  // the caller without re-deriving them.
  result.reasoning_effort = selection.reasoning_effort;
  result.override_source  = selection.source;
  if (args.override_reason) result.override_reason = args.override_reason;
  return result;
}

const NEWLINE_SPLIT = new RegExp("\r?\n");

/**
 * Parse agy's `--output-format stream-json` stdout.
 *
 * The stream is NDJSON. The line that matters is
 * `{"event":"result","result":{status,response,error,usage:{input_tokens,output_tokens,...}}}`.
 * An `init` line precedes it and carries the conversation id and tool list.
 *
 * `status` is "SUCCESS" | "ERROR". An ERROR result still exits 0, so the
 * caller MUST branch on the parsed status rather than on the exit code —
 * treating exit 0 as success is how a malformed stream-input message
 * ('stream input message is missing the "event" field') would otherwise be
 * recorded as an empty but valid critique.
 *
 * Falls back to the raw trimmed stdout when no result line is present, so a
 * plain-text response (an older agy, or `--output-format text`) still works.
 */
function parseAgyOutput(stdout: string): {
  text?: string;
  status?: string;
  error?: string;
  tokens_in?: number;
  tokens_out?: number;
} {
  const trimmed = stdout.trim();
  if (!trimmed) return {};

  for (const line of trimmed.split(NEWLINE_SPLIT)) {
    const t = line.trim();
    if (!t.startsWith("{")) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(t);
    } catch {
      continue;
    }
    const evt = parsed as { event?: string; result?: Record<string, unknown> };
    if (evt?.event !== "result" || !evt.result) continue;

    const r = evt.result;
    const usage = (r.usage ?? {}) as Record<string, unknown>;
    const num = (v: unknown): number | undefined =>
      typeof v === "number" && Number.isFinite(v) ? v : undefined;

    return {
      text: typeof r.response === "string" ? r.response.trim() : undefined,
      status: typeof r.status === "string" ? r.status : undefined,
      error: typeof r.error === "string" && r.error ? r.error : undefined,
      tokens_in: num(usage.input_tokens),
      tokens_out: num(usage.output_tokens),
    };
  }

  return { text: trimmed };
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
      "Use Antigravity (agy) as a cross-vendor judge. Wraps the artifact in an untrusted envelope and applies the rubric_md. Returns a structured verdict (outcome | critique_md | score). " +
      "Shares an IDENTICAL option surface with pp_codex.critique: artifact_text, rubric_md, cwd, model? (optional - omit to take the pinned agy default), reasoning_effort?, escalate?, override_source?, override_reason?, output_schema?, timeout_ms?. " +
      "model and reasoning_effort must be allow-listed for this vendor (JUDGE_MODEL_POLICY.agy) - a non-allow-listed value is REJECTED with an error, never silently replaced. agy encodes effort in the model id, so a bare family plus reasoning_effort is canonicalized to the served suffixed id, and a suffixed id that contradicts reasoning_effort is an error. Passing model together with escalate is an error. Any selection that differs from the pinned default requires both override_source and a non-empty override_reason. " +
      "The result carries the effective model, reasoning_effort, override_source and override_reason; agy reports no served model id, so model_reported_by_cli is always undefined on this lane.",
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
