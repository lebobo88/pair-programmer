/**
 * Centralized constants. Avoid spreading magic numbers across the codebase.
 */

import { z } from "zod";
// NOTE: config.ts ↔ mcp/agy-model.ts is a deliberate ESM cycle. Both sides
// touch the other only from inside function bodies (never at module-evaluation
// time), so whichever module is entered first finishes initializing before any
// cross-module value is read.
import { resolveAgyInvocation } from "./mcp/agy-model.js";

/** Default ceiling on validator (judge) calls per single run. Phase 4 enforces. */
export const DEFAULT_LOOP_CEILING = 6;

/** Wall-clock timeout per sub-CLI generator/judge call. */
export const DEFAULT_CLI_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * Server-side retries on top of the original sub-CLI invocation. Applied per
 * call in `codexGenerate` / `agyGenerate` when stderr does NOT match the
 * persistent-failure regex (model not found, auth, ENOENT, etc.). The judge
 * sub-agent layer adds its own retry-once on top of this.
 */
export const CRITIQUE_RETRY_ATTEMPTS = 1;
export const CRITIQUE_RETRY_BACKOFF_MS = 2000;

/**
 * Reasoning-effort vocabulary a judge invocation may carry. Not every vendor
 * serves every level — the per-vendor `allowed_efforts` in JUDGE_MODEL_POLICY
 * is authoritative, this array is only the union.
 */
export const JUDGE_REASONING_EFFORTS = ["low", "medium", "high", "xhigh"] as const;
export type JudgeReasoningEffort = typeof JUDGE_REASONING_EFFORTS[number];

/**
 * Where a non-default judge selection came from. "default" and "escalated" are
 * the two pinned lanes and need no justification; the remaining three are
 * operator-driven override channels and REQUIRE an override_reason.
 */
export const JUDGE_OVERRIDE_SOURCES = ["default", "escalated", "cli", "team_yaml", "hydra"] as const;
export type JudgeOverrideSource = typeof JUDGE_OVERRIDE_SOURCES[number];

export type VendorJudgePolicy = {
  default:   { model: string; reasoning_effort: JudgeReasoningEffort };
  escalated: { model: string; reasoning_effort: JudgeReasoningEffort };
  allowed_models:  readonly string[];
  allowed_efforts: readonly JudgeReasoningEffort[];
};

/**
 * Per-vendor judge model policy — the single source of truth for which model a
 * judge may run at, and at what reasoning effort. `DEFAULT_MODELS` below is
 * DERIVED from this table; do not repin a judge by editing DEFAULT_MODELS.
 *
 * IMPORTANT — agy model-id handling, verified against agy 1.1.24 by direct
 * probe on 2026-09-02:
 *  - `agy --model <id>` rejects BOTH unknown ids and retired ids: exit 1,
 *    status ERROR, "invalid model selection". There is NO silent fallback to a
 *    CLI default — E2-1's retired `gemini-3.1-pro-preview` is rejected outright
 *    like any other unknown id.
 *  - An effort-SUFFIXED id combined with `--effort` is an error
 *    ("conflicts with --effort"). Pass the suffixed id alone.
 *  - A BARE family plus `--effort low|medium|high` works.
 *    `resolveAgyInvocation` (mcp/agy-model.ts) canonicalizes every input to a
 *    suffixed id so pp never needs to pass `--effort` at all.
 *  - Ids served as of 1.1.24: gemini-3.8-flash-{high,medium,low},
 *    gemini-3.7-flash-{high,medium,low}, gemini-3.6-flash-{high,medium,low},
 *    gemini-3.1-pro-{high,low}, claude-sonnet-4-6, claude-opus-4-6-thinking,
 *    gpt-oss-120b-medium. The 3.1 lane exposes effort-suffixed ids only —
 *    there is no bare `gemini-3.1-pro`.
 *  - `agy models` remains the keep-up-to-date check and `doctor()` runs it,
 *    reporting `agy_pin_served` — see `orchestrator/agy-pin.ts`.
 */
