/**
 * Gate policy: which judge tier (cross-vendor vs same-vendor) is required
 * for each gate type, with content-aware and profile-aware upgrades. Rubric
 * selection can also honor explicit stage hints and canonical artifact kinds.
 */

import { DEFAULT_MODELS, geminiEnabled } from "../config.js";
import type { ProfileName } from "./profiles.js";
import { getRubric } from "../rubrics/registry.js";

export type GateType =
  | "spec" | "design" | "security" | "contract"
  | "code_style" | "docs_polish" | "lint_class";

export type Tier = "cross_vendor" | "same_vendor";

export type Profile = ProfileName;

const BASE_TIERS: Record<GateType, Tier> = {
  spec:        "cross_vendor",
  design:      "cross_vendor",
  security:    "cross_vendor",
  contract:    "cross_vendor",
  code_style:  "same_vendor",
  docs_polish: "same_vendor",
  lint_class:  "same_vendor",
};

/** Keywords that force cross-vendor judging regardless of base gate type. */
const ESCALATION_RE = new RegExp(
  [
    "\\b(concurren|thread|race|deadlock|atomic|mutex|lock)\\w*",
    // auth-family deliberately drops the leading \b so "OAuth", "OpenID",
    // "SAML", "JWT" still trigger; same for security-family.
    "(?:auth|oauth|openid|saml|jwt|sso)",
    "\\b(security|permission|secret|token|credential|password|api[_-]?key)\\w*",
    "\\b(migrat|schema|rollback|transactional)\\w*",
    "\\b(cryptograph|encrypt|decrypt|tls|ssl|hash|signature)\\w*",
    "\\b(privacy|gdpr|pii|phi|hipaa|sox)\\w*",
    "\\b(injection|xss|csrf|sqli|escape)\\w*",
  ].join("|"),
  "i",
);

/** Profiles that force cross-vendor on every gate. */
const FORCED_CROSS_VENDOR_PROFILES = new Set<Profile>(["enterprise"]);

/** Profiles that force cross-vendor for gates touching evals or tool permissions. */
const AI_AGENTIC_KEYWORDS = /\b(eval|model|tool|permission|hitl|hallucin|prompt[_-]?inject)\w*/i;

export type RubricSelection = string | null;

const ARTIFACT_KIND_RUBRICS: Record<string, RubricSelection> = {
  openapi: "openapi-3.1-stability@1",
  asyncapi: "asyncapi-3.1-stability@1",
  supabase: "supabase-contract-stability@1",
  supabase_contract: "supabase-contract-stability@1",
  postgrest: "supabase-contract-stability@1",
  screen_state_matrix: "wcag-2.2-aa@1",
  browser_validation_report: "web-runtime-validation@2",
  test_strategy: null,
  test_plan: null,
  contract_tests: null,
  token_contract_tests: null,
  tdd_manifest: null,
  tdd_notes: null,
  performance_budget: null,
  performance_profile: null,
};

export type GateDecision = {
  required_cross_vendor: boolean;
  base_tier: Tier;
  upgraded: boolean;
  reason: string;
  rubric_id: RubricSelection;
};

export type SameVendorCapability = {
  available: boolean;
  effective_generator_model: string | null;
  inferred_generator_model: boolean;
  judge_model_id: string | null;
  reason: string | null;
};

export type JudgeCapabilitySummary = {
  critique_model: string | null;
  same_vendor_mode: "conditional_cross_vendor" | "degenerate_same_model_allowed" | "driver_selected";
  unavailable_when_generator_model_is: string[];
  notes: string;
};

export function defaultGeneratorModelForProducer(producer: string): string | null {
  if (producer === "codex") return DEFAULT_MODELS.codex_generate;
  if (producer === "gemini") return DEFAULT_MODELS.gemini_generate;
  return null;
}

