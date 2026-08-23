import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { spawnSync } from "node:child_process";
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
import { shutdownAndExit } from "../util/shutdown.js";
import { getSession, setSession, synthesizeRecap } from "../orchestrator/sub-cli-sessions.js";

// ─── Sandbox policy ──────────────────────────────────────────────────────

const SANDBOX_POLICY = ["read-only", "workspace-write", "danger-full-access"] as const;
type SandboxPolicy = typeof SANDBOX_POLICY[number];

/**
 * Server-side sandbox policy guard (audit §9.6). Mirrors the client-side
 * enforce-sandbox-policy hook (hooks/dispatcher.ts) which only fires for
 * attended, non-headless MCP calls. This guard runs inside the generate
 * handler so that headless callers cannot bypass the check.
 *
 * Exported so it can be unit-tested without spawning the Codex CLI.
 */
export function assertSandboxAllowed(sandbox: SandboxPolicy): void {
  if (sandbox === "danger-full-access" && process.env.PP_ALLOW_DANGER !== "1") {
    const err = new Error(
      `[pp] sandbox=danger-full-access blocked by server-side gate (audit §9.6). ` +
      `Policy 'danger-full-access' grants unrestricted filesystem access and is not ` +
      `permitted in headless MCP sessions. Use 'workspace-write' for editing stages ` +
      `or set PP_ALLOW_DANGER=1 to explicitly opt in.`,
    );
    err.name = "SandboxPolicyViolation";
    throw err;
  }
}

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
  escalate:      z.boolean().optional(),
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
  /**
   * Test-only DI seam. When provided, replaces the real `codexGenerate` call
   * inside `codexCritique` so tests can capture the resolved `genArgs`
   * (including `model: effectiveModel`) without spawning the Codex CLI.
   * Production code never sets this; the default path is always `codexGenerate`.
   */
  _invoke?: (genArgs: z.infer<typeof GenerateSchema>) => Promise<CodexResult>;
};

/**
 * Detect whether `cwd` is a git linked worktree by probing `git rev-parse
 * --git-common-dir`. Returns the resolved absolute path of the git-common-dir
 * when it falls OUTSIDE cwd (linked worktree), or null for the main repo,
 * non-git directories, and any error.
 *
 * A linked worktree has a `.git` TEXT FILE (not a directory) whose content
 * is `gitdir: <path>/worktrees/<name>` — pointing into the main repo's
 * `.git` tree, which lives outside the worktree root. When the Codex sandbox
 * restricts filesystem access to the cwd subtree, git ops that follow this
 * pointer hit "Permission denied" on the main repo's object store.
 *
 * Synchronous, 5s timeout, fail-soft (returns null on timeout or error).
 */
export function detectLinkedWorktree(cwd: string): string | null {
  try {
    const result = spawnSync("git", ["-C", cwd, "rev-parse", "--git-common-dir"], {
      timeout: 5000,
      encoding: "utf8",
    });
    if (result.status !== 0 || result.error || !result.stdout?.trim()) return null;
    const commonDir = result.stdout.trim();
    // Resolve to an absolute path — in the main repo this is ".git" (relative),
    // in a linked worktree it is already the absolute main repo .git path.
    const absCommonDir = resolve(cwd, commonDir);
    const absCwd = resolve(cwd);
    // If the common .git dir is inside cwd it's the main repo; not a linked worktree.
    if (absCommonDir === absCwd || absCommonDir.startsWith(absCwd + "/") || absCommonDir.startsWith(absCwd + "\\")) {
      return null;
    }
    return absCommonDir;
  } catch {
    return null;
  }
}

type CodexCliArgOptions = {
  cwd: string;
  sandbox: SandboxPolicy;
  model: string;
  reasoning_effort?: "minimal" | "low" | "medium" | "high" | "xhigh";
  resumeSessionId?: string;
  outputSchemaPath?: string;
  skip_git_repo_check?: boolean;
  /**
   * When cwd is a git linked worktree, the absolute path of the git-common-dir
   * (the main repo's .git directory). Combined with sandbox==="read-only", causes
   * `--add-dir <mainRepoRoot>` to be appended so the read-only Codex sandbox can
   * follow the .git FILE reference through to the main repo's object store without
   * "Permission denied" (the critique failure scenario).
   *
   * IMPORTANT: `--add-dir` is ONLY injected for sandbox==="read-only". In
   * workspace-write mode the sandbox already permits out-of-workspace reads, so
   * --add-dir is not needed there; worse, it would make the main repo ROOT
   * writable inside a best-of-N candidate worktree, bypassing candidate isolation.
   *
   * `--add-dir` is documented by codex CLI as "Additional directories that should
   * be writable alongside the primary workspace." The read-only sandbox still
   * registers the directory in its scope, enabling git to traverse the .git file
   * pointer. If a future codex version enforces a stricter read boundary for
   * --add-dir in read-only mode, the fallback would be
   * `-c 'sandbox_permissions=["disk-full-read-access"]'`, but that is broader
   * than needed and not used here.
   */
  linkedWorktreeCommonDir?: string | null;
};