export const JUDGE_MODEL_POLICY = {
  codex: {
    // Constitutional default (JUDGE-1), pinned by CONSTITUTION.md Article V as
    // amended 2026-09-03 (SHA 5df284cb, previously 13b4fa18): Codex `gpt-5.6-terra` at medium reasoning effort.
    // Do NOT change outside the HITL `/pp:constitution amend` path.
    default:   { model: "gpt-5.6-terra", reasoning_effort: "medium" },
    // Opt-in escalation for major-scope / last-resort gates.
    escalated: { model: "gpt-5.6-sol", reasoning_effort: "medium" },
    allowed_models:  ["gpt-5.6-terra", "gpt-5.6-sol", "gpt-5.6-luna"],
    allowed_efforts: ["low", "medium", "high", "xhigh"],
  },
  agy: {
    default:   { model: "gemini-3.8-flash-medium", reasoning_effort: "medium" },
    escalated: { model: "gemini-3.1-pro-high", reasoning_effort: "high" },
    allowed_models: [
      "gemini-3.8-flash-high", "gemini-3.8-flash-medium", "gemini-3.8-flash-low",
      "gemini-3.7-flash-high", "gemini-3.7-flash-medium", "gemini-3.7-flash-low",
      "gemini-3.1-pro-high",   "gemini-3.1-pro-low",
    ],
    allowed_efforts: ["low", "medium", "high"],
  },
} as const satisfies Record<"codex" | "agy", VendorJudgePolicy>;

/**
 * Pinned model defaults per (vendor, operation). Sub-agents are required to
 * pass `model` explicitly (see judge-cross-vendor / judge-same-vendor / engineer
 * agent prompts), but if the schema default fires it must point at a model the
 * installed CLI version actually serves. Keep in sync with `daemon/prices.json`.
 *
 * Every critique entry is DERIVED from JUDGE_MODEL_POLICY above — repin there.
 */
export const DEFAULT_MODELS = {
  codex_generate:            "gpt-5.6-luna",
  codex_critique:            JUDGE_MODEL_POLICY.codex.default.model,
  codex_critique_escalated:  JUDGE_MODEL_POLICY.codex.escalated.model,
  agy_generate:              "gemini-3.8-flash-medium",
  agy_critique:              JUDGE_MODEL_POLICY.agy.default.model,
  agy_critique_escalated:    JUDGE_MODEL_POLICY.agy.escalated.model,
} as const;

/**
 * Claude tier → concrete model id. Single source of truth for the
 * tier-aware delegation system (see .claude/commands/pp/run.md step 6a).
 * Sub-agents declare a default tier via `model:` frontmatter; the driver
 * may override per resolved tier when dispatching via Task(). Judges keep
 * their own rotation table — they intentionally do not consume this map.
 * Keep in sync with `daemon/prices.json` when model ids change.
 */
export const CLAUDE_TIER_MODELS = {
  opus:   "claude-opus-5",
  sonnet: "claude-sonnet-5",
  haiku:  "claude-haiku-4-5-20251001",
  // Fable-5: capability-gated, NEVER reached by automatic shiftTier escalation.
  // Selected only via explicit operator config:
  //   (a) the deep-reasoning-team (deep-reasoning-team.yaml),
  //   (b) an explicit per-stage generator.model_tier: fable in any team yaml, or
  //   (c) a profile's model_tier_policy.per_stage_override[<stage.kind>]: fable.
  // There is no --tier CLI flag for fable. fable is intentionally absent from
  // TIER_ORDER — see comment there.
  fable:  "claude-fable-5",
} as const;

/**
 * GitHub Copilot tier map. This map is DELIBERATELY IDENTICAL to
 * CLAUDE_TIER_MODELS above. The historical "Copilot pins Opus one rev lower"
 * divergence was collapsed by operator decision during the gpt-5.6 / Claude-5
 * model-id refresh: both entrypoints now serve the same generation, so keeping
 * a lagging Copilot pin bought nothing and produced two ids to maintain. The
 * separate export is retained so a future Copilot-only divergence can be
 * reintroduced by editing one map rather than re-plumbing every call site.
 */
