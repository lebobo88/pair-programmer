/**
 * Centralized constants. Avoid spreading magic numbers across the codebase.
 */

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
 * Pinned model defaults per (vendor, operation). Sub-agents are required to
 * pass `model` explicitly (see judge-cross-vendor / judge-same-vendor / engineer
 * agent prompts), but if the schema default fires it must point at a model the
 * installed CLI version actually serves. Keep in sync with `daemon/prices.json`.
 *
 * NOTE: `agy --model <id>` does NOT validate the id — an unrecognized model
 * string is silently accepted and the CLI falls back to its own default
 * rather than erroring. Run `agy models` after changing agy_generate /
 * agy_critique to confirm the id is still recognized; exit code 0 alone does
 * not prove the intended model actually served the request.
 */
export const DEFAULT_MODELS = {
  codex_generate:            "gpt-5.4",
  codex_critique:            "gpt-5.4",   // constitutional default (JUDGE-1) — do NOT change
  codex_critique_escalated:  "gpt-5.5",   // opt-in escalation for major-scope/last-resort gates
  agy_generate:              "gemini-3.1-pro-preview",
  agy_critique:              "gemini-3.1-pro-preview",
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
  opus:   "claude-opus-4-7",
  sonnet: "claude-sonnet-4-6",
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
 * GitHub Copilot mirrors intentionally pin Opus one rev lower than the shared
 * Claude entrypoint. Keep this divergence explicit so the daemon can expose a
 * Copilot-only tier map without changing the Claude defaults above.
 */
export const COPILOT_CLAUDE_TIER_MODELS = {
  opus:   "claude-opus-4-6",
  sonnet: "claude-sonnet-4-6",
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

/** Set PP_COPILOT_FALLBACK=0 to disable the copilot CLI fallback for codex/agy. */
export const COPILOT_FALLBACK_ENABLED =
  (process.env.PP_COPILOT_FALLBACK ?? "1") !== "0";

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
