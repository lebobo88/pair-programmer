/**
 * Gate policy: which judge tier (cross-vendor vs same-vendor) is required
 * for each gate type, with content-aware and profile-aware upgrades.
 */

export type GateType =
  | "spec" | "design" | "security" | "contract"
  | "code_style" | "docs_polish" | "lint_class";

export type Tier = "cross_vendor" | "same_vendor";

export type Profile =
  | "web-ui" | "api-platform" | "internal-tool" | "enterprise"
  | "ai-agentic" | "mobile" | "sdk" | "data-product"
  | "embedded" | "non-ui-cli";

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

export type GateDecision = {
  required_cross_vendor: boolean;
  base_tier: Tier;
  upgraded: boolean;
  reason: string;
  rubric_id: RubricSelection;
};

export function evaluateGate(opts: {
  gate_type: GateType;
  prompt_keywords?: string;        // freeform text scanned for escalation triggers
  profile?: Profile | null;
  artifact_kind?: string | null;   // e.g. "screen_state_matrix" — Phase 6 maps this to a rubric
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

  return {
    required_cross_vendor: required,
    base_tier: base,
    upgraded,
    reason,
    rubric_id: pickDefaultRubric(opts.gate_type, opts.profile, opts.artifact_kind),
  };
}

/** Phase 6 expands this with the full 13-rubric registry. Phase 2 ships defaults. */
function pickDefaultRubric(
  gate_type: GateType,
  profile?: Profile | null,
  artifact_kind?: string | null
): RubricSelection {
  if (artifact_kind === "screen_state_matrix")  return "wcag-2.2-aa@1";
  if (gate_type === "security")                  return profile === "enterprise" ? "owasp-asvs-l2@1" : "owasp-asvs-l1@1";
  if (gate_type === "design")                    return profile === "web-ui" ? "wcag-2.2-aa@1" : "c4-system-context@1";
  if (gate_type === "contract")                  return "openapi-3.1-stability@1";
  if (gate_type === "spec")                      return "rfc-2119-normative@1";
  return null;
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