export const COPILOT_CLAUDE_TIER_MODELS = {
  opus:   "claude-opus-5",
  sonnet: "claude-sonnet-5",
  haiku:  "claude-haiku-4-5-20251001",
  // Fable-5: capability-gated. See CLAUDE_TIER_MODELS comment above.
  fable:  "claude-fable-5",
} as const;

export type ClaudeTier = keyof typeof CLAUDE_TIER_MODELS;

/**
 * Ladder, low → high. shiftTier walks this.
 * "fable" is intentionally ABSENT from this array — it is a capability-gated
 * tier reached only via explicit operator config: (a) the deep-reasoning-team,
 * (b) generator.model_tier: fable in a team yaml stage, or (c) a profile's
 * model_tier_policy.per_stage_override[<stage>]: fable. There is no --tier CLI
 * flag for fable and no automatic escalation path that reaches it.
 * Keeping fable off the ladder means shiftTier("opus", +1) clamps at opus
 * and can NEVER auto-escalate to fable. See shiftTier defensive guard below.
 */
export const TIER_ORDER: readonly ["haiku", "sonnet", "opus"] = ["haiku", "sonnet", "opus"];

export function tierIndex(t: ClaudeTier): number {
  return (TIER_ORDER as readonly string[]).indexOf(t);
}

/**
 * Shift a tier by N steps; clamps at the ends of the ladder.
 * Defensive guard: if `t` is not in TIER_ORDER (tierIndex < 0), return `t`
 * unchanged. This handles capability-gated tiers like "fable" that are valid
 * ClaudeTier values but intentionally off the ladder — they should never be
 * shifted up or down.
 */
export function shiftTier(t: ClaudeTier, delta: number): ClaudeTier {
  const i = tierIndex(t);
  if (i < 0) return t; // off-ladder tier (e.g. fable): never shift
  const idx = Math.max(0, Math.min(TIER_ORDER.length - 1, i + delta));
  // idx is clamped to [0, TIER_ORDER.length-1] so the access is always defined.
  return TIER_ORDER[idx]!;
}

/**
 * Map-based so it accepts "fable" and any future tier added to CLAUDE_TIER_MODELS.
 * Uses Object.hasOwn (not `in`) to reject prototype-chain keys like
 * "__proto__", "constructor", "toString" that `in` would accept.
 */
export function isClaudeTier(s: string): s is ClaudeTier {
  return Object.hasOwn(CLAUDE_TIER_MODELS, s);
}

/** Status values for runs/stages — exported as type-safe constants. */
export const RUN_STATUS = ["pending", "running", "surfaced", "complete", "crashed", "aborted"] as const;
export type RunStatus = typeof RUN_STATUS[number];

export const STAGE_STATUS = ["open", "passed", "surfaced", "skipped"] as const;
export type StageStatus = typeof STAGE_STATUS[number];

export const ATTEMPT_STATUS = ["ok", "error", "timeout", "needs_review"] as const;
// "needs_review" (R3-tail post-mortem, 2026-05-21): the engineer self-verify
// block (engineer.md step 4.5) caught an unsanctioned anti-pattern in the
// committed diff. The attempt is recorded so the judge sees the diff, but
// finalize_stage refuses to mark the stage 'passed' until a cross-vendor
// re-judge clears the attempt. See `getStageFinalizeReadiness` blocker
// `findings_closure_rejudge`.
export type AttemptStatus = typeof ATTEMPT_STATUS[number];

export const VERDICT_OUTCOME = ["pass", "fail", "revise"] as const;
export type VerdictOutcome = typeof VERDICT_OUTCOME[number];

export const RUN_MODE = ["single", "best_of", "team", "review"] as const;
export type RunMode = typeof RUN_MODE[number];

export const VENDORS = ["openai", "google", "anthropic"] as const;
export type Vendor = typeof VENDORS[number];

export const PRODUCERS = ["codex", "agy", "claude", "copilot"] as const;
export type Producer = typeof PRODUCERS[number];