export function resolveSameVendorCapability(opts: {
  generator_producer: string;
  generator_model?: string | null;
}): SameVendorCapability {
  const explicitModel =
    typeof opts.generator_model === "string" && opts.generator_model.trim().length > 0
      ? opts.generator_model.trim()
      : null;
  const fallbackModel = defaultGeneratorModelForProducer(opts.generator_producer);
  const effectiveGeneratorModel = explicitModel ?? fallbackModel;
  const inferredGeneratorModel = explicitModel === null && fallbackModel !== null;

  if (opts.generator_producer === "codex") {
    const judgeModel = DEFAULT_MODELS.codex_critique;
    if (effectiveGeneratorModel === judgeModel) {
      return {
        available: false,
        effective_generator_model: effectiveGeneratorModel,
        inferred_generator_model: inferredGeneratorModel,
        judge_model_id: judgeModel,
        reason:
          `same-vendor Codex judging is unavailable when generator_model resolves to "${judgeModel}" ` +
          `because pp_codex.critique is hard-pinned to that same model. Use cross-vendor judging instead.`,
      };
    }
    return {
      available: true,
      effective_generator_model: effectiveGeneratorModel,
      inferred_generator_model: inferredGeneratorModel,
      judge_model_id: judgeModel,
      reason: null,
    };
  }

  if (opts.generator_producer === "gemini") {
    return {
      available: true,
      effective_generator_model: effectiveGeneratorModel,
      inferred_generator_model: inferredGeneratorModel,
      judge_model_id: DEFAULT_MODELS.gemini_critique,
      reason: null,
    };
  }

  return {
    available: true,
    effective_generator_model: effectiveGeneratorModel,
    inferred_generator_model: inferredGeneratorModel,
    judge_model_id: null,
    reason: null,
  };
}

export function describeJudgeCapabilities(): Record<string, JudgeCapabilitySummary> {
  return {
    codex: {
      critique_model: DEFAULT_MODELS.codex_critique,
      same_vendor_mode: "conditional_cross_vendor",
      unavailable_when_generator_model_is: [DEFAULT_MODELS.codex_critique],
      notes:
        `pp_codex.critique is hard-pinned to "${DEFAULT_MODELS.codex_critique}". ` +
        `Same-vendor Codex judging is only available when the generator used a different model id.`,
    },
    gemini: {
      critique_model: DEFAULT_MODELS.gemini_critique,
      same_vendor_mode: "degenerate_same_model_allowed",
      unavailable_when_generator_model_is: [],
      notes:
        `pp_gemini.critique is hard-pinned to "${DEFAULT_MODELS.gemini_critique}". ` +
        "Only one supported 3.x Gemini critique model is currently served, so same-vendor Gemini judging is degenerate.",
    },
    claude: {
      critique_model: null,
      same_vendor_mode: "driver_selected",
      unavailable_when_generator_model_is: [],
      notes:
        "Claude same-vendor judging happens in-process. The driver and judge prompts must choose a Claude model id different from the generator.",
    },
  };
}

export function evaluateGate(opts: {
  gate_type: GateType;
  generator_producer?: string;
  generator_model?: string | null;
  prompt_keywords?: string;        // freeform text scanned for escalation triggers
  profile?: Profile | null;
  artifact_kind?: string | null;   // e.g. "screen_state_matrix" — Phase 6 maps this to a rubric
  rubric_hint?: string | null;     // optional stage-declared rubric id
}): GateDecision {
  const base = BASE_TIERS[opts.gate_type] ?? "same_vendor";
  let required = base === "cross_vendor";
  let upgraded = false;
  let reason = `base tier for gate_type=${opts.gate_type} is ${base}`;

  if (opts.profile && FORCED_CROSS_VENDOR_PROFILES.has(opts.profile)) {
    if (!required) { upgraded = true; reason = `profile=${opts.profile} forces cross-vendor on every gate`; }
    required = true;
  }

  if (opts.profile === "ai-agentic" && opts.prompt_keywords && AI_AGENTIC_KEYWORDS.test(opts.prompt_keywords)) {
    if (!required) { upgraded = true; reason = `ai-agentic profile + eval/tool/HITL keyword forces cross-vendor`; }
    required = true;
  }

  if (opts.prompt_keywords && ESCALATION_RE.test(opts.prompt_keywords)) {
    if (!required) {
      upgraded = true;
      reason = `prompt content matches escalation keywords (concurrency / security / data-integrity); forcing cross-vendor`;
    }
    required = true;
  }

  if (!required && opts.generator_producer) {
    const capability = resolveSameVendorCapability({
      generator_producer: opts.generator_producer,
      generator_model: opts.generator_model,
    });
    if (!capability.available) {
      required = true;
      upgraded = true;
      reason = capability.reason ?? `same-vendor judging is unavailable for producer=${opts.generator_producer}`;
    }
  }

  return {
    required_cross_vendor: required,
    base_tier: base,
    upgraded,
    reason,
    rubric_id: pickDefaultRubric(opts.gate_type, opts.profile, opts.artifact_kind, opts.rubric_hint, opts.prompt_keywords),
  };
}

