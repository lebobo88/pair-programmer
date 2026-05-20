/**
 * Taxonomy data — the 16 sections from taxonomy_blueprint.md plus the
 * 20-item missability checklist (Section 6) and Section 9's master-plan
 * template. Used by the taxonomy mapper, master-plan patcher, and
 * missability inspector.
 */

export type TaxonomySection = {
  id: string;            // "4.1" .. "4.16"
  title: string;
  default_artifact_kinds: string[];   // canonical kinds this section produces
  master_plan_section: string;        // section number in Section 9 template
};

export const TAXONOMY_SECTIONS: TaxonomySection[] = [
  { id: "4.1",  title: "Strategy, business context, and investment logic",       default_artifact_kinds: ["vision_brief", "business_case", "okrs", "one_pager"],          master_plan_section: "2. Business and portfolio context" },
  { id: "4.2",  title: "User, market, workflow, and domain understanding",       default_artifact_kinds: ["research_brief", "personas", "journey_map"],     master_plan_section: "3. Stakeholders and users" },
  { id: "4.3",  title: "Product scope, requirements, and prioritization",        default_artifact_kinds: ["prd", "feature_spec", "acceptance_criteria", "gdd", "vertical_slice_scope", "mechanic_spec"],    master_plan_section: "6. Functional requirements" },
  { id: "4.4",  title: "Experience design, content, and accessibility",           default_artifact_kinds: ["ia_map", "user_flow", "screen_state_matrix", "wireframes", "design_tokens", "component_specs", "a11y_plan", "art_bible", "sound_design_doc", "narrative_bible", "dialogue_tree_spec", "level_greybox", "encounter_design_doc", "accessibility_plan", "localization_plan"], master_plan_section: "9. UX/UI/content design" },
  { id: "4.5",  title: "Domain model, data, analytics, and information lifecycle", default_artifact_kinds: ["erd", "data_dictionary", "lineage_map", "retention_policy", "migration_plan", "economy_spreadsheet", "progression_curve", "loot_table", "balance_matrix", "telemetry_event_taxonomy"], master_plan_section: "10. Domain and data model" },
  { id: "4.6",  title: "Architecture and technical strategy",                     default_artifact_kinds: ["adr", "c4_diagram", "deployment_arch", "tech_design_doc", "addressables_strategy", "asmdef_layout", "gas_design", "world_partition_plan", "scene_topology"],          master_plan_section: "11. Architecture and technical strategy" },
  { id: "4.7",  title: "Interfaces, contracts, and integration wiring",           default_artifact_kinds: ["openapi", "asyncapi", "route_inventory", "event_catalog"], master_plan_section: "12. Interfaces and contracts" },
  { id: "4.8",  title: "Engineering implementation system and code quality",     default_artifact_kinds: ["coding_standard", "review_checklist", "diff", "code"], master_plan_section: "13. Engineering standards and delivery model" },
  { id: "4.9",  title: "Security, privacy, compliance, and trust",                default_artifact_kinds: ["threat_model", "control_matrix", "pia", "sbom"], master_plan_section: "14. Security, privacy, and compliance" },
  { id: "4.10", title: "Quality engineering and verification",                    default_artifact_kinds: ["test_strategy", "test_plan", "contract_tests", "performance_budget", "performance_profile"], master_plan_section: "15. Test and verification strategy" },
  { id: "4.11", title: "Delivery, environments, release, and change management", default_artifact_kinds: ["rollout_plan", "rollback_plan", "migration_runbook", "release_notes", "build_release_plan", "cert_submission_packet", "liveops_season_plan"], master_plan_section: "19. Launch, migration, and rollback plan" },
  { id: "4.12", title: "Observability, reliability, operations, and support",     default_artifact_kinds: ["slo_doc", "telemetry_taxonomy", "runbook", "alert_catalog"], master_plan_section: "16. Operations and support model" },
  { id: "4.13", title: "Documentation, enablement, and knowledge management",     default_artifact_kinds: ["changelog", "release_notes", "runbook", "user_doc", "patch_notes", "post_mortem", "agents_md", "claude_md"], master_plan_section: "Appendices" },
  { id: "4.14", title: "Team operating model, decision governance, and execution cadence", default_artifact_kinds: ["raci", "decision_log", "delivery_plan"], master_plan_section: "17. Team operating model and governance" },
  { id: "4.15", title: "AI and agentic system controls",                          default_artifact_kinds: ["ai_system_spec", "eval_suite", "tool_permission_matrix", "hitl_workflow"], master_plan_section: "Appendices" },
  { id: "4.16", title: "Deprecation, retirement, and lifecycle exit",             default_artifact_kinds: ["eol_plan", "migration_guide", "sunset_comms"], master_plan_section: "20. Deprecation and retirement plan" },
];