/**
 * Historical producer literal from before the Gemini CLI → Antigravity CLI
 * (agy) migration. Gemini CLI is deprecated for individual/subscription users
 * (2026-06-18); `agy` is its replacement and now owns the "google" vendor
 * lane. Rows written before the migration still have producer="gemini" —
 * `normalizeProducer` maps them onto "agy" for reads so historical runs stay
 * queryable. Never written by new code.
 */
const LEGACY_PRODUCER_ALIASES: Record<string, Producer> = { gemini: "agy" };

/** Normalize a possibly-legacy producer literal (e.g. DB rows predating the agy rename) to the current Producer enum. */
export function normalizeProducer(producer: string): Producer | null {
  if ((PRODUCERS as readonly string[]).includes(producer)) return producer as Producer;
  return LEGACY_PRODUCER_ALIASES[producer] ?? null;
}

export function vendorFor(producer: string): Vendor | null {
  const normalized = normalizeProducer(producer) ?? producer;
  if (normalized === "codex") return "openai";
  if (normalized === "agy") return "google";
  if (normalized === "claude") return "anthropic";
  if (normalized === "copilot") return "openai";
  return null;
}

/**
 * `producer` names the VENDOR that produced an attempt -- never the Claude Code
 * sub-agent role that drove it. That distinction is load-bearing: the
 * cross-vendor gate is computed by comparing `vendorFor(attempt.producer)`
 * against `vendorFor(verdict.judge_producer)` (see recordVerdict in runs.ts),
 * and `vendorFor` returns null for anything outside PRODUCERS. A role string
 * such as "tests_pre-generator" therefore resolved to null and silently
 * collapsed cross_vendor to FALSE -- making a required-cross-vendor gate
 * satisfiable by nothing, with no error raised anywhere. The sub-agent role has
 * its own column: pass it as `agent_type`.
 *
 * schema.sql previously documented "<subagent name>" as a legal producer value,
 * which is why such rows exist and were legal-per-contract rather than a rogue
 * caller. That comment has been corrected alongside this validator; the two
 * contracts now agree.
 *
 * Never coerce an unrecognized producer to a vendor. Guessing manufactures
 * exactly the provenance the cross-vendor gate exists to prove.
 */
export function producerRejectionMessage(value: string, field = "producer"): string {
  return (
    `${field} "${value}" is not a vendor id. Expected one of ${PRODUCERS.join(", ")}. ` +
    `If this is a Claude Code sub-agent role (e.g. "engineer", "tests_pre-generator"), ` +
    `pass it as agent_type and set ${field} to the vendor that actually ran it.`
  );
}

/** Zod schema for a producer literal. Use at every MCP input boundary. */
export const ProducerSchema = z
  .string()
  .min(1)
  .refine((v) => normalizeProducer(v) !== null, (v) => ({ message: producerRejectionMessage(v) }));

/**
 * Domain-layer counterpart to ProducerSchema, for call sites reached without
 * passing through an MCP schema (exported orchestrator functions, direct SQL
 * writers). Throws rather than returning a result so a bad producer can never
 * reach the attempts table.
 */
export function assertProducer(value: string, field = "producer"): void {
  if (normalizeProducer(value) === null) throw new Error(producerRejectionMessage(value, field));
}

// ─── Judge model / reasoning-effort resolution ──────────────────────────
//
// Pure helpers over JUDGE_MODEL_POLICY. No I/O, no env reads, no subprocess.
// The only producers with a judge policy are codex and agy — claude and
// copilot judge through the Task() sub-agent path and carry no CLI model pin.

/**
 * The judge policy for a producer literal, or null when that producer has no
 * policy (claude, copilot, or an unrecognized string). Legacy "gemini" rows
 * normalize onto agy via `normalizeProducer`.
 */
export function judgePolicyFor(producer: string): VendorJudgePolicy | null {
  const normalized = normalizeProducer(producer);
  if (normalized === "codex") return JUDGE_MODEL_POLICY.codex;
  if (normalized === "agy") return JUDGE_MODEL_POLICY.agy;
  return null;
}