export function buildCodexExecArgs(opts: CodexCliArgOptions): string[] {
  const cliArgs: string[] = ["exec", "--json", "--cd", opts.cwd, "--sandbox", opts.sandbox, "--model", opts.model];
  // Headless `codex exec` has no TTY to answer an approval prompt. Without an
  // explicit policy it falls back to the user's ~/.codex/config.toml
  // `approval_policy` (often on-request / untrusted), which auto-DENIES the
  // write and surfaces as "writing is blocked by read-only sandbox; rejected by
  // user approval settings" — even on an editing stage that requested
  // `--sandbox workspace-write` (regression seen on Hydra run_VSTckQaMndVO: a
  // workspace-write generate that wrote nothing). Pin approvals to "never" via a
  // config override (codex 0.128 `exec` has no --ask-for-approval flag) so the
  // chosen --sandbox is the SOLE gate: read-only still blocks writes;
  // workspace-write applies patches within the worktree without prompting.
  cliArgs.push("-c", 'approval_policy="never"');
  // Pin a valid service_tier so the daemon is robust to a broken/incompatible
  // ~/.codex/config.toml. Codex Desktop periodically REWRITES that file with
  // `service_tier = "default"`, which codex-cli 0.128 rejects at config-load
  // ("unknown variant `default`, expected `fast` or `flex`") — breaking every
  // headless generate/critique before the model is even reached. An explicit
  // `-c` override takes precedence over the file, so a Desktop rewrite can no
  // longer wedge the harness. ("fast" is the value this account accepts; "flex"
  // parses in the CLI but is API-rejected on the current tier.)
  cliArgs.push("-c", 'service_tier="fast"');
  // The daemon already chooses the target cwd and sandbox; bypass Codex's
  // interactive trust gate for headless MCP runs unless a caller opts out.
  if (opts.skip_git_repo_check ?? true) cliArgs.push("--skip-git-repo-check");
  if (opts.reasoning_effort) cliArgs.push("--config", `model_reasoning_effort=${opts.reasoning_effort}`);
  if (opts.resumeSessionId) cliArgs.push("--resume", opts.resumeSessionId);
  if (opts.outputSchemaPath) cliArgs.push("--output-schema", opts.outputSchemaPath);
  // Judge-sandbox linked-worktree fix: when cwd is a git linked worktree the
  // .git entry is a TEXT FILE pointing to the main repo's .git directory, which
  // is OUTSIDE the sandbox root. In read-only mode (critique) git ops fail with
  // "Permission denied". Grant the main repo root via --add-dir so the sandbox
  // can traverse the .git file pointer.
  //
  // Gated on read-only ONLY: workspace-write already permits out-of-workspace
  // reads, so --add-dir is unnecessary there; more critically, it would make the
  // main repo root WRITABLE inside a best-of-N candidate worktree, breaking
  // candidate isolation.
  if (opts.linkedWorktreeCommonDir && opts.sandbox === "read-only") {
    const mainRepoRoot = dirname(opts.linkedWorktreeCommonDir);
    cliArgs.push("--add-dir", mainRepoRoot);
  }
  cliArgs.push("-");
  return cliArgs;
}

