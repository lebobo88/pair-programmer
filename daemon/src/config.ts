/**
 * Centralized constants. Avoid spreading magic numbers across the codebase.
 */

/** Default ceiling on validator (judge) calls per single run. Phase 4 enforces. */
export const DEFAULT_LOOP_CEILING = 6;

/** Wall-clock timeout per sub-CLI generator/judge call. */
export const DEFAULT_CLI_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * Server-side retries on top of the original sub-CLI invocation. Applied per
 * call in `codexGenerate` / `geminiGenerate` when stderr does NOT match the
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
 */
export const DEFAULT_MODELS = {
  codex_generate:  "gpt-5.4",
  codex_critique:  "gpt-5.4",
  gemini_generate: "gemini-3.1-pro-preview",
  gemini_critique: "gemini-3.1-pro-preview",
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
} as const;

export type ClaudeTier = keyof typeof CLAUDE_TIER_MODELS;

/** Ladder, low → high. shiftTier walks this. */
export const TIER_ORDER: ClaudeTier[] = ["haiku", "sonnet", "opus"];

export function tierIndex(t: ClaudeTier): number {
  return TIER_ORDER.indexOf(t);
}

/** Shift a tier by N steps; clamps at the ends of the ladder. */
export function shiftTier(t: ClaudeTier, delta: number): ClaudeTier {
  const idx = Math.max(0, Math.min(TIER_ORDER.length - 1, tierIndex(t) + delta));
  // idx is clamped to [0, TIER_ORDER.length-1] so the access is always defined.
  return TIER_ORDER[idx]!;
}

export function isClaudeTier(s: string): s is ClaudeTier {
  return s === "opus" || s === "sonnet" || s === "haiku";
}

/** Status values for runs/stages — exported as type-safe constants. */
export const RUN_STATUS = ["pending", "running", "surfaced", "complete", "crashed", "aborted"] as const;
export type RunStatus = typeof RUN_STATUS[number];

export const STAGE_STATUS = ["open", "passed", "surfaced", "skipped"] as const;
export type StageStatus = typeof STAGE_STATUS[number];

export const ATTEMPT_STATUS = ["ok", "error", "timeout"] as const;
export type AttemptStatus = typeof ATTEMPT_STATUS[number];

export const VERDICT_OUTCOME = ["pass", "fail", "revise"] as const;
export type VerdictOutcome = typeof VERDICT_OUTCOME[number];

export const RUN_MODE = ["single", "best_of", "team", "review"] as const;
export type RunMode = typeof RUN_MODE[number];

export const VENDORS = ["openai", "google", "anthropic"] as const;
export type Vendor = typeof VENDORS[number];

export const PRODUCERS = ["codex", "gemini", "claude"] as const;
export type Producer = typeof PRODUCERS[number];

export function vendorFor(producer: string): Vendor | null {
  if (producer === "codex") return "openai";
  if (producer === "gemini") return "google";
  if (producer === "claude") return "anthropic";
  return null;
}