/** True when `modelId` is allow-listed as a judge model for `producer`. */
export function isAllowedJudgeModel(producer: string, modelId: string): boolean {
  const policy = judgePolicyFor(producer);
  if (!policy) return false;
  return policy.allowed_models.includes(modelId);
}

const OVERRIDE_SOURCES: readonly JudgeOverrideSource[] = ["cli", "team_yaml", "hydra"];

/**
 * Resolve the concrete (model, reasoning_effort) a judge should run at, plus
 * the provenance of that choice.
 *
 * Deviating from a vendor's pinned default is deliberately expensive: it
 * requires BOTH an override_source naming the channel that asked for it and a
 * non-empty override_reason. The escalated lane is the one sanctioned
 * deviation and needs no reason — it is itself a pin.
 */
export function resolveJudgeSelection(opts: {
  producer: string;
  model?: string;
  escalate?: boolean;
  reasoning_effort?: string;
  override_source?: string;
  override_reason?: string;
}): { model: string; reasoning_effort: JudgeReasoningEffort; source: JudgeOverrideSource } {
  const policy = judgePolicyFor(opts.producer);
  if (!policy) {
    throw new Error(
      `producer "${opts.producer}" has no judge model policy. ` +
        `Only codex and agy carry a pinned judge model.`,
    );
  }
  const isAgy = normalizeProducer(opts.producer) === "agy";

  const rawModel = opts.model?.trim();
  const hasModel = rawModel !== undefined && rawModel !== "";
  const rawEffort = opts.reasoning_effort?.trim();
  const hasEffort = rawEffort !== undefined && rawEffort !== "";

  if (hasModel && opts.escalate === true) {
    throw new Error(
      `ambiguous judge selection: model "${rawModel}" was given together with escalate:true. ` +
        `Pass escalate:true to take the escalated pin, or pass an explicit model — not both.`,
    );
  }

  if (opts.escalate === true) {
    return {
      model: policy.escalated.model,
      reasoning_effort: policy.escalated.reasoning_effort,
      source: "escalated",
    };
  }

  if (!hasModel && !hasEffort) {
    return {
      model: policy.default.model,
      reasoning_effort: policy.default.reasoning_effort,
      source: "default",
    };
  }

  // Resolve to a concrete (model, effort) pair, validating against the policy.
  let model: string;
  let effort: JudgeReasoningEffort;

  if (isAgy) {
    // The agy resolver owns canonicalization: it collapses bare families and
    // effort suffixes into one served, suffixed id and rejects conflicts.
    const invocation = resolveAgyInvocation({ model: rawModel, reasoning_effort: rawEffort });
    model = invocation.model_id;
    effort = invocation.effort;
  } else {
    if (hasEffort && !(policy.allowed_efforts as readonly string[]).includes(rawEffort)) {
      throw new Error(
        `reasoning_effort "${rawEffort}" is not allowed for judge producer "${opts.producer}". ` +
          `allowed efforts: ${policy.allowed_efforts.join(", ")}`,
      );
    }
    if (hasModel && !policy.allowed_models.includes(rawModel)) {
      throw new Error(
        `judge model "${rawModel}" is not allow-listed for producer "${opts.producer}". ` +
          `allowed models: ${policy.allowed_models.join(", ")}`,
      );
    }
    model = hasModel ? rawModel : policy.default.model;
    effort = hasEffort ? (rawEffort as JudgeReasoningEffort) : policy.default.reasoning_effort;
  }

  const differsFromDefault =
    model !== policy.default.model || effort !== policy.default.reasoning_effort;

  if (!differsFromDefault) {
    return { model, reasoning_effort: effort, source: "default" };
  }

  const source = opts.override_source?.trim();
  const reason = opts.override_reason?.trim();
  if (
    source === undefined ||
    !(OVERRIDE_SOURCES as readonly string[]).includes(source) ||
    reason === undefined ||
    reason === ""
  ) {
    throw new Error(
      `judge selection ${model} @ ${effort} differs from the pinned default for ` +
        `"${opts.producer}" (${policy.default.model} @ ${policy.default.reasoning_effort}) — ` +
        `override requires override_source and override_reason ` +
        `(override_source must be one of ${OVERRIDE_SOURCES.join(", ")}; ` +
        `override_reason must be non-empty).`,
    );
  }

  return { model, reasoning_effort: effort, source: source as JudgeOverrideSource };
}

