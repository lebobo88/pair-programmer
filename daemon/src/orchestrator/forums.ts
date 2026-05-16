/**
 * Governance forum definitions (Section 8 of taxonomy_blueprint.md).
 * Each forum maps to a fixed pipeline of stages + rubric bindings. The
 * /pp:review <forum> command runs this pipeline against a scope (files,
 * stage, run, or whole project).
 */

export type ForumStage = {
  kind: string;
  artifact_kind?: string;
  gate_type: "spec" | "design" | "security" | "contract" | "code_style" | "docs_polish" | "lint_class";
  generator_agent: string;
  judge_tier: "cross_vendor" | "same_vendor";
  rubric_id?: string;
};

export type Forum = {
  id: string;
  title: string;
  description: string;
  produces: string;
  stages: ForumStage[];
  required_missability_checks: string[];
};

export const FORUMS: Forum[] = [
  {
    id: "framing",
    title: "Problem framing / discovery review",
    description: "Confirms the problem, target users, and success metric before scope work begins.",
    produces: "Problem statement, evidence, success metrics",
    stages: [
      { kind: "problem_statement", gate_type: "spec", generator_agent: "strategy-author", judge_tier: "cross_vendor", rubric_id: "rfc-2119-normative@1" },
      { kind: "evidence",         gate_type: "spec", generator_agent: "discovery-researcher", judge_tier: "cross_vendor" },
      { kind: "success_metrics",  gate_type: "spec", generator_agent: "strategy-author", judge_tier: "cross_vendor", rubric_id: "rfc-2119-normative@1" },
    ],
    required_missability_checks: ["decision-logging"],
  },
  {
    id: "scope",
    title: "Scope and requirements review",
    description: "Locks scope boundaries, functional + non-functional requirements, acceptance criteria.",
    produces: "PRD, acceptance criteria, NFRs",
    stages: [
      { kind: "prd",                  gate_type: "spec", generator_agent: "spec-author",       judge_tier: "cross_vendor", rubric_id: "rfc-2119-normative@1" },
      { kind: "acceptance_criteria",  gate_type: "spec", generator_agent: "spec-author",       judge_tier: "cross_vendor", rubric_id: "rfc-2119-normative@1" },
      { kind: "non_functional_reqs",  gate_type: "spec", generator_agent: "spec-author",       judge_tier: "cross_vendor", rubric_id: "rfc-2119-normative@1" },
    ],
    required_missability_checks: ["nfrs-declared", "authz-model"],
  },
  {
    id: "design",
    title: "Design review (UX/UI/content/accessibility)",
    description: "Flows, states, components, accessibility plan, content guide.",
    produces: "Flows + screen-state matrix + a11y plan",
    stages: [
      { kind: "user_flows",          gate_type: "design", generator_agent: "designer", judge_tier: "cross_vendor", rubric_id: "rfc-2119-normative@1" },
      { kind: "screen_state_matrix", gate_type: "design", generator_agent: "designer", judge_tier: "cross_vendor", rubric_id: "wcag-2.2-aa@1" },
      { kind: "a11y_plan",           gate_type: "design", generator_agent: "designer", judge_tier: "cross_vendor", rubric_id: "wcag-2.2-aa@1" },
    ],
    required_missability_checks: ["ui-error-empty-loading", "accessibility-localization"],
  },
  {
    id: "architecture",
    title: "Architecture review",
    description: "C4 context + ADRs + topology.",
    produces: "C4 diagrams + ADRs",
    stages: [
      { kind: "system_context",   gate_type: "design", generator_agent: "architect", judge_tier: "cross_vendor", rubric_id: "c4-system-context@1" },
      { kind: "adrs",             gate_type: "design", generator_agent: "architect", judge_tier: "cross_vendor", rubric_id: "rfc-2119-normative@1" },
      { kind: "runtime_topology", gate_type: "design", generator_agent: "architect", judge_tier: "cross_vendor", rubric_id: "c4-system-context@1" },
    ],
    required_missability_checks: ["schema-evolution", "decision-logging"],
  },
  {
    id: "contract",
    title: "API / contract review",
    description: "OpenAPI/AsyncAPI + versioning rule + compatibility ADR.",
    produces: "OpenAPI/AsyncAPI + versioning rule",
    stages: [
      { kind: "openapi",         gate_type: "contract", generator_agent: "api-designer", judge_tier: "cross_vendor", rubric_id: "openapi-3.1-stability@1" },
      { kind: "versioning_rule", gate_type: "spec",     generator_agent: "spec-author",   judge_tier: "cross_vendor", rubric_id: "rfc-2119-normative@1" },
    ],
    required_missability_checks: ["third-party-failure"],
  },
  {
    id: "threat",
    title: "Threat / privacy review",
    description: "STRIDE threat model + control mapping (OWASP ASVS).",
    produces: "Threat model + control matrix",
    stages: [
      { kind: "threat_model",   gate_type: "security", generator_agent: "security-reviewer", judge_tier: "cross_vendor", rubric_id: "owasp-asvs-l1@1" },
      { kind: "control_mapping",gate_type: "security", generator_agent: "security-reviewer", judge_tier: "cross_vendor", rubric_id: "owasp-asvs-l1@1" },
    ],
    required_missability_checks: ["security-review-timing", "supply-chain-integrity"],
  },
  {
    id: "test-readiness",
    title: "Test readiness review",
    description: "Test strategy + critical-path coverage + environment readiness.",
    produces: "Test strategy + plan",
    stages: [
      { kind: "test_strategy",  gate_type: "contract", generator_agent: "test-strategist", judge_tier: "cross_vendor" },
      { kind: "test_plan",      gate_type: "contract", generator_agent: "test-strategist", judge_tier: "cross_vendor" },
    ],
    required_missability_checks: ["test-data-management", "ai-evals-hitl"],
  },
  {
    id: "release-readiness",
    title: "Release readiness review",
    description: "Rollout + rollback + comms + ownership.",
    produces: "Rollout + rollback + comms",
    stages: [
      { kind: "rollout_plan",  gate_type: "design",      generator_agent: "release-planner", judge_tier: "cross_vendor", rubric_id: "rfc-2119-normative@1" },
      { kind: "rollback_plan", gate_type: "design",      generator_agent: "release-planner", judge_tier: "cross_vendor" },
      { kind: "comms",         gate_type: "docs_polish", generator_agent: "docs-author",     judge_tier: "same_vendor" },
    ],
    required_missability_checks: ["operational-ownership", "feature-flag-lifecycle", "rollout-reversibility", "doc-ownership"],
  },
  {
    id: "incident",
    title: "Incident review / postmortem",
    description: "Root cause + corrective actions + ownership.",
    produces: "Postmortem + corrective actions",
    stages: [
      { kind: "postmortem",        gate_type: "spec",        generator_agent: "ops-author", judge_tier: "cross_vendor", rubric_id: "rfc-2119-normative@1" },
      { kind: "corrective_actions",gate_type: "spec",        generator_agent: "ops-author", judge_tier: "cross_vendor", rubric_id: "rfc-2119-normative@1" },
    ],
    required_missability_checks: ["decision-logging"],
  },
  {
    id: "service",
    title: "Service review",
    description: "SLOs, incidents, usage, support, cost.",
    produces: "Service-review deck",
    stages: [
      { kind: "slo_status",      gate_type: "spec",        generator_agent: "ops-author", judge_tier: "cross_vendor" },
      { kind: "incident_summary",gate_type: "docs_polish", generator_agent: "ops-author", judge_tier: "same_vendor" },
      { kind: "usage_cost",      gate_type: "docs_polish", generator_agent: "ops-author", judge_tier: "same_vendor" },
    ],
    required_missability_checks: ["operational-ownership", "supportability", "third-party-failure"],
  },
];

export const FORUM_BY_ID: Record<string, Forum> = Object.fromEntries(FORUMS.map(f => [f.id, f]));

export function listForums(): Array<Pick<Forum, "id" | "title" | "description" | "produces">> {
  return FORUMS.map(({ id, title, description, produces }) => ({ id, title, description, produces }));
}

export function getForum(id: string): Forum | null {
  return FORUM_BY_ID[id] ?? null;
}
