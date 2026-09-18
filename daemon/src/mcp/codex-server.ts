import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, lstatSync } from "node:fs";
import { join, dirname, resolve, sep, extname, basename } from "node:path";
import { homedir } from "node:os";
import { spawnSync } from "node:child_process";
import { nanoid } from "nanoid";
import { PNG } from "pngjs";
import { errorContent, jsonContent, zodToJsonSchema } from "./helpers.js";
import { extractLastJsonValue, buildCritiqueOutputSchema } from "./critique-schema.js";
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

/**
 * Shared critique option surface (J5). `pp_agy.critique` carries an IDENTICAL
 * set — a judge call must read the same way whichever vendor serves it.
 *
 * `model` is optional with NO default: omitting it takes the vendor's pinned
 * default via `resolveJudgeSelection`. A model or effort outside the vendor's
 * allow-list is REJECTED LOUDLY (throws) rather than silently discarded, and
 * any selection that deviates from the pin requires both an `override_source`
 * and a non-empty `override_reason`.
 */
/**
 * `generate_image` — run a codex exec turn and harvest whatever PNGs it wrote
 * to `~/.codex/generated_images/<session-id>/`, downscaled to fit a byte
 * budget, written into a caller-supplied output directory.
 *
 * `output_dir` is REQUIRED (not defaulted) — the harvested files are copies,
 * and silently choosing a location for them would surprise a caller more
 * than an explicit argument.
 */
/**
 * Caller-supplied `timeout_ms` clamp for `generate_image`. Without a ceiling
 * a caller could request an arbitrarily large timeout, holding a CLI process
 * (and the daemon worker slot) open indefinitely. 15 minutes comfortably
 * covers image-generation turns while bounding worst case.
 */
const MAX_GENERATE_IMAGE_TIMEOUT_MS = 15 * 60 * 1000;