export const TAXONOMY_BY_ID: Record<string, TaxonomySection> = Object.fromEntries(
  TAXONOMY_SECTIONS.map(s => [s.id, s])
);

/** Heuristic classifier shipped with Phase 3. Real classifier is a Claude call. */
export type Scope = "trivial" | "standard" | "major";

export function heuristicTriage(opts: {
  request_text: string;
  diff_loc?: number;        // when the driver knows it
  files_touched?: number;
}): { scope: Scope; signals: string[] } {
  const signals: string[] = [];
  const text = opts.request_text.toLowerCase();
  let score = 0;

  if (opts.diff_loc != null) {
    if (opts.diff_loc <= 20) { signals.push(`diff_loc<=20`); score -= 1; }
    else if (opts.diff_loc >= 200) { signals.push(`diff_loc>=200`); score += 2; }
  }
  if (opts.files_touched != null) {
    if (opts.files_touched <= 1) { signals.push(`files<=1`); score -= 1; }
    else if (opts.files_touched >= 5) { signals.push(`files>=5`); score += 1; }
  }

  if (/\b(typo|comment|rename|format|whitespace|spelling)\b/.test(text)) { signals.push("trivial-keyword"); score -= 2; }
  if (/\b(refactor|migrate|migration|redesign|rewrite|new feature|architecture|api change)\b/.test(text)) { signals.push("major-keyword"); score += 2; }
  if (/\b(security|auth|authn|authz|rbac|permission|crypto|threat model|cve|breach)\b/.test(text)) { signals.push("security-keyword"); score += 3; }
  if (/\b(deprecate|retire|sunset|eol|end-of-life)\b/.test(text)) { signals.push("retirement-keyword"); score += 2; }
  if (/\b(release|rollout|rollback|migrate)\b/.test(text)) { signals.push("release-keyword"); score += 1; }

  // Doc-only requests: the surface keywords above ("architecture", "api
  // change") trigger on requests that only describe or document a thing
  // rather than implement it. If the request is shaped like "write/draft/
  // document/produce an ADR/spec/PRD/RFC/changelog/readme" AND there's no
  // verb that implies code/change emission, walk back the major-keyword
  // push. A single MADR document is a `standard` (or `trivial`) task, not
  // `major`. Without this, /pp:run aborts and forces operators into
  // /pp:team for a one-file write.
  const docOnly =
    /\b(write|draft|document|produce|generate|create|author|publish|update)\b/.test(text) &&
    /\b(adr|madr|spec|prd|rfc|design[ -]doc|readme|changelog|runbook|playbook|policy|rubric|memo|note|whitepaper|brief)\b/.test(text) &&
    !/\b(implement|build|ship|deploy|merge|wire|integrate|refactor|rewrite|migrate|port)\b/.test(text);
  if (docOnly) {
    signals.push("doc-only");
    score -= 3;
  }

  let scope: Scope = "standard";
  if (score <= -2) scope = "trivial";
  if (score >= 3)  scope = "major";

  return { scope, signals };
}

/** Heuristic taxonomy mapper. Real mapping is a Claude call against the section table. */
export type TaxonomyMapping = {
  scope: Scope;
  signals: string[];
  sections: Array<{
    id: string;
    title: string;
    rationale: string;
    required_artifacts: string[];
  }>;
  missability_required: string[];          // check_ids the run must close
};