/** Phase 6 expands this with the full 13-rubric registry. Phase 2 ships defaults. */
const SUPABASE_HINT_RE = /\b(supabase|postgrest|row[\s_-]?level[\s_-]?security|\brls\b|auth\.uid\(\))/i;

function pickDefaultRubric(
  gate_type: GateType,
  profile?: Profile | null,
  artifact_kind?: string | null,
  rubric_hint?: string | null,
  prompt_keywords?: string,
): RubricSelection {
  const hinted = normalizeRubricHint(rubric_hint);
  if (hinted) return hinted;

  const normalizedKind = normalizeArtifactKind(artifact_kind);
  if (
    normalizedKind &&
    Object.prototype.hasOwnProperty.call(ARTIFACT_KIND_RUBRICS, normalizedKind)
  ) {
    return ARTIFACT_KIND_RUBRICS[normalizedKind] ?? null;
  }

  if (gate_type === "contract" && prompt_keywords && SUPABASE_HINT_RE.test(prompt_keywords)) {
    return "supabase-contract-stability@1";
  }

  if (gate_type === "security")                  return profile === "enterprise" ? "owasp-asvs-l2@1" : "owasp-asvs-l1@1";
  if (gate_type === "design")                    return profile === "web-ui" ? "wcag-2.2-aa@1" : "c4-system-context@1";
  if (gate_type === "contract")                  return "openapi-3.1-stability@1";
  if (gate_type === "spec")                      return "rfc-2119-normative@1";
  return null;
}

function normalizeArtifactKind(artifactKind?: string | null): string | null {
  if (typeof artifactKind !== "string") return null;
  const normalized = artifactKind.trim().toLowerCase();
  return normalized.length > 0 ? normalized : null;
}

function normalizeRubricHint(rubricHint?: string | null): string | null {
  if (typeof rubricHint !== "string") return null;
  const normalized = rubricHint.trim();
  if (!normalized) return null;
  return getRubric(normalized) ? normalized : null;
}

export type AllowedJudge = {
  agent: "judge-cross-vendor" | "judge-same-vendor";
  tier: Tier;
  preferred_producers: string[];   // hint for the judge agent on which provider to use
};