const GenerateImageSchema = z.object({
  prompt:            z.string().min(1),
  cwd:               z.string().min(1),
  model:             z.string().default(DEFAULT_MODELS.codex_generate),
  output_dir:        z.string().min(1),
  /** Max width/height a returned image is downscaled to fit within. */
  max_dimension:     z.number().int().positive().default(768),
  /** Byte budget per returned file; halved-downscale continues until under this or the 256px floor. */
  byte_budget_bytes: z.number().int().positive().default(300 * 1024),
  /** Clamped to MAX_GENERATE_IMAGE_TIMEOUT_MS (15 minutes) — see constant doc. */
  timeout_ms:        z.number().int().positive().max(MAX_GENERATE_IMAGE_TIMEOUT_MS).optional(),
});

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
  /**
   * The model id the Codex CLI itself reported serving, when the JSONL carried
   * one. Kept SEPARATE from `model` (the requested id) so a served-vs-requested
   * pin drift stays visible instead of collapsing into the request.
   */
  model_reported_by_cli?: string;
  /** Resolved judge reasoning effort (critique path only). */
  reasoning_effort?: JudgeReasoningEffort;
  /** Provenance of the resolved judge selection (critique path only). */
  override_source?: JudgeOverrideSource;
  /** Operator justification carried alongside a non-default selection. */
  override_reason?: string;
  /**
   * True when the CLI reported serving a different model than the one resolved
   * for this critique. Reported, never thrown — a mismatch is a provenance
   * signal, and discarding an otherwise valid verdict over it is worse.
   */
  pin_mismatch?: boolean;
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
  /**
   * When true, this call NEVER resumes an existing `(cwd, "codex")` session
   * and NEVER persists its own returned session id for future resumption.
   * `generate_image` sets this — image-harvest turns must be hermetic: a
   * resumed turn silently reuses (and can re-report) a PRIOR turn's session
   * directory, which is exactly the stale-image path this flag closes.
   */
  fresh_session?: boolean;
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
  // `fresh_session` (generate_image) bypasses this entirely — see the option's
  // doc comment.
  const existing = opts.fresh_session ? null : getSession(args.cwd, "codex");
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
  let text         = parsed.text ?? run.stdout;

  // Capture session id for continuity. Codex emits this in the session_start
  // event; if we got one, store it under (project_path, "codex"). Skipped
  // under fresh_session so an image-harvest turn's session id can never be
  // resumed by a later, unrelated `generate`/`critique` call either.
  if (parsed.session_id && !opts.fresh_session) {
    setSession(args.cwd, "codex", parsed.session_id);
  }

  let parsedJson: unknown;
  if (args.output_schema) {
    const trimmed = text.trim();
    if (trimmed) {
      // Under --output-schema the codex CLI emits ONE `item.completed` per
      // assistant turn, and each is a COMPLETE schema-conforming object. A
      // tool-using call therefore produces a planning preamble FIRST and the real
      // answer SECOND. Selecting by event boundary is the correct fix: walk the
      // complete items backwards and take the last one that parses. Scanning the
      // concatenated blob (below) cannot distinguish an answer from brace-bearing
      // prose in a later item, so it is only a fallback.
      const items = parsed.items ?? [];
      for (let i = items.length - 1; i >= 0 && parsedJson === undefined; i--) {
        const candidate = (items[i] ?? "").trim();
        if (!candidate) continue;
        try { parsedJson = JSON.parse(candidate); text = candidate; } catch { /* keep walking */ }
      }
      if (parsedJson === undefined) {
        try {
          parsedJson = JSON.parse(trimmed);
        } catch {
          const last = extractLastJsonValue(trimmed);
          if (last.found) parsedJson = last.value;
        }
      }
      if (parsedJson === undefined) {
        // An output_schema was requested and NOTHING parsed. Do not let this pass
        // as a quiet success -- a malformed exit-0 response silently becoming an
        // undefined verdict is the same failure shape as the preamble bug above.
        log.warn(
          { cwd: args.cwd, model: args.model, items: items.length, text_len: trimmed.length },
          "codex returned output_schema mode but no item parsed as JSON; parsed left undefined",
        );
      }
    }
  }
  const result: CodexResult = {
    text,
    parsed: parsedJson,
    tokens_in,
    tokens_out,
    cost_usd,
    // The REQUESTED id stays in `model`; what the CLI said it served is kept
    // beside it so a pin mismatch is detectable rather than collapsed away.
    model: args.model,
    model_reported_by_cli: parsed.model,
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

// ─── generate_image ────────────────────────────────────────────────────────

export type GeneratedImage = {
  /** Absolute path of the downscaled copy written into the caller's output_dir. */
  path: string;
  bytes: number;
  width: number;
  height: number;
  generator: "codex";
  model: string;
  prompt: string;
};

/** A harvested PNG that could not be brought under `byte_budget_bytes` even at DOWNSCALE_FLOOR_PX. */
export type OverBudgetImage = {
  file: string;
  path: string;
  bytes: number;
  width: number;
  height: number;
};

/** A file in the session directory that could not be turned into a returned image. */
export type ImageFailure = {
  file: string;
  reason: string;
};

export type CodexGenerateImageResult =
  | {
      /**
       * "ok" only when every harvested PNG produced a budget-compliant
       * image with no failures. "partial" means SOME images succeeded but at
       * least one is over budget and/or failed — callers must check
       * `over_budget`/`failures`, not just `images.length > 0`.
       */
      status: "ok" | "partial";
      images: GeneratedImage[];
      over_budget: OverBudgetImage[];
      failures: ImageFailure[];
      session_id: string;
      tokens_in: number;
      tokens_out: number;
      cost_usd: number;
      wall_ms: number;
    }
  | {
      status: "no_session_id";
      reason: string;
    }
  | {
      status: "invalid_session_id";
      reason: string;
      session_id: string;
    }
  | {
      status: "cli_failure";
      reason: string;
      exit_code: number;
      session_id?: string;
    }
  | {
      status: "empty_session_dir";
      reason: string;
      session_id: string;
    };

export type CodexGenerateImageInternalOptions = {
  /**
   * Test-only DI seam: replaces the real codex exec turn so tests can control
   * the returned `session_id` (or omit it) without spawning the CLI.
   */
  _invoke?: (genArgs: z.infer<typeof GenerateSchema>) => Promise<CodexResult>;
  /**
   * Test-only DI seam: overrides `~/.codex/generated_images` so tests can
   * point at a fixture directory instead of the real home directory.
   */
  _imagesRoot?: string;
};

/**
 * Downscale threshold floor (px). `downscaleImageToFit` halves the target
 * max-dimension cap repeatedly until the encoded PNG fits `byteBudget`, but
 * never goes below this floor — an unbounded halving loop would eventually
 * produce a useless 1x1 image chasing an unreachable byte budget.
 */
const DOWNSCALE_FLOOR_PX = 256;

/**
 * Nearest-neighbor resize of a decoded PNG to `(width, height)`. pngjs has no
 * built-in resize; this is the minimal correct implementation for the
 * downscale contract (exact pixel fidelity is not required — only "fits
 * within a byte budget").
 */
function resizePng(src: PNG, width: number, height: number): PNG {
  if (width === src.width && height === src.height) return src;
  const dst = new PNG({ width, height });
  for (let y = 0; y < height; y++) {
    const sy = Math.min(src.height - 1, Math.floor((y * src.height) / height));
    for (let x = 0; x < width; x++) {
      const sx = Math.min(src.width - 1, Math.floor((x * src.width) / width));
      const srcIdx = (src.width * sy + sx) << 2;
      const dstIdx = (width * y + x) << 2;
      dst.data[dstIdx] = src.data[srcIdx] as number;
      dst.data[dstIdx + 1] = src.data[srcIdx + 1] as number;
      dst.data[dstIdx + 2] = src.data[srcIdx + 2] as number;
      dst.data[dstIdx + 3] = src.data[srcIdx + 3] as number;
    }
  }
  return dst;
}

/**
 * Downscale a decoded PNG to fit within `maxDimension` on its longest side
 * AND `byteBudget` bytes, halving the dimension cap until both are satisfied
 * or `DOWNSCALE_FLOOR_PX` is reached. An image already within both bounds is
 * returned unchanged (same bytes, same dimensions) — this is NOT a
 * re-encode-always operation.
 *
 * Exported so the mutation-proof (removing the byte-budget check) has a
 * single call site to break, per the task's mutation-proof contract.
 */
export function downscaleImageToFit(
  original: PNG,
  maxDimension: number,
  byteBudget: number,
): { buffer: Buffer; width: number; height: number } {
  let cap = maxDimension;
  const scaleTo = (c: number): PNG => {
    const scale = Math.min(1, c / Math.max(original.width, original.height));
    const width = Math.max(1, Math.round(original.width * scale));
    const height = Math.max(1, Math.round(original.height * scale));
    return resizePng(original, width, height);
  };

  let resized = scaleTo(cap);
  let buffer = PNG.sync.write(resized);
  // Halve the cap until the encoded size fits the byte budget or the floor is
  // reached. `cap` strictly decreases toward DOWNSCALE_FLOOR_PX each pass, so
  // this always terminates.
  while (buffer.length > byteBudget && cap > DOWNSCALE_FLOOR_PX) {
    cap = Math.max(DOWNSCALE_FLOOR_PX, Math.floor(cap / 2));
    resized = scaleTo(cap);
    buffer = PNG.sync.write(resized);
  }
  return { buffer, width: resized.width, height: resized.height };
}

/**
 * Session ids are used as a bare path segment (`<imagesRoot>/<session_id>`).
 * Restrict to hex digits and dashes, length-bounded, so a value like
 * `../other-session` or an absolute path can never escape the images root —
 * REJECTED outright rather than sanitized, per the path-handling hardening.
 */
const SESSION_ID_PATTERN = /^[0-9a-fA-F-]{1,64}$/;

function isValidSessionId(id: string): boolean {
  return SESSION_ID_PATTERN.test(id);
}

/** True when resolved path `p` is `root` itself or strictly nested under it. */
function isInside(root: string, p: string): boolean {
  const r = resolve(root);
  const rp = resolve(p);
  return rp === r || rp.startsWith(r + sep);
}

/**
 * Read only the PNG signature + IHDR chunk (first 24 bytes) to recover
 * width/height WITHOUT a full decode. Used to decide whether an already
 * budget-compliant file can be copied verbatim (no decode/re-encode) —
 * decoding via pngjs always re-encodes as 8-bit RGBA, which would silently
 * rewrite palette/grayscale/16-bit/interlaced originals.
 */
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
function readPngDimensionsFast(buffer: Buffer): { width: number; height: number } | null {
  if (buffer.length < 24) return null;
  if (!buffer.subarray(0, 8).equals(PNG_SIGNATURE)) return null;
  if (buffer.toString("ascii", 12, 16) !== "IHDR") return null;
  const width = buffer.readUInt32BE(16);
  const height = buffer.readUInt32BE(20);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null;
  return { width, height };
}

/**
 * Enumerate `dir` with `lstat` (never following symlinks) and return only
 * the names of REGULAR files ending in `.png`. A symlink named `x.png`
 * (however it resolves) and a DIRECTORY named `x.png` are both excluded —
 * `lstat(...).isFile()` is false for both.
 */
function listRegularPngFiles(dir: string): string[] {
  let entries: string[];
  try { entries = readdirSync(dir); } catch { return []; }
  const out: string[] = [];
  for (const name of entries) {
    if (!name.toLowerCase().endsWith(".png")) continue;
    let st;
    try { st = lstatSync(join(dir, name)); } catch { continue; }
    if (!st.isFile()) continue;
    out.push(name);
  }
  return out.sort();
}

/** Flattened `"<sessionDirName>/<file>"` keys of every regular file under `imagesRoot`'s immediate subdirectories. */
function snapshotImagesRoot(imagesRoot: string): Set<string> {
  const out = new Set<string>();
  let dirNames: string[];
  try { dirNames = readdirSync(imagesRoot); } catch { return out; }
  for (const dirName of dirNames) {
    const dirPath = join(imagesRoot, dirName);
    let st;
    try { st = lstatSync(dirPath); } catch { continue; }
    if (!st.isDirectory()) continue;
    for (const f of listRegularPngFiles(dirPath)) out.add(`${dirName}/${f}`);
  }
  return out;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve_ => setTimeout(resolve_, ms));
}