export function heuristicMapping(opts: {
  request_text: string;
  diff_loc?: number;
  files_touched?: number;
  scope?: Scope;
}): TaxonomyMapping {
  const triage = opts.scope ? { scope: opts.scope, signals: [] } : heuristicTriage(opts);
  const text = opts.request_text.toLowerCase();
  const out = new Map<string, { rationale: string; required: Set<string> }>();

  function add(id: string, rationale: string, ...artifacts: string[]) {
    const existing = out.get(id);
    if (existing) {
      existing.rationale += `; ${rationale}`;
      for (const a of artifacts) existing.required.add(a);
    } else {
      out.set(id, { rationale, required: new Set(artifacts) });
    }
  }

  // 4.13 Documentation is required on every task (changelog at minimum).
  add("4.13", "every task updates a changelog or release note", "changelog");

  // 4.8 Engineering: any code-shaped request.
  if (triage.scope !== "trivial" || /\b(code|implement|fix|add|remove|update)\b/.test(text)) {
    add("4.8", "code-shaped request", "diff");
  }

  if (/\b(spec|prd|requirement|acceptance criteria|user stor)/.test(text)) add("4.3", "spec/PRD-shaped request", "prd", "acceptance_criteria");
  if (/\b(architecture|adr|design doc|c4|topology)\b/.test(text))           add("4.6", "architecture-shaped request", "adr");
  if (/\b(api|endpoint|route|openapi|asyncapi|webhook|event schema)\b/.test(text)) add("4.7", "interface/contract-shaped request", "openapi");
  if (/\b(security|threat|owasp|cve|rbac|crypto|privacy|gdpr|sbom)\b|auth|oauth|openid|saml|jwt|sso/i.test(text)) add("4.9", "security/privacy-shaped request", "threat_model");
  if (/\b(tests?|specs?|coverage|qa|unit[\s-]?test|integration[\s-]?test)\b/i.test(text))  add("4.10", "test-shaped request", "test_plan");
  if (/\b(rollout|release|deploy|migration|rollback)\b/.test(text))         add("4.11", "delivery/release-shaped request", "rollout_plan");
  if (/\b(observ|telemetry|slo|sli|metric|dashboard|alert|runbook)\b/.test(text)) add("4.12", "ops/observability-shaped request", "runbook");
  if (/\b(ui|ux|design|wireframe|mockup|prototype|component|button|page|screen|a11y|accessibility|wcag)\b/.test(text)) add("4.4", "UX-shaped request", "screen_state_matrix");
  if (/\b(data|schema|migration|model|entity|erd|lineage|retention)\b/.test(text)) add("4.5", "data-shaped request", "erd");
  if (/\b(eval|llm|prompt|agent|hitl|hallucination|guardrail|tool[_-]?perm)\b/.test(text)) add("4.15", "AI controls-shaped request", "ai_system_spec");
  if (/\b(deprecate|retire|sunset|eol)\b/.test(text))                       add("4.16", "retirement-shaped request", "eol_plan");
  if (/\b(strateg|business case|okr|investment|portfolio)\b/.test(text))    add("4.1", "strategy-shaped request", "vision_brief");
  if (/\b(persona|user research|journey|workflow|jtbd|domain glossary)\b/.test(text)) add("4.2", "discovery-shaped request", "personas");
  if (/\b(raci|decision log|governance|review forum|cadence)\b/.test(text)) add("4.14", "governance-shaped request", "raci");

  // ─── Game-dev keyword detection ────────────────────────────────────────
  // Any of these promote the request to game-shaped, which adds GDD / TDD /
  // accessibility / build-release plan to the artifact set on top of whatever
  // the generic mapping already produced. The active profile (game-dev-*)
  // controls which engine gotcha-pack the engineer agent reads.
  const isGame = /\b(game|gameplay|gamedev|engine|unity|unreal|godot|bevy|gamemaker|playcanvas|babylon|three\.js|level|enemy|boss|encounter|npc|mechanic|gdd|loot[-\s]?box|gacha|microtransaction|battle pass|season pass|rollback|netcode|determinism|navmesh|behavior tree|shader|nanite|lumen|world partition|gas|scriptable\s?object|addressables?|niagara|chaos|wwise|fmod|trc|lotcheck|cert|esrb|pegi|iarc|controller|joy[-\s]?con|save data|playtest)\b/i.test(text);
  if (isGame) {
    add("4.3", "game-shaped request", "gdd", "mechanic_spec");
    add("4.4", "game-shaped request needs design + a11y", "art_bible", "accessibility_plan", "localization_plan");
    add("4.6", "game tech architecture", "tech_design_doc");
    add("4.10", "game perf budget", "performance_profile");
    add("4.11", "game build/release", "build_release_plan");
  }
  if (/\b(level|greybox|blockout|encounter|boss)\b/.test(text)) add("4.4", "level/encounter-shaped request", "level_greybox", "encounter_design_doc");
  if (/\b(narrative|story|dialogue|character arc|lore|writing)\b/.test(text)) add("4.4", "narrative-shaped request", "narrative_bible", "dialogue_tree_spec");
  if (/\b(loot|gacha|economy|currency|microtransaction|battle pass|season pass|drop rate)\b/.test(text)) add("4.5", "economy-shaped request", "economy_spreadsheet", "loot_table");
  if (/\b(progression|xp|skill tree|level curve|dps)\b/.test(text)) add("4.5", "progression-shaped request", "progression_curve", "balance_matrix");
  if (/\b(telemetry|d1|d7|d30|retention|live[-\s]?ops|season|event cadence)\b/i.test(text)) add("4.5", "live-ops telemetry", "telemetry_event_taxonomy");
  if (/\b(season plan|hotfix|patch notes|live[-\s]?ops)\b/.test(text)) add("4.11", "live-ops release", "liveops_season_plan", "patch_notes");
  if (/\b(cert|trc|xr|lotcheck|submission|rating|iarc|esrb|pegi|usk|cero)\b/i.test(text)) add("4.11", "cert/submission-shaped request", "cert_submission_packet");
  if (/\b(post[-\s]?mortem|retrospective)\b/.test(text)) add("4.13", "post-mortem-shaped request", "post_mortem");

  // Missability: every task owes 19 (decision-logging) and 21 (AGENTS.md
  // presence) at minimum. The latter is enforced by /pp:run step 5c's
  // ensure_agents_md call; the check confirms it actually wrote the file.
  const missability_required: string[] = ["decision-logging", "agents-md-present"];
  if (triage.scope !== "trivial") missability_required.push("nfrs-declared", "test-data-management");
  if (out.has("4.4")) missability_required.push("ui-error-empty-loading", "accessibility-localization");
  if (out.has("4.5")) missability_required.push("schema-evolution", "retention-deletion");
  if (out.has("4.7")) missability_required.push("third-party-failure");
  if (out.has("4.9")) missability_required.push("security-review-timing", "supply-chain-integrity");
  if (out.has("4.11")) missability_required.push("rollout-reversibility", "feature-flag-lifecycle");
  if (out.has("4.12")) missability_required.push("operational-ownership", "supportability");
  if (out.has("4.15")) missability_required.push("ai-evals-hitl");
  if (out.has("4.16")) missability_required.push("deprecation-sunset");

  const sections = [...out.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([id, { rationale, required }]) => {
      const def = TAXONOMY_BY_ID[id];
      return {
        id,
        title: def?.title ?? "(unknown section)",
        rationale,
        required_artifacts: [...required],
      };
    });

  return {
    scope: triage.scope,
    signals: triage.signals,
    sections,
    missability_required: [...new Set(missability_required)],
  };
}

