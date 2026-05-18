/**
 * Gate policy: which judge tier (cross-vendor vs same-vendor) is required
 * for each gate type, with content-aware and profile-aware upgrades. Rubric
 * selection can also honor explicit stage hints and canonical artifact kinds.
 */

import { DEFAULT_MODELS } from "../config.js";
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
  const otherVendors = ["codex", "gemini", "claude"].filter(p => vendorFor(p) !== generatorVendor);

  if (decision.required_cross_vendor) {
    return [{ agent: "judge-cross-vendor", tier: "cross_vendor", preferred_producers: otherVendors }];
  }
  return [
    { agent: "judge-same-vendor",  tier: "same_vendor",  preferred_producers: [generator_producer] },
    { agent: "judge-cross-vendor", tier: "cross_vendor", preferred_producers: otherVendors },
  ];
}

function vendorFor(producer: string): string {
  if (producer === "codex")  return "openai";
  if (producer === "gemini") return "google";
  if (producer === "claude") return "anthropic";
  return "unknown";
}