/**
 * Codex's `exec` process can exit before its own image-write flush is
 * visible to a subsequent `readdirSync` — harvesting immediately after the
 * CLI returns can therefore see an empty/missing session directory that
 * fills in moments later. Poll briefly (bounded) rather than declaring
 * failure on the first look, and give up honestly if nothing ever appears.
 */
const HARVEST_POLL_TIMEOUT_MS = 2000;
const HARVEST_POLL_INTERVAL_MS = 100;

async function pollForPngFiles(dir: string): Promise<string[]> {
  const deadline = Date.now() + HARVEST_POLL_TIMEOUT_MS;
  for (;;) {
    const found = listRegularPngFiles(dir);
    if (found.length > 0) return found;
    if (Date.now() >= deadline) return listRegularPngFiles(dir);
    await sleep(HARVEST_POLL_INTERVAL_MS);
  }
}

/**
 * Per-call caps stated in the tool description. Bound both the number of
 * images processed and the decoded pixel budget so a runaway or malicious
 * session directory cannot make one MCP call decode unboundedly many or
 * unboundedly large images.
 */
const MAX_IMAGES_PER_CALL = 20;
const MAX_DECODED_PIXELS_PER_IMAGE = 4096 * 4096;

/**
 * Write `buffer` under `outputDirResolved` as `filename`, refusing to follow
 * or overwrite an existing path (symlink or otherwise) at that name — `wx`
 * fails with EEXIST for ANY existing entry, symlink or not, dangling or not.
 * On collision, a fresh unique name is chosen instead of clobbering.
 * Also asserts the resolved destination never escapes `outputDirResolved`.
 */