/**
 * Global Antigravity (agy) kill-switch. Set PP_DISABLE_AGY=1 to disable ALL
 * agy interactions (as a cross-vendor judge AND as a generation producer)
 * without removing any code, MCP registration, or team `model_pref: agy`
 * hints. Renamed from PP_DISABLE_GEMINI during the Gemini CLI → Antigravity
 * CLI migration; defaults to enabled (unset) since agy uses a different auth
 * model (system keyring / Google Sign-In) than the API-key-only Gemini CLI
 * whose auth break originally motivated this switch.
 *
 * Implemented as a function (not a top-level const) so it reads process.env on
 * every call: the daemon stays a long-running process, but this keeps the
 * behavior unit-testable by toggling the env between calls. When disabled, the
 * default cross-vendor pair becomes Codex (openai) + Claude (anthropic).
 */
export function agyEnabled(): boolean {
  return (process.env.PP_DISABLE_AGY ?? "0") !== "1";
}

// ─── Ecosystem integration (Hydra / TheEights / Constitution) ───────────
// Phase A spine. Every ecosystem call is best-effort: if the eights-daemon
// MCP peer is unreachable, all wrappers short-circuit to null and pp
// behavior is observationally identical to a standalone install.

/** Wall-clock cap on the initial eights-daemon capability probe. */
export const ECOSYSTEM_PROBE_TIMEOUT_MS = 3000;

/** Consecutive failures before a namespace breaker trips. */
export const ECOSYSTEM_BREAKER_THRESHOLD = 3;

/** How long a tripped namespace breaker stays open before retrying. */
export const ECOSYSTEM_BREAKER_COOLDOWN_MS = 60_000;

/** Per-call wall-clock cap for any eights MCP tool invocation. */
export const ECOSYSTEM_CALL_TIMEOUT_MS = 8000;

/**
 * The eight I-Ching trigram cells TheEights uses to tag every memory.
 * Mirrors `daemon/src/schemas/memory.ts:Cell` in TheEights. pp's local
 * cache of this enum lets us validate before sending and assign a
 * default cell when classify is unavailable.
 */
export const EIGHT_CELLS = [
  "vision", "context", "triggers", "influence",
  "risk", "focus", "constraints", "delight",
] as const;
export type EightCell = typeof EIGHT_CELLS[number];

/** Default cell when classification is unavailable. */
export const DEFAULT_CELL: EightCell = "context";

/** Hydra envelope types pp may receive on start_run. */
export const HYDRA_ENVELOPE_TYPES = [
  "C_SUITE_DECISION_PACKET", "PRD", "ARCH_RFC", "DEV_TASK", "HANDOFF",
] as const;
export type HydraEnvelopeType = typeof HYDRA_ENVELOPE_TYPES[number];

/**
 * The canonical HydraEnvelope `type` discriminator enum, mirroring
 * TheEights/daemon/src/schemas/hydra-envelope.ts:HydraEnvelopeType EXACTLY.
 * All values are UPPER_SNAKE — this is the ecosystem-wide canonical vocabulary
 * (TheEights Phase 3b; Hydra hydra_core/schemas.py:369-376). The inbound
 * HYDRA_ENVELOPE_TYPES list above is a separate, narrower set pp recognizes
 * on start_run and is intentionally NOT unified with this one.
 */
export const HYDRA_RECORD_ENVELOPE_TYPES = [
  "C_SUITE_DECISION_PACKET",
  "PRD",
  "ARCH_RFC",
  "DEV_TASK",
  "CREATIVE_BRIEF",
  "SHOT_LIST",
  "ASSET_JOB",
  "DECISION_RECORD",
  "HITL_REQUEST",
  "HANDOFF",
] as const;
export type HydraRecordEnvelopeType = typeof HYDRA_RECORD_ENVELOPE_TYPES[number];