async function codexGenerate(
  args: z.infer<typeof GenerateSchema>,
  opts: CodexGenerateInternalOptions = {}
): Promise<CodexResult> {
  ensureDirs();
  assertSandboxAllowed(args.sandbox);
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
      const raw = schemaObj;
      const snippet = raw.slice(0, 200);
      try { schemaObj = JSON.parse(raw); }
      catch (parseErr) {
        throw new Error(
          `pp_codex.generate: output_schema was passed as a string but is not valid JSON ` +
          `(${(parseErr as Error).message}). Target path was ${join(tmpDir, "schema.json")}. ` +
          `First 200 chars of payload: ${snippet}. ` +
          `Pass the JSON Schema as an object, not a stringified one.`,
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
    const schemaJson = JSON.stringify(schemaObj, null, 2);
    writeFileSync(schemaPath, schemaJson, "utf8");
    // Driver-debug aid: this exact line lets the operator confirm we wrote a
    // canonical JSON object (not a double-encoded string) to the schema path
    // that the codex CLI will hand to the OpenAI API.
    process.stderr.write(
      `[pp_codex.generate] wrote output_schema to ${schemaPath} (first 200 chars): ${schemaJson.slice(0, 200)}\n`,
    );
    outputSchemaPath = schemaPath;
  }
  // Detect linked worktree so buildCodexExecArgs can inject --add-dir for the
  // main repo root. Fail-soft: null means "not a linked worktree or probe failed".
  const linkedWorktreeCommonDir = detectLinkedWorktree(args.cwd);
  if (linkedWorktreeCommonDir) {
    process.stderr.write(
      `[pp_codex.generate] linked worktree detected: git-common-dir=${linkedWorktreeCommonDir}; ` +
      `adding --add-dir ${dirname(linkedWorktreeCommonDir)} to sandbox args.\n`,
    );
  }
  const cliArgs = buildCodexExecArgs({
    cwd: args.cwd,
    sandbox: args.sandbox,
    model: args.model,
    reasoning_effort: reasoningEffort,
    resumeSessionId,
    outputSchemaPath,
    skip_git_repo_check: opts.skip_git_repo_check,
    linkedWorktreeCommonDir,
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

  const result: CodexResult = {
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

  // No copilot fallback: a correctly-attributed failure (non-zero exit_code,
  // preserved attempts and failure_archive_path) is strictly preferable to a
  // silently mis-attributed success. On the codex lane the mislabel is
  // critical — vendorFor("copilot") === "openai" makes a copilot critique of a
  // codex attempt genuinely same-vendor, yet was recorded cross_vendor=1,
  // falsely satisfying the constitutional cross-vendor gate requirement.
  // Availability must not be purchased with provenance.
  // (AGY-SILENT-VENDOR-FALLTHROUGH, run_jc1UxeCMvyZR)
  return result;
}

/**
 * Select the pinned critique model based on the escalate flag.
 * escalate selects a PINNED allow-listed model (gpt-5.5); caller-passed args.model remains ignored (invented-id guard).
 *
 * This is a pure exported helper so it can be unit-tested offline without
 * spawning the Codex CLI. codexCritique delegates to it internally.
 */
export function selectCritiqueModel(escalate: boolean): string {
  return escalate ? DEFAULT_MODELS.codex_critique_escalated : DEFAULT_MODELS.codex_critique;
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
  // escalate selects a PINNED allow-listed model (gpt-5.5); caller-passed args.model remains ignored (invented-id guard).
  const pinnedModel = DEFAULT_MODELS.codex_critique;
  const effectiveModel = selectCritiqueModel(args.escalate ?? false);
  if (args.model && args.model !== effectiveModel) {
    process.stderr.write(
      `[pp_codex.critique] ignoring model="${args.model}" passed by caller; pinning to "${effectiveModel}" (high reasoning). The judge agent contract requires this model.\n`,
    );
  }
  const wrappedArtifact = wrapUntrusted("artifact-under-review", args.artifact_text);
  const judgePrompt =
    `You are an impartial code/spec/design judge. Apply the rubric below to the artifact.\n` +
    `Return a JSON object with fields: outcome ("pass" | "fail" | "revise"), critique_md, and score_entries (an array of { dimension, score } entries where score is numeric 0..1).\n\n` +
    `## Rubric\n${args.rubric_md}\n\n` +
    `## Artifact\n${wrappedArtifact}\n`;
  const useDefaultSchema = !args.output_schema;
  const genArgs: z.infer<typeof GenerateSchema> = {
    prompt: judgePrompt,
    cwd: args.cwd,
    model: effectiveModel,
    sandbox: "read-only",
    skip_recap: true,
    reasoning_effort: "high",
    output_schema: args.output_schema ?? buildCritiqueOutputSchema(),
    timeout_ms: args.timeout_ms,
  };
  // Use the injected invoker when provided (test DI seam); fall back to the
  // real codexGenerate for all production paths.
  const invoker = opts._invoke ?? ((ga) => codexGenerate(ga, opts));
  const invoke = async () => invoker(genArgs);
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

  // PP-RS-3 (issue 3): chain onto any onclose the SDK installed during connect.
  const _sdkOnclose = transport.onclose;
  transport.onclose = () => {
    try { _sdkOnclose?.(); } catch { /* best-effort */ }
    void shutdownAndExit("transport_close");
  };
  process.stdin.once("end", () => void shutdownAndExit("stdin_end"));
}

// Suppress unused variable warning on `existsSync`/`readFileSync` if not used yet.
void existsSync; void readFileSync;