export function listAllowedJudges(decision: GateDecision, generator_producer: string): AllowedJudge[] {
  const generatorVendor = vendorFor(generator_producer);
  // Honor the global Gemini kill-switch (PP_DISABLE_GEMINI=1). This is the one
  // judge-selection path that does NOT flow through doctor()'s vendor matrix,
  // so it must consult geminiEnabled() directly — otherwise the preferred_producers
  // hint returned by gate_eligible_judges could still point the driver at Gemini,
  // on EITHER the cross-vendor pool or (for a gemini generator) the same-vendor lane.
  const pool = geminiEnabled() ? ["codex", "gemini", "claude"] : ["codex", "claude"];
  const otherVendors = pool.filter(p => vendorFor(p) !== generatorVendor);

  if (decision.required_cross_vendor) {
    return [{ agent: "judge-cross-vendor", tier: "cross_vendor", preferred_producers: otherVendors }];
  }

  const judges: AllowedJudge[] = [];
  // Drop the same-vendor lane only when it would point at a disabled vendor
  // (currently just the gemini lane under PP_DISABLE_GEMINI=1). All other
  // producers — codex, claude, copilot — keep their existing same-vendor
  // behavior unchanged. The cross-vendor judge below is always offered and is
  // never empty (a gemini generator still falls back to codex/claude).
  const sameVendorDisabled = generator_producer === "gemini" && !geminiEnabled();
  if (!sameVendorDisabled) {
    judges.push({ agent: "judge-same-vendor", tier: "same_vendor", preferred_producers: [generator_producer] });
  }
  judges.push({ agent: "judge-cross-vendor", tier: "cross_vendor", preferred_producers: otherVendors });
  return judges;
}

function vendorFor(producer: string): string {
  if (producer === "codex")  return "openai";
  if (producer === "gemini") return "google";
  if (producer === "claude") return "anthropic";
  return "unknown";
}

// ─── Tail-fix producer selection (R3-tail post-mortem Fix 1.1, 2026-05-21) ───
//
// When a code stage enters Reflexion retry territory AND the remaining work
// is surgical (small diff, few files), the R3-tail post-mortem found that
// switching from `engineer` to `test-strategist` stabilized convergence.
// `test-strategist` is daemon-verified via tdd_pre_check / tdd_post_check so
// its claims are executable, not assertional — that's the property that
// stopped the engineer's regression-trading pattern in tail-fix-1..5.
//
// This helper exposes the recommendation to the slash-command driver. The
// driver remains authoritative — it can override on operator request — but
// without an explicit override, the driver should honor the recommendation.

export type TailFixProducerInput = {
  /** Most recent attempt on the stage, including its post-step-4.5 notes. */
  prior_attempt: {
    producer: string;
    status: string;                                    // AttemptStatus
    notes_json: string | null;
  };
  /** Latest critique on that attempt (any verdict). Empty when none yet. */
  latest_critique_md: string;
  /** When the stage's team yaml specifies it; used as the default. */
  team_default_agent: string;
};

export type TailFixProducerDecision = {
  /** Agent the driver should dispatch on retry. */
  recommended_agent: "engineer" | "test-strategist";
  /** Human-readable reason for the recommendation. */
  reason: string;
  /** Stable signals used by the heuristic, exposed for trace / logging. */
  signals: {
    diff_loc_estimate: number | null;
    files_mentioned: number;
    has_findings_closed: boolean;
    has_anti_pattern_hits: boolean;
    status_needs_review: boolean;
  };
};

/**
 * Pure function — no DB access — so it's trivially unit-testable. The
 * driver computes the inputs (prior_attempt row + latest critique text) and
 * passes them in. Returns the producer recommendation + reasoning trace.
 */