function writeImageSafely(outputDirResolved: string, filename: string, buffer: Buffer): string {
  let candidate = filename;
  let attempt = 0;
  for (;;) {
    const destPath = resolve(join(outputDirResolved, candidate));
    if (!isInside(outputDirResolved, destPath)) {
      throw new Error(`refusing to write image outside output_dir: ${destPath}`);
    }
    try {
      writeFileSync(destPath, buffer, { flag: "wx" });
      return destPath;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EEXIST") {
        attempt += 1;
        const ext = extname(filename);
        const base = basename(filename, ext);
        candidate = `${base}-${attempt}${ext}`;
        continue;
      }
      throw err;
    }
  }
}

/**
 * Run a codex exec turn and harvest ONLY the PNGs codex wrote to
 * `~/.codex/generated_images/<session-id>/` for THAT turn's session id.
 *
 * Deliberately does NOT scan `~/.codex/generated_images` for the
 * newest-mtime directory — that would race any other codex session running
 * concurrently on the machine (a different worktree, a different stage) and
 * could harvest someone else's images. If codex reports no session id at
 * all, this returns a structured `no_session_id` failure rather than
 * guessing a directory.
 *
 * The underlying `generate` call is ALWAYS a fresh, non-resumable session
 * (`fresh_session: true`) — resumption would let a later call silently
 * re-return an earlier turn's images. A non-zero CLI exit is honoured as a
 * hard failure rather than proceeding to harvest stale files.
 */