// ─── Master plan template (Section 9) ─────────────────────────────────────

export const MASTER_PLAN_SECTIONS = [
  "1. Executive summary",
  "2. Business and portfolio context",
  "3. Stakeholders and users",
  "4. Current-state workflow and pain",
  "5. Scope and roadmap",
  "6. Functional requirements",
  "7. Acceptance criteria",
  "8. Non-functional requirements",
  "9. UX/UI/content design",
  "10. Domain and data model",
  "11. Architecture and technical strategy",
  "12. Interfaces and contracts",
  "13. Engineering standards and delivery model",
  "14. Security, privacy, and compliance",
  "15. Test and verification strategy",
  "16. Operations and support model",
  "17. Team operating model and governance",
  "18. Risks, assumptions, and open questions",
  "19. Launch, migration, and rollback plan",
  "20. Deprecation and retirement plan",
  "Appendices",
];

export function masterPlanTemplate(projectName: string): string {
  const created = new Date().toISOString().slice(0, 10);
  const body = MASTER_PLAN_SECTIONS.map(
    s => `## ${s}\n\n_To be populated by harness runs._\n`
  ).join("\n");
  return `# Project Master Plan — ${projectName}\n\n_Auto-scaffolded by pair-programmer harness on ${created}. Each \`/pp:run\` will append/patch the relevant section. The taxonomy_blueprint.md is the canonical reference for the 16 SDLC sections._\n\n${body}`;
}

/** Section 10 completion checklist. */
export const COMPLETION_CHECKLIST = [
  "The problem and business outcome are explicit.",
  "Users, operators, and approvers are identified.",
  "Scope boundaries are written down.",
  "Acceptance criteria and non-functional requirements exist.",
  "Architecture decisions are documented with tradeoffs.",
  "API/event/UI contracts are specified and testable.",
  "Data semantics, lineage, retention, and migration are defined.",
  "Security/privacy/compliance requirements are mapped to controls.",
  "Quality strategy covers functional and non-functional verification.",
  "Release, rollback, and support plans exist before launch.",
  "Telemetry, dashboards, and incident ownership are ready before launch.",
  "Documentation ownership is assigned.",
  "Governance forums and decision rights are known.",
  "Deprecation and retirement are not left as 'future work'.",
  "If AI is involved, evals, permissions, and human review rules exist.",
];