export function selectTailFixProducer(input: TailFixProducerInput): TailFixProducerDecision {
  let notes: {
    findings_closed?: Array<{ id: string; file: string; lines: string; claim: string }>;
    anti_pattern_hits?: Array<{ file: string; line: number; pattern: string }>;
  } = {};
  if (input.prior_attempt.notes_json) {
    try { notes = JSON.parse(input.prior_attempt.notes_json); } catch { /* malformed; treat as empty */ }
  }
  const findingsClosed = notes.findings_closed ?? [];
  const antiPatternHits = notes.anti_pattern_hits ?? [];
  const statusNeedsReview = input.prior_attempt.status === "needs_review";

  // Count distinct files cited in either notes or the critique. The critique
  // often calls out specific paths; the notes always do (lines: "10-20"
  // implies one file per entry). We don't try to be exhaustive — a small
  // sample is enough to drive the heuristic.
  const filesFromFindings = new Set(findingsClosed.map(f => f.file));
  const filesFromAntiPatterns = new Set(antiPatternHits.map(h => h.file));
  // The critique often cites file paths via inline backticks or
  // `path/to/file.ts:line`. We grep them with a forgiving regex.
  const filesFromCritique = new Set<string>();
  const filePathRe = /(?:^|[\s`(])([a-zA-Z0-9_./-]+\.[a-zA-Z]{1,5})(?::\d+)?/g;
  for (const match of input.latest_critique_md.matchAll(filePathRe)) {
    filesFromCritique.add(match[1]!);
  }
  const allFiles = new Set([
    ...filesFromFindings,
    ...filesFromAntiPatterns,
    ...filesFromCritique,
  ]);
  const filesMentioned = allFiles.size;

  // Estimate diff_loc from findings_closed line ranges (e.g., "10-20" → 11).
  // Best-effort — no diff_loc in notes means we fall back to file count alone.
  let diffLocEstimate: number | null = null;
  for (const f of findingsClosed) {
    const m = f.lines.match(/^(\d+)-(\d+)$/);
    if (!m) continue;
    const span = Math.max(0, parseInt(m[2]!, 10) - parseInt(m[1]!, 10) + 1);
    diffLocEstimate = (diffLocEstimate ?? 0) + span;
  }

  const signals = {
    diff_loc_estimate: diffLocEstimate,
    files_mentioned: filesMentioned,
    has_findings_closed: findingsClosed.length > 0,
    has_anti_pattern_hits: antiPatternHits.length > 0,
    status_needs_review: statusNeedsReview,
  };

  // The heuristic: prefer test-strategist for surgical tail-fixes.
  //
  //   surgical_diff  =  diff_loc < 50 (when known)
  //   surgical_files =  <= 2 files cited
  //
  // We require BOTH signals to be present (small AND focused) before
  // switching producers. Anti-pattern hits alone (no findings_closed)
  // are usually trivial fixes (renames, ts-ignore removal) — still
  // engineer-shaped. The R3-tail pattern that worked was: small diff,
  // 1-2 files, explicit per-line patches from the critique.
  const surgicalDiff = diffLocEstimate === null || diffLocEstimate < 50;
  const surgicalFiles = filesMentioned > 0 && filesMentioned <= 2;
  // status=needs_review also pushes toward test-strategist — the engineer
  // already self-flagged it can't ship, so a daemon-verified producer is
  // more likely to converge than another engineer attempt.

  if (statusNeedsReview && surgicalFiles) {
    return {
      recommended_agent: "test-strategist",
      reason:
        `prior attempt self-flagged needs_review and the critique scope is surgical ` +
        `(${filesMentioned} file(s) mentioned${diffLocEstimate !== null ? `, ~${diffLocEstimate} LoC` : ""}). ` +
        `Switching to test-strategist whose tdd_pre/post_check gate is daemon-verified ` +
        `(executable, not assertional) — R3-tail tail-fix-1..5 pattern.`,
      signals,
    };
  }

  if (surgicalDiff && surgicalFiles && findingsClosed.length > 0) {
    return {
      recommended_agent: "test-strategist",
      reason:
        `surgical tail-fix detected (${filesMentioned} file(s)` +
        `${diffLocEstimate !== null ? `, ~${diffLocEstimate} LoC` : ""}, ` +
        `${findingsClosed.length} prior findings claimed closed). ` +
        `Switching to test-strategist for the retry — R3-tail Fix 1.1.`,
      signals,
    };
  }

  // Default: keep the original generator. Engineer is appropriate when the
  // diff is wide or the work isn't yet bounded.
  return {
    recommended_agent: input.team_default_agent === "test-strategist"
      ? "test-strategist"
      : "engineer",
    reason:
      `scope is not surgical (${filesMentioned} file(s) mentioned` +
      `${diffLocEstimate !== null ? `, ~${diffLocEstimate} LoC` : ""}). ` +
      `Retaining team yaml's primary agent (${input.team_default_agent}).`,
    signals,
  };
}