export async function codexGenerateImage(
  args: z.infer<typeof GenerateImageSchema>,
  opts: CodexGenerateImageInternalOptions = {},
): Promise<CodexGenerateImageResult> {
  const genArgs: z.infer<typeof GenerateSchema> = {
    prompt: args.prompt,
    cwd: args.cwd,
    model: args.model,
    sandbox: "read-only",
    skip_recap: true,
    timeout_ms: args.timeout_ms,
  };
  const imagesRoot = opts._imagesRoot ?? join(homedir(), ".codex", "generated_images");
  // Snapshot BEFORE the call: if the returned session id ever collides with a
  // pre-existing directory (defense-in-depth beyond fresh_session), files
  // already present before this call started are excluded from the harvest.
  const preCallSnapshot = snapshotImagesRoot(imagesRoot);

  const invoker = opts._invoke ?? ((ga) => codexGenerate(ga, { fresh_session: true }));
  const result = await invoker(genArgs);

  if (result.exit_code !== 0) {
    return {
      status: "cli_failure",
      reason: `codex exec exited with code ${result.exit_code}; refusing to harvest images from a failed/incomplete turn.`,
      exit_code: result.exit_code,
      session_id: result.session_id,
    };
  }

  if (!result.session_id) {
    return {
      status: "no_session_id",
      reason:
        "codex exec did not report a session_id for this turn; refusing to guess a " +
        "~/.codex/generated_images directory (scanning by newest mtime would risk " +
        "harvesting a concurrent codex session's images).",
    };
  }

  if (!isValidSessionId(result.session_id)) {
    return {
      status: "invalid_session_id",
      reason:
        `codex reported a session_id ("${result.session_id}") that does not match the expected ` +
        `hex/dash pattern; refusing to use it as a path segment.`,
      session_id: result.session_id,
    };
  }

  const sessionId: string = result.session_id;
  const imagesRootResolved = resolve(imagesRoot);
  const sessionDir = resolve(join(imagesRootResolved, sessionId));
  // Belt-and-suspenders: the regex above already forbids path separators and
  // "..", so this should always hold, but assert it explicitly rather than
  // trusting the regex alone.
  if (dirname(sessionDir) !== imagesRootResolved) {
    return {
      status: "invalid_session_id",
      reason: `resolved session directory ${sessionDir} is not a direct child of the images root ${imagesRootResolved}.`,
      session_id: sessionId,
    };
  }

  const polled = await pollForPngFiles(sessionDir);
  if (polled.length === 0) {
    return {
      status: "empty_session_dir",
      reason: existsSync(sessionDir)
        ? `session directory ${sessionDir} contains no PNG files (polled for ${HARVEST_POLL_TIMEOUT_MS}ms).`
        : `no generated_images directory exists for session ${sessionId} (codex did not write an image this turn; polled for ${HARVEST_POLL_TIMEOUT_MS}ms).`,
      session_id: sessionId,
    };
  }

  // Exclude anything that existed in this exact directory before the call —
  // a stale carry-over defense on top of fresh_session (see doc comment).
  const preExistingHere = new Set(
    [...preCallSnapshot].filter(k => k.startsWith(`${sessionId}/`)).map(k => k.slice(sessionId.length + 1)),
  );
  const newFiles = polled.filter(f => !preExistingHere.has(f));

  if (newFiles.length === 0) {
    return {
      status: "empty_session_dir",
      reason: `session directory ${sessionDir} contains only files that pre-date this call (stale carry-over); no new images this turn.`,
      session_id: sessionId,
    };
  }

  const outputDirResolved = resolve(args.output_dir);
  mkdirSync(outputDirResolved, { recursive: true });

  const images: GeneratedImage[] = [];
  const overBudget: OverBudgetImage[] = [];
  const failures: ImageFailure[] = [];

  const cappedFiles = newFiles.slice(0, MAX_IMAGES_PER_CALL);
  for (const f of newFiles.slice(MAX_IMAGES_PER_CALL)) {
    failures.push({
      file: f,
      reason: `skipped: per-call image cap (${MAX_IMAGES_PER_CALL}) reached.`,
    });
  }

  for (const file of cappedFiles) {
    try {
      const srcPath = join(sessionDir, file);
      const raw = readFileSync(srcPath);
      const dims = readPngDimensionsFast(raw);
      if (!dims) {
        failures.push({ file, reason: "not a well-formed PNG (bad signature/IHDR)." });
        continue;
      }
      if (dims.width * dims.height > MAX_DECODED_PIXELS_PER_IMAGE) {
        failures.push({
          file,
          reason: `exceeds decoded pixel budget (${dims.width}x${dims.height} > ${MAX_DECODED_PIXELS_PER_IMAGE}px cap).`,
        });
        continue;
      }

      const fitsAsIs = raw.length <= args.byte_budget_bytes && Math.max(dims.width, dims.height) <= args.max_dimension;
      if (fitsAsIs) {
        // Already within both bounds: copy bytes VERBATIM. No decode/re-encode
        // — preserves palette/grayscale/16-bit/interlaced originals exactly.
        const destPath = writeImageSafely(outputDirResolved, file, raw);
        images.push({
          path: destPath,
          bytes: raw.length,
          width: dims.width,
          height: dims.height,
          generator: "codex",
          model: result.model,
          prompt: args.prompt,
        });
        continue;
      }

      let decoded: PNG;
      try {
        decoded = PNG.sync.read(raw);
      } catch (err) {
        failures.push({ file, reason: `failed to decode: ${(err as Error).message}` });
        continue;
      }
      const { buffer, width, height } = downscaleImageToFit(decoded, args.max_dimension, args.byte_budget_bytes);
      const destPath = writeImageSafely(outputDirResolved, file, buffer);
      if (buffer.length > args.byte_budget_bytes) {
        // Floor reached and still over budget: NEVER report this as ok.
        overBudget.push({ file, path: destPath, bytes: buffer.length, width, height });
      } else {
        images.push({
          path: destPath,
          bytes: buffer.length,
          width,
          height,
          generator: "codex",
          model: result.model,
          prompt: args.prompt,
        });
      }
    } catch (err) {
      failures.push({ file, reason: `unexpected error: ${(err as Error).message}` });
    }
  }

  return {
    status: overBudget.length === 0 && failures.length === 0 ? "ok" : "partial",
    images,
    over_budget: overBudget,
    failures,
    session_id: sessionId,
    tokens_in: result.tokens_in,
    tokens_out: result.tokens_out,
    cost_usd: result.cost_usd,
    wall_ms: result.wall_ms,
  };
}

/**
 * Select the pinned critique model based on the escalate flag.
 * escalate selects a PINNED allow-listed model (gpt-5.6-sol); caller-passed args.model remains ignored (invented-id guard).
 *
 * This is a pure exported helper so it can be unit-tested offline without
 * spawning the Codex CLI. codexCritique delegates to it internally.
 */
export function selectCritiqueModel(escalate: boolean): string {
  return escalate ? DEFAULT_MODELS.codex_critique_escalated : DEFAULT_MODELS.codex_critique;
}

/**
 * Resolve the concrete (model, reasoning_effort, source) a codex critique will
 * run at, from the shared critique option surface. Pure — exported so the
 * resolution can be unit-tested without spawning the Codex CLI.
 *
 * Throws (loudly) when the caller names a model or effort outside
 * JUDGE_MODEL_POLICY.codex, combines `model` with `escalate`, or deviates from
 * the pin without an override_source + override_reason.
 */
export function selectCritiqueInvocation(args: {
  model?: string;
  reasoning_effort?: string;
  escalate?: boolean;
  override_source?: string;
  override_reason?: string;
}): { model: string; reasoning_effort: JudgeReasoningEffort; source: JudgeOverrideSource } {
  return resolveJudgeSelection({ producer: "codex", ...args });
}

export async function codexCritique(
  args: z.infer<typeof CritiqueSchema>,
  opts: CodexGenerateInternalOptions = {}
): Promise<CodexResult> {
  // Resolve the judge selection against JUDGE_MODEL_POLICY.codex. Claude Code
  // drivers have repeatedly invented model ids (gpt-5-codex, o1, ...) which the
  // installed codex CLI does not serve; those used to be silently discarded,
  // which hid the driver bug. They now THROW — a caller that asked for a model
  // it will not get must be told, not quietly overridden.
  const selection = selectCritiqueInvocation(args);
  const effectiveModel = selection.model;
  const wrappedArtifact = wrapUntrusted("artifact-under-review", args.artifact_text);
  const judgePrompt =
    `You are an impartial code/spec/design judge. Apply the rubric below to the artifact.
` +
    `Return a JSON object with fields: outcome ("pass" | "fail" | "revise"), critique_md, and score_entries (an array of { dimension, score } entries where score is numeric 0..1).

` +
    `## Rubric
${args.rubric_md}

` +
    `## Artifact
${wrappedArtifact}
`;
  const useDefaultSchema = !args.output_schema;
  const genArgs: z.infer<typeof GenerateSchema> = {
    prompt: judgePrompt,
    cwd: args.cwd,
    model: effectiveModel,
    sandbox: "read-only",
    skip_recap: true,
    // CONSTITUTION.md Article V as amended 2026-09-03 (SHA 5df284cb, previously 13b4fa18) pins JUDGE-1 at
    // medium reasoning effort. The default path still resolves to medium; a
    // different effort only arrives through the escalated pin or a justified
    // override. Do not raise the DEFAULT without a constitution amendment.
    reasoning_effort: selection.reasoning_effort,
    output_schema: args.output_schema ?? buildCritiqueOutputSchema(),
    timeout_ms: args.timeout_ms,
  };
  // Use the injected invoker when provided (test DI seam); fall back to the
  // real codexGenerate for all production paths.
  const invoker = opts._invoke ?? ((ga) => codexGenerate(ga, opts));
  const invoke = async () => invoker(genArgs);
  const result = useDefaultSchema
    ? await stabilizeCritiqueResult(invoke, { cwd: args.cwd, vendor: "codex" })
    : await invoke();

  // Annotate the envelope with the resolved selection so the effective model
  // and effort are readable by the caller without re-deriving them.
  result.reasoning_effort = selection.reasoning_effort;
  result.override_source  = selection.source;
  if (args.override_reason) result.override_reason = args.override_reason;

  // Pin mismatch is REPORTED, never thrown: the verdict itself is still a real
  // adjudication, and the provenance signal belongs in the ledger.
  const served = result.model_reported_by_cli;
  if (served && served !== effectiveModel) {
    result.pin_mismatch = true;
    log.warn(
      { requested: effectiveModel, served, cwd: args.cwd },
      "codex critique pin mismatch: the CLI reported serving a different model than the one resolved",
    );
  }
  return result;
}

// ─── JSONL parsing ───────────────────────────────────────────────────────
// Codex --json emits one event per line. Different versions vary slightly,
// so we extract defensively: token counts from any field that looks like
// {tokens|usage} on a final event, and concatenate text-bearing events.

export function parseCodexJsonl(stdout: string): {
  text?: string;
  /**
   * Text of each COMPLETE emitted item, in order, with event boundaries intact.
   * `text` above is these concatenated, which is lossy: under --output-schema the
   * codex CLI emits one item per assistant turn and each is a whole
   * schema-conforming object, so concatenation yields `{...}{...}` and destroys
   * the boundary a caller needs to pick the final answer over the preamble.
   */
  items?: string[];
  tokens_in?: number;
  tokens_out?: number;
  model?: string;
  session_id?: string;
} {
  const out: { text: string; items: string[]; tokens_in: number; tokens_out: number; model: string | undefined; session_id: string | undefined } = {
    text: "",
    items: [],
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
      out.items.push(text);
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
    name: "generate_image",
    description:
      "Run `codex exec` and harvest any PNGs it wrote for THIS turn's session, downscaled to fit a byte budget, into a caller-supplied output_dir. " +
      "Harvest contract: codex writes generated images to `~/.codex/generated_images/<session-id>/exec-<call-id>.png`; this tool captures the session id " +
      "codex reports for its OWN exec turn and harvests ONLY that session's directory — it never scans by newest mtime, which would risk harvesting a " +
      "concurrent codex session's images. The underlying turn is ALWAYS a fresh, non-resumable session, so a later call can never re-return an earlier " +
      "call's images; a non-zero codex exit is a hard failure (status: cli_failure), never a stale-but-ok result. The session id is validated (hex/dash, " +
      "length-bounded) before use as a path segment — an unexpected id is rejected (status: invalid_session_id) rather than used to build a path. Only " +
      "regular files (no symlinks, no directories) named *.png are harvested, and the harness briefly polls (up to 2s) for the directory/files to appear " +
      "before giving up. If no session id is reported, or the session directory is missing/empty after polling, a structured failure is returned " +
      "(status: no_session_id | empty_session_dir) instead of guessing. " +
      "Caps: at most 20 images and 4096x4096 decoded pixels per image are processed per call; anything past the cap is reported in `failures`, not silently dropped. " +
      "Downscale contract: each harvested PNG is fit within max_dimension (default 768px, longest side) and byte_budget_bytes (default 300KB), halving " +
      "the dimension cap until it fits or a 256px floor is reached. An image that ALREADY fits both bounds is copied byte-for-byte with no decode/re-encode " +
      "(preserves palette/grayscale/16-bit/interlaced originals exactly). An image that still exceeds byte_budget_bytes at the 256px floor is NEVER reported " +
      "as ok — it is written but listed in `over_budget` (with its final bytes/width/height), and the overall `status` becomes \"partial\" rather than \"ok\". " +
      "A malformed/unreadable PNG becomes a per-file entry in `failures` instead of failing the whole call. " +
      "Destination writes refuse to follow or overwrite an existing path (symlink or otherwise) at the target name, picking a fresh unique name on collision, " +
      "and every destination is asserted to stay inside output_dir. " +
      "timeout_ms is clamped to 15 minutes. " +
      "Returns absolute file paths plus width/height/byte size/provenance (generator, model, prompt) for each image — NEVER base64.",
    schema: GenerateImageSchema,
    handler: (args: unknown) => codexGenerateImage(GenerateImageSchema.parse(args)),
  },
  {
    name: "critique",
    description:
      "Use Codex as a judge. Wraps the artifact in an untrusted envelope and applies the rubric_md. Returns a structured verdict (outcome | critique_md | score). " +
      "Shares an IDENTICAL option surface with pp_agy.critique: artifact_text, rubric_md, cwd, model? (optional — omit to take the pinned JUDGE-1 default), reasoning_effort?, escalate?, override_source?, override_reason?, output_schema?, timeout_ms?. " +
      "model and reasoning_effort must be allow-listed for this vendor (JUDGE_MODEL_POLICY.codex) — a non-allow-listed value is REJECTED with an error, never silently replaced. Passing model together with escalate is an error. Any selection that differs from the pinned default requires both override_source and a non-empty override_reason. " +
      "The result carries the effective model, reasoning_effort, override_source, override_reason, plus model_reported_by_cli and pin_mismatch when the CLI reports serving a different model.",
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
