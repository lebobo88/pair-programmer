/**
 * Rubric registry. Each rubric is versioned (id includes @<version>);
 * verdicts pin the rubric_id so a run is replayable against the exact
 * rubric it was judged with. When strictness needs to change, ship a
 * new @<n+1> entry rather than mutating an existing entry — past
 * verdicts pinned to the old version must keep replaying against the
 * scoring rules they were originally judged under.
 *
 * Markdown bodies are inlined here so the compiled dist/ binary is
 * self-contained. Mirror copies live under .claude/rubrics/<id>.md for
 * humans to read/edit (Phase 9 may load overrides from disk).
 */

export type Rubric = {
  id: string;            // e.g. "wcag-2.2-aa@1"
  kind: string;          // "design" | "security" | "contract" | "spec" | "data" | "ai"
  version: string;       // "1", "2", ...
  title: string;
  source_url: string;
  markdown: string;
  schema_json?: unknown; // JSON Schema for the score object
};

const SCORE_SCHEMA_GENERIC = {
  type: "object",
  additionalProperties: { type: "number", minimum: 0, maximum: 1 },
};

export const RUBRICS: Rubric[] = [
  {
    id: "wcag-2.2-aa@1",
    kind: "design",
    version: "1",
    title: "WCAG 2.2 Level AA",
    source_url: "https://www.w3.org/WAI/standards-guidelines/wcag/",
    markdown: `# WCAG 2.2 AA rubric

Score 0..1 for each principle. Failures of any single 2.2 AA criterion drop that principle to ≤0.6.

- **perceivable**: text alternatives for non-text content; captions for video; minimum contrast 4.5:1; resizable text without loss; reflow at 320 CSS px.
- **operable**: keyboard accessible (no traps); focus visible; skip links; touch targets ≥ 24×24 CSS px; consistent help; redundant entry minimized.
- **understandable**: language of page set; consistent navigation; consistent identification; clear error messages and suggestions.
- **robust**: parses; status messages programmatically determinable; ARIA used correctly only when native semantics insufficient.

For UI artifacts, additionally require the **8-state matrix**: every component shows default / hover / focus / active / loading / empty / error / disabled.

Outcome:
- pass: every principle ≥ 0.7 AND 8/8 states named.
- revise: any principle in [0.5, 0.7), or 6-7/8 states.
- fail: any principle < 0.5, or < 6/8 states.`,
    schema_json: SCORE_SCHEMA_GENERIC,
  },
  {
    id: "owasp-asvs-l1@1",
    kind: "security",
    version: "1",
    title: "OWASP ASVS Level 1",
    source_url: "https://owasp.org/www-project-application-security-verification-standard/",
    markdown: `# OWASP ASVS L1 rubric (verifiable web app baseline)

Score 0..1 per category. L1 covers what should be verifiable from outside the app.

- **authentication**: secure auth flows; password storage hashed/salted; MFA available; session token entropy.
- **session_mgmt**: cookies HttpOnly + Secure + SameSite; session invalidation on logout; idle timeout.
- **access_control**: deny-by-default; checks at every protected resource; no IDOR.
- **input_handling**: validate at trust boundaries; output-encode for context; SSRF/XXE/path-traversal mitigations.
- **cryptography**: only TLS ≥ 1.2 in transit; modern ciphers; secrets not in source/logs.
- **error_handling**: no stack traces to users; structured logs without secrets.
- **data_protection**: PII classified; least-privilege storage; right-to-delete supported.
- **comms**: HSTS; certificate validation; no mixed content.

Outcome:
- pass: every category ≥ 0.7 AND no L1 must-have unchecked.
- revise: any category in [0.5, 0.7).
- fail: any category < 0.5, or any documented bypass of an L1 must-have.`,
    schema_json: SCORE_SCHEMA_GENERIC,
  },
  {
    id: "owasp-asvs-l2@1",
    kind: "security",
    version: "1",
    title: "OWASP ASVS Level 2 (standard)",
    source_url: "https://owasp.org/www-project-application-security-verification-standard/",
    markdown: `# OWASP ASVS L2 rubric (apps handling sensitive data)

Inherits all L1 categories; adds:

- **threat_model_present**: STRIDE/attack-tree level model documented.
- **secure_sdlc**: SAST/DAST in CI; dependency scanning; SBOM tracked.
- **stronger_auth**: MFA enforced for privileged accounts; lockout/throttling.
- **detailed_logging**: security-relevant events logged with correlation; tamper-evident.
- **business_logic**: multi-step abuse cases considered; replay/sequence checks.
- **api_security**: schema-validated, rate-limited, authenticated; deprecation policy stated.

Outcome:
- pass: every L1 category ≥ 0.7 AND every L2 add-on ≥ 0.7.
- revise: any L2 add-on in [0.5, 0.7).
- fail: any L2 must-have absent (e.g. no threat model on a data-handling change).`,
    schema_json: SCORE_SCHEMA_GENERIC,
  },
  {
    id: "c4-system-context@1",
    kind: "design",
    version: "1",
    title: "C4 system-context view",
    source_url: "https://c4model.com/",
    markdown: `# C4 system-context rubric

Architecture artifacts must clearly identify:
- **system_boundary**: what the system IS, plainly named.
- **users_personas**: every user/operator/admin role, with their goals.
- **external_systems**: every external dependency named with the relationship arrow direction.
- **decisions_and_tradeoffs**: ADRs cite alternatives considered and why rejected.
- **runtime_topology**: how components are deployed; where state lives.
- **failure_modes**: what happens if a critical dependency fails.

Outcome:
- pass: all six items ≥ 0.7.
- revise: any item in [0.5, 0.7).
- fail: any of {system_boundary, users_personas, external_systems} < 0.5 — these are the structural minimum.`,
    schema_json: SCORE_SCHEMA_GENERIC,
  },
  {
    id: "openapi-3.1-stability@1",
    kind: "contract",
    version: "1",
    title: "OpenAPI 3.1 contract stability",
    source_url: "https://spec.openapis.org/oas/latest.html",
    markdown: `# OpenAPI 3.1 contract-stability rubric

Score 0..1 per dimension:
- **schema_validity**: passes openapi-spec-validator; no \\\`x-\\\` fields where a schema field is wrong.
- **versioning**: a versioning policy is stated (path-based or media-type); breaking-change definition documented.
- **error_contract**: error response shapes documented for every operation; status codes consistent.
- **idempotency_retry**: idempotent operations marked; retry-safe semantics specified for non-idempotent ones.
- **auth**: every operation declares its securityRequirements.
- **examples**: every operation has request/response examples covering success + at least one error.
- **deprecation_policy**: \\\`deprecated: true\\\` operations have a removal date and a successor link.

Outcome:
- pass: every dimension ≥ 0.7.
- revise: any dimension in [0.5, 0.7).
- fail: schema_validity < 0.7 (an invalid spec can't be a valid contract) OR a breaking change shipped without versioning policy update.`,
    schema_json: SCORE_SCHEMA_GENERIC,
  },
  {
    id: "supabase-contract-stability@1",
    kind: "contract",
    version: "1",
    title: "Supabase / PostgREST contract stability",
    source_url: "https://supabase.com/docs/guides/database/postgres/row-level-security",
    markdown: `# Supabase contract-stability rubric

Use this rubric when the contract artifact is Supabase-shaped — Postgres
schema + RLS policies + PostgREST views + Realtime channels + Edge Functions
— rather than a REST OpenAPI document. The OpenAPI rubric mis-fits because
the failure modes here are RLS gaps and migration reversibility, not
operation enumeration.

Score 0..1 per dimension:
- **schema_validity**: tables/columns/types declared; foreign keys explicit; PKs present; check-constraints stated.
- **rls_coverage**: every user-facing table has at least one RLS policy AND \`alter table ... enable row level security\`. Tables that intentionally disable RLS must carry an inline justification comment naming the trust boundary.
- **auth_model**: policies reference \`auth.uid()\` / \`auth.jwt()\` / \`auth.role()\` explicitly; service-role bypass is called out and confined to server-side callers.
- **realtime_channels**: any table in a realtime publication declares replica identity (full / index) and the publication membership is explicit; broadcast / presence channel naming is documented.
- **migrations_reversibility**: every migration has both an \`up\` and a \`down\` (or a written justification when \`down\` is unsafe, e.g., data-destructive); migrations are ordered monotonically.
- **versioning**: PostgREST view / RPC versioning policy stated; breaking schema changes (column drops, type narrowings, NOT NULL additions on existing columns) gated behind a deprecation window.
- **breaking_change_policy**: \`drop column\` / \`alter type\` / RLS-tightening migrations name the deprecation window and a successor.

Outcome:
- pass: every dimension ≥ 0.7.
- revise: any dimension in [0.5, 0.7).
- fail: rls_coverage < 0.7 (an unsecured user-facing table is a structural failure) OR schema_validity < 0.5 OR a breaking change shipped without a stated deprecation window.`,
    schema_json: SCORE_SCHEMA_GENERIC,
  },
  {
    id: "asyncapi-3.1-stability@1",
    kind: "contract",
    version: "1",
    title: "AsyncAPI 3.1 event-contract stability",
    source_url: "https://www.asyncapi.com/docs/reference/specification/latest",
    markdown: `# AsyncAPI 3.1 event-contract rubric

Score 0..1 per dimension:
- **channel_naming**: hierarchical, predictable, documented.
- **message_schema**: message payloads schema-validated; required fields explicit.
- **versioning**: schema-evolution policy stated (forward+backward compatibility window).
- **delivery_semantics**: at-most-once / at-least-once / exactly-once stated per channel.
- **correlation**: traceId / correlationId convention specified.
- **dead_letter**: DLQ behavior documented.
- **examples**: every operation has at least one example payload.

Outcome:
- pass: every dimension ≥ 0.7.
- revise: any dimension in [0.5, 0.7).
- fail: versioning or delivery_semantics < 0.5.`,
    schema_json: SCORE_SCHEMA_GENERIC,
  },
  {
    id: "slsa-l2@1",
    kind: "security",
    version: "1",
    title: "SLSA Level 2 build integrity",
    source_url: "https://slsa.dev/",
    markdown: `# SLSA L2 rubric

Score 0..1 per requirement:
- **version_controlled**: source in VCS with commit history.
- **build_service**: builds run on a hosted service (not a developer laptop).
- **provenance_generated**: signed provenance attestation produced.
- **provenance_authenticated**: provenance signature verifiable by consumers.
- **isolation**: build steps run in isolation (no shared mutable state).

Outcome:
- pass: every requirement ≥ 0.7.
- revise: any requirement in [0.5, 0.7).
- fail: provenance_authenticated < 0.5.`,
    schema_json: SCORE_SCHEMA_GENERIC,
  },
  {
    id: "slsa-l3@1",
    kind: "security",
    version: "1",
    title: "SLSA Level 3 hardened build integrity",
    source_url: "https://slsa.dev/",
    markdown: `# SLSA L3 rubric

Includes all L2 requirements; adds:
- **hermetic_build**: declared dependencies; no network in build.
- **non_falsifiable_provenance**: provenance generated by the build service, not user-controlled.
- **isolated_per_build**: build runs in ephemeral environment; cannot reuse prior state.

Outcome: same envelope as L2 + each L3 requirement ≥ 0.7 to pass.`,
    schema_json: SCORE_SCHEMA_GENERIC,
  },
  {
    id: "sbom-cyclonedx@1",
    kind: "security",
    version: "1",
    title: "CycloneDX SBOM completeness",
    source_url: "https://cyclonedx.org/specification/overview/",
    markdown: `# CycloneDX SBOM rubric

Score 0..1 per dimension:
- **components_listed**: every direct + transitive dependency named with version.
- **purl_present**: each component has a PURL (or vendor-locked equivalent).
- **license_disclosed**: license per component (SPDX expression where possible).
- **hashes_disclosed**: integrity hash per artifact.
- **vulnerabilities_referenced**: known CVEs cross-referenced (or absence asserted).
- **supplier_named**: supplier/origin field populated where known.

Outcome:
- pass: every dimension ≥ 0.7.
- revise: any dimension in [0.5, 0.7).
- fail: components_listed < 0.7.`,
    schema_json: SCORE_SCHEMA_GENERIC,
  },
  {
    id: "nist-ai-rmf-govern@1",
    kind: "ai",
    version: "1",
    title: "NIST AI RMF — Govern function",
    source_url: "https://www.nist.gov/itl/ai-risk-management-framework",
    markdown: `# NIST AI RMF Govern rubric

Score 0..1 per outcome:
- **policies_present**: written AI use, data, and risk policies.
- **roles_responsibilities**: AI system owner + escalation path documented.
- **risk_appetite**: AI risk tolerance (use-case allowed / forbidden) stated.
- **third_party_governance**: model providers and data providers vetted.
- **incident_response**: AI-misbehavior incident playbook exists.

Outcome:
- pass: every outcome ≥ 0.7.
- revise: any in [0.5, 0.7).
- fail: roles_responsibilities < 0.5 OR incident_response < 0.5.`,
    schema_json: SCORE_SCHEMA_GENERIC,
  },
  {
    id: "nist-ai-rmf-measure@1",
    kind: "ai",
    version: "1",
    title: "NIST AI RMF — Measure function",
    source_url: "https://www.nist.gov/itl/ai-risk-management-framework",
    markdown: `# NIST AI RMF Measure rubric

Score 0..1 per outcome:
- **eval_suite_present**: documented evals covering capability + safety dimensions.
- **eval_baseline**: baseline scores recorded; regression alerts wired.
- **drift_monitoring**: live monitoring for input distribution shift.
- **bias_assessment**: subgroup performance measured (where applicable).
- **failure_taxonomy**: known failure modes catalogued with examples.
- **hitl_thresholds**: confidence thresholds for human review explicit.

Outcome:
- pass: every outcome ≥ 0.7.
- revise: any in [0.5, 0.7).
- fail: eval_suite_present < 0.5 OR hitl_thresholds < 0.5.`,
    schema_json: SCORE_SCHEMA_GENERIC,
  },
  {
    id: "rfc-2119-normative@1",
    kind: "spec",
    version: "1",
    title: "RFC 2119 normative-language adherence",
    source_url: "https://www.rfc-editor.org/rfc/rfc2119",
    markdown: `# RFC 2119 normative-language rubric

For specs / PRDs / ADRs:
- **musts_clear**: MUST / MUST NOT used for non-negotiable requirements only.
- **shoulds_qualified**: SHOULD / SHOULD NOT used for strong recommendations with exceptions named.
- **mays_optional**: MAY indicates true optionality (not weasel-wording).
- **avoids_should_versus_will_confusion**: no imperative "will" where the spec means MUST.
- **acceptance_testable**: every MUST has an acceptance criterion or pointer to one.

Outcome:
- pass: every dimension ≥ 0.7.
- revise: any in [0.5, 0.7).
- fail: musts_clear < 0.5 (vague requirements aren't requirements).`,
    schema_json: SCORE_SCHEMA_GENERIC,
  },
  {
    id: "web-runtime-validation@1",
    kind: "contract",
    version: "1",
    title: "Web runtime validation (live browser execution)",
    source_url: "https://www.w3.org/TR/2024/WD-wai-aria-1.3-20240320/",
    markdown: `# Web runtime validation rubric

Score 0..1 per dimension. The browser-validator agent boots the project's
dev server and exercises the spec's acceptance criteria via either
\`claude-in-chrome\` MCP or headless Playwright. Findings are recorded as
{route, step, status, console_errors, network_errors, screenshot_path}.

- **route_reachability**: every profile route returned a renderable response
  (HTTP 200 OR SPA-route equivalent with mounted root). Routes that 404 or
  hang past the profile timeout score 0.
- **console_clean**: zero \`console.error\` and zero unhandled-rejection
  messages across all visited routes. Warnings are tolerated but counted.
- **network_clean**: zero 5xx responses; 4xx responses that aren't part of
  the asserted-failure flow score the dimension down.
- **acceptance_coverage**: every MUST/SHALL bullet from the spec stage's
  acceptance-criteria artifact has a matching {route, step, status=pass}
  finding, OR is explicitly annotated "no UI flow — verified by tests stage".
- **evidence_present**: at least one screenshot per visited route AND, when
  the engine is \`chrome-mcp\`, an evidence GIF at \`<run>/browser-validation/\`.
  Reports without evidence cannot be replayed.
- **engine_disclosed**: the report names the engine (\`chrome-mcp\` or
  \`playwright\`) and the dev-server base_url so the run is reproducible.

Outcome:
- pass: every dimension ≥ 0.7 AND severity in {clean, warnings}.
- revise: any dimension in [0.5, 0.7) OR severity = warnings with > 3 warnings.
- fail: any dimension < 0.5 OR severity = errors (any console error, any
  status="fail" finding, or any 5xx response).`,
    schema_json: SCORE_SCHEMA_GENERIC,
  },
  {
    id: "web-runtime-validation@2",
    kind: "contract",
    version: "2",
    title: "Web runtime validation (live browser execution, with asserted-failure carve-outs)",
    source_url: "https://www.w3.org/TR/2024/WD-wai-aria-1.3-20240320/",
    markdown: `# Web runtime validation rubric (v2)

Differs from \`@1\` by adding two carve-outs so that intentional failure
flows and spec-tolerated warnings do not auto-fail an otherwise-clean
run. The carve-outs require the browser-validator report to cite the
acceptance-criteria bullet that authorizes each waiver, so they cannot be
used to silently launder real errors.

Score 0..1 per dimension. The browser-validator agent boots the project's
dev server and exercises the spec's acceptance criteria via either
\`claude-in-chrome\` MCP or headless Playwright. Findings are recorded as
{route, step, status, console_errors, network_errors, screenshot_path}.

- **route_reachability**: every profile route returned a renderable response
  (HTTP 200 OR SPA-route equivalent with mounted root). Routes that 404 or
  hang past the profile timeout score 0.
- **console_clean**: zero \`console.error\` and zero unhandled-rejection
  messages across all visited routes. Warnings tolerated but counted,
  EXCEPT warnings explicitly classified by the spec as expected-noise /
  tolerance entries — these are excluded from the count when the report
  cites the spec section under \`carve_outs.console_warnings[]\`. Each
  carve-out entry is \`{message_pattern, ac_ref}\` where ac_ref is the
  acceptance-criteria bullet ID (e.g. "F-6") that classifies the warning.
- **network_clean**: zero unannotated 5xx responses. 5xx responses that
  the spec's acceptance criteria explicitly designate as the asserted-
  failure flow (e.g., procedural-fallback test cases) do NOT score the
  dimension down, provided the report cites the AC bullet under
  \`carve_outs.network_5xx[]\` as \`{route, ac_ref}\`. Uncited 5xx still
  scores 0. 4xx responses that aren't part of the asserted-failure flow
  score the dimension down (unchanged from @1).
- **acceptance_coverage**: every MUST/SHALL bullet from the spec stage's
  acceptance-criteria artifact has a matching {route, step, status=pass}
  finding, OR is explicitly annotated "no UI flow — verified by tests stage".
- **evidence_present**: at least one screenshot per visited route AND, when
  the engine is \`chrome-mcp\`, an evidence GIF at \`<run>/browser-validation/\`.
  Reports without evidence cannot be replayed.
- **engine_disclosed**: the report names the engine (\`chrome-mcp\` or
  \`playwright\`) and the dev-server base_url so the run is reproducible.

Carve-outs schema (optional reporter-supplied object on the verdict score):
\`\`\`
carve_outs: {
  network_5xx?: [{ route: string, ac_ref: string }],
  console_warnings?: [{ message_pattern: string, ac_ref: string }],
}
\`\`\`
A carve-out without \`ac_ref\` (or with an \`ac_ref\` that does not appear in
the cited acceptance-criteria artifact) MUST be ignored by the judge —
the strict @1 rule then applies to that finding.

Outcome:
- pass: every dimension ≥ 0.7 AND severity in {clean, warnings} after
  carve-outs are applied.
- revise: any dimension in [0.5, 0.7) OR severity = warnings with > 3
  *non-tolerated* warnings (warnings excluded by an authorized
  \`console_warnings[]\` carve-out are not counted).
- fail: any dimension < 0.5 OR severity = errors (any console error, any
  status="fail" finding, or any *uncited* 5xx response).`,
    schema_json: SCORE_SCHEMA_GENERIC,
  },
  {
    id: "metric-dictionary@1",
    kind: "data",
    version: "1",
    title: "Metric dictionary completeness",
    source_url: "https://www.dama.org/cpages/body-of-knowledge",
    markdown: `# Metric dictionary rubric

For analytics / data products:
- **definition**: business definition stated unambiguously.
- **formula**: mathematical/SQL formula given.
- **grain**: aggregation grain (per-user, per-day, etc.) explicit.
- **lineage**: source tables and transformation steps named.
- **freshness_sla**: target lag from source-of-truth stated.
- **owner**: human or team accountable for accuracy named.
- **deprecation_policy**: replacement metric named when this one is sunset.

Outcome:
- pass: every dimension ≥ 0.7.
- revise: any in [0.5, 0.7).
- fail: definition or grain < 0.5 (without these the metric isn't operable).`,
    schema_json: SCORE_SCHEMA_GENERIC,
  },
  // ─── Game-dev rubrics ────────────────────────────────────────────────
  {
    id: "game-accessibility-guidelines@1",
    kind: "design",
    version: "1",
    title: "Game Accessibility Guidelines (GAG)",
    source_url: "https://gameaccessibilityguidelines.com/full-list/",
    markdown: `# Game Accessibility Guidelines rubric

GAG ships Basic / Intermediate / Advanced tiers across six axes. Score 0..1 per axis based on coverage of the artifact's stated platform tier (most ship targets must hit Basic; AAA / accessibility-forward titles target Intermediate; live-service longtail aims for Advanced over time).

- **motor**: full keybind / controller remap including UI; hold-vs-toggle for any sustained input; QTE alternatives; difficulty levels; auto-aim / aim-assist offered.
- **cognitive**: tutorial revisitable; configurable text speed; pause everywhere; clear unambiguous language; objective marker / waypoint.
- **vision**: text size adjustable; color-blind modes; high-contrast UI; subtitle background opacity; screen reader / sonification for menus.
- **hearing**: subtitles / captions for all important speech and important sounds; speaker identified; distinct visual cues for audio events; subtitle size + color customizable.
- **speech**: voice-input is optional; never gate progression behind voice input.
- **general**: accessibility settings findable from main menu and from pause; presets; persisted across sessions and platforms; documented in marketing / store page.

Outcome:
- pass: every axis ≥ 0.7 AND coverage of GAG-Basic items across all six axes is documented in the accessibility_plan artifact.
- revise: any axis in [0.5, 0.7) OR Basic items not enumerated.
- fail: any axis < 0.5 OR no caption / subtitle plan for a title with voiced content.`,
    schema_json: SCORE_SCHEMA_GENERIC,
  },
  {
    id: "xbox-accessibility-guidelines@1",
    kind: "design",
    version: "1",
    title: "Xbox Accessibility Guidelines (XAG)",
    source_url: "https://learn.microsoft.com/en-us/gaming/accessibility/guidelines",
    markdown: `# Xbox Accessibility Guidelines rubric

XAG ships ~25 numbered guidelines (XAG-101..125) tagged by Key Game Area (KGA-1..7) and Impacted Disability axes. Score 0..1 per cluster:

- **input_remap (101-105)**: full controller remap; multi-input parity; toggle-vs-hold; sensitivity adjustment; macros where appropriate.
- **visual (106-112)**: high-contrast support; subtitle adjustability; HUD scaling; reduce-motion option; screen-reader / narrator on menus; color-blind modes; min-text-size honored.
- **auditory (113-117)**: subtitles for all speech and key sounds; speaker identification; distinct visual cue for important audio; mono mix; audio mix for hearing-aid pairing.
- **cognitive (118-122)**: pause anywhere; auto-save frequency; difficulty granularity; tutorials revisitable; clear UI hierarchy.
- **motor / endurance (123-125)**: skip / auto-complete QTE; configurable timing windows; rest-friendly checkpointing.

Outcome:
- pass: every cluster ≥ 0.7 AND each XAG number that's a "must" for the artifact's target tier is addressed in the accessibility_plan.
- revise: any cluster in [0.5, 0.7).
- fail: any cluster < 0.5 OR Xbox-storefront-blocking guideline not addressed.`,
    schema_json: SCORE_SCHEMA_GENERIC,
  },
  {
    id: "console-cert-checklist@1",
    kind: "contract",
    version: "1",
    title: "Console certification checklist (TRC / XR / Lotcheck) — non-authoritative",
    source_url: "https://learn.microsoft.com/en-us/gaming/gdk/docs/store/policies/xr/xr017",
    markdown: `# Console cert checklist rubric (NON-AUTHORITATIVE)

> ⚠️ **NON-AUTHORITATIVE.** Sony TRC, Microsoft XR, and Nintendo Lotcheck documents are NDA-protected and platform-specific. This rubric is aggregated from public sources (iXie, SandVox, Kudos QA, N-iX, the public XR-017 entry) and is intended as a pre-cert sanity check, NOT a substitute for the studio's own NDA-bound checklist.
>
> The studio is responsible for the actual cert pass. This rubric exists so AI-generated artifacts don't ship with obvious cert-fail patterns.

Score 0..1 per cluster:

- **save_data_integrity**: writes are atomic (temp-file + rename); save format has a version field with explicit migration path; corruption mid-write produces a recoverable state, not a brick.
- **controller_disconnect**: every input-bound screen handles disconnect with a "press button to reconnect" UX; dropped controllers don't strand a session.
- **suspend_resume**: Quick Resume on Xbox; sleep/dock on Switch; suspend on PlayStation. The game returns to a coherent state after resume; in-flight network calls are retried or surfaced to user.
- **store_flow**: store / IAP flow follows platform conventions; no in-game prompt that closes the platform store; receipts validated on platform service, not client.
- **region_locks**: region-restricted content is gated by user region, not just by store; profile region change does not crash.
- **age_gates**: mature-rated builds present age-gate flow per region; per-region rating shown on splash if required.
- **achievement_triggers**: trophies / achievements fire on server-authoritative events for online titles; offline games can fire client-side but only on verified completion.
- **language_switch**: UI updates on runtime locale change without restart; CJK / RTL fallback fonts present; truncation handled.
- **boot_time**: boot-to-interactive within platform-tier ceiling.
- **profile_switch**: sign-out / profile-swap mid-session does not crash or leak state.

Outcome:
- pass: every cluster ≥ 0.7.
- revise: any cluster in [0.5, 0.7).
- fail: any cluster < 0.5 OR documented gap on a platform's "must-fix-to-cert" item. Studio's own cert checklist is the final arbiter.`,
    schema_json: SCORE_SCHEMA_GENERIC,
  },
  {
    id: "iarc-rating-questionnaire@1",
    kind: "spec",
    version: "1",
    title: "IARC age-rating questionnaire mapping",
    source_url: "https://www.globalratings.com/",
    markdown: `# IARC rating questionnaire rubric

IARC is a unified questionnaire that emits ESRB / PEGI / USK / ClassInd / ACB labels for digital distribution. Physical retail still requires direct cert (multi-thousand-fee per region). CERO (Japan) is handled separately. Apple's 2025 rating overhaul requires updates by 2026-01-31.

Score 0..1 per category:

- **violence**: realism of violence, blood, dismemberment, weapons, real-world weapons modeling.
- **sexuality**: nudity, sexual content, suggestive themes, romance.
- **language**: profanity frequency and severity.
- **substances**: drugs / alcohol / tobacco depiction or use.
- **gambling**: any chance-based mechanic, including loot-boxes (per IARC 2024 update).
- **simulated_gambling**: poker / casino-style without real money.
- **fear**: jump-scares, body-horror, psychological horror.
- **discrimination**: depictions of discrimination toward real-world groups.
- **online_interaction**: user-generated content, user-to-user comms (raises minimum rating in many regions).

Outcome:
- pass: questionnaire fully answered with evidence anchors (scene timestamps, screenshot refs, dialogue line refs).
- revise: any category answered without evidence anchor.
- fail: any answer contradicted by other artifacts in the run (e.g., questionnaire says "no gambling" but economy_spreadsheet declares loot boxes).`,
    schema_json: SCORE_SCHEMA_GENERIC,
  },
  {
    id: "coppa-2.0-data-flows@1",
    kind: "security",
    version: "1",
    title: "COPPA 2.0 + GDPR-K data-flow review",
    source_url: "https://www.ftc.gov/legal-library/browse/rules/childrens-online-privacy-protection-rule-coppa",
    markdown: `# COPPA 2.0 + GDPR-K rubric

COPPA 2.0 effective 2025-06-23, compliance 2026-04-22. Broader "personal info" definition; mandatory deletion-on-request; separated consent for ads. The 2025 FTC Genshin/HoYoverse $20M settlement is the canonical worked example. EU GDPR-K parental-consent threshold is 13-16 depending on member state.

Score 0..1 per cluster:

- **age_assurance**: age gate at first launch; bypass-resistant; persisted; documented age-of-record vs declared-age distinction.
- **personal_info_inventory**: every collected field classified (name, email, persistent identifier, IP, device ID, geolocation, photo/video/audio of child, educational records). COPPA 2.0 explicitly added persistent identifiers and biometrics.
- **parental_consent**: verified parental consent for under-13 (US) / per-member-state-threshold (EU) before any data collection beyond minimum. Consent-by-email-not-clicked is no longer sufficient under COPPA 2.0.
- **purpose_limitation**: data used only for stated purpose; no advertising profile under-13 without separate explicit consent.
- **deletion_rights**: parent / authorized adult can request deletion; deletion completes within 30 days; deletion is verifiable.
- **third_party_sharing**: every SDK / data-recipient enumerated; contracts in place; no SDK that hard-fails on deletion.
- **storage_minimization**: retention windows declared per data class; no indefinite retention.
- **incident_response**: child-data-breach plan separate from generic incident plan; FTC notification timeline documented.

Outcome:
- pass: every cluster ≥ 0.7 AND DPIA / data-flow diagram artifact references this rubric.
- revise: any cluster in [0.5, 0.7).
- fail: any cluster < 0.5 OR persistent-identifier collection from under-13 without compliant consent.`,
    schema_json: SCORE_SCHEMA_GENERIC,
  },
  {
    id: "loot-box-jurisdiction@1",
    kind: "security",
    version: "1",
    title: "Loot-box / chance-based reward jurisdiction matrix",
    source_url: "https://www.franssentolboom.nl/en/loot-boxes-an-overview-of-recent-developments/",
    markdown: `# Loot-box jurisdiction rubric

Score 0..1 per region cluster. Each region has its own posture; the economy_spreadsheet must declare per-region behavior.

- **belgium**: paid loot-boxes effectively banned (criminal-prosecution stance). MUST disable for BE accounts or remove the mechanic entirely.
- **netherlands**: complicated quasi-ban; 2025 Antwerp ruling extended scope. MUST restrict tradeable loot or convert to known-outcome purchases.
- **eu_general**: EU Digital Fairness Act draft (expected late 2025 / 2026) likely to introduce EU-wide rules; design SHOULD anticipate.
- **china**: drop rates MUST be published publicly per regulator requirement.
- **apple_ios**: drop rates MUST be disclosed per App Store guidelines for any chance-based purchase.
- **google_play**: drop rates MUST be disclosed for chance-based mechanics.
- **us / others**: ESRB requires "In-Game Purchases (Includes Random Items)" notice; some US states have proposed laws.
- **age_gating**: paid loot-boxes MUST NOT be offered to under-18 / under-13 paths regardless of region.

Outcome:
- pass: every region cluster ≥ 0.7 AND a per-region table in the economy_spreadsheet artifact.
- revise: any cluster in [0.5, 0.7) OR any region missing from the table.
- fail: paid loot-box implemented without per-region gating, OR drop rates not declared in regions where required.`,
    schema_json: SCORE_SCHEMA_GENERIC,
  },
  {
    id: "steam-ai-disclosure@1",
    kind: "docs_polish",
    version: "1",
    title: "Steam AI content disclosure",
    source_url: "https://store.steampowered.com/news/group/4145017/view/3862463747997849618",
    markdown: `# Steam AI disclosure rubric

Steam's January-2026 rewrite distinguishes content **consumed by players** (must disclose) from **dev efficiency tools** that don't ship to players (don't need to disclose).

Score 0..1 per cluster:

- **consumed_content_inventory**: shipped store-page art, character models, voice lines, narrative text, marketing — every gen-AI-originated asset listed with model + prompt + provenance.
- **live_generated_content**: real-time NPC dialogue, procedural textures from player input — declared in disclosure with the inference model and any data leaving the user's device.
- **efficiency_tools_excluded**: AI used in coding, asset cleanup, naming — explicitly NOT disclosed (avoid over-disclosure that confuses the form).
- **pcg_distinction**: classical procedural content generation (algorithmic) is NOT gen-AI for Steam disclosure; the artifact must distinguish.
- **disclosure_artifact**: STEAM_AI_DISCLOSURE.md present at project root for any Steam-bound build with consumed-by-player AI content.

Outcome:
- pass: every cluster ≥ 0.7 AND STEAM_AI_DISCLOSURE.md present and current.
- revise: any cluster in [0.5, 0.7) OR disclosure file out-of-date relative to recent asset additions.
- fail: Steam-bound build with consumed-by-player AI content but no disclosure artifact.`,
    schema_json: SCORE_SCHEMA_GENERIC,
  },
  {
    id: "sag-aftra-ai-rider@1",
    kind: "security",
    version: "1",
    title: "SAG-AFTRA 2025 Interactive Media AI rider",
    source_url: "https://www.sagaftra.org/contracts-industry-resources/interactive/2025-interactive-media-video-game-agreement",
    markdown: `# SAG-AFTRA AI rider rubric

The 2025 Interactive Media Agreement requires per-replica consent + disclosure for every AI digital-replica use. Performers can suspend consent during a strike. Consent is voided if usage drifts from the originally-described use. Session fee per 300 generated lines or per individual sound. Comp escalators 15.17% on ratification + 3% Nov 2025 / 2026 / 2027.

Score 0..1 per cluster:

- **consent_record**: written, signed consent on file for the specific performer, the specific use, and the specific model. Stored alongside the audio asset.
- **use_match**: actual usage matches the consent-described scope (genre, character class, polarity of dialogue, derivative-work limits).
- **session_fee_tracking**: every 300 generated lines per performer triggers a tracked session-fee event; per-sound generations tracked separately.
- **strike_pause_capability**: technical mechanism to suspend AI-replica generation during a strike (config flag, kill-switch, or build-flag).
- **store_disclosure**: AI-voice content disclosed per Steam / platform requirements (cross-references steam-ai-disclosure@1).
- **derivative_works**: re-use in promotional / marketing content has explicit additional consent.

Outcome (warn-only per project policy unless studio explicitly opts into hard-fail):
- pass: every cluster ≥ 0.7 AND consent records present for every AI-voice asset.
- revise: any cluster in [0.5, 0.7).
- fail / warn: any cluster < 0.5 OR AI-voice asset shipped without consent record (warn by default; hard-fail when studio config sets sag_aftra.strict=true).`,
    schema_json: SCORE_SCHEMA_GENERIC,
  },
  {
    id: "game-perf-budget@1",
    kind: "code_style",
    version: "1",
    title: "Game performance budget (per-platform-tier)",
    source_url: "https://developer.valvesoftware.com/wiki/Budget",
    markdown: `# Game perf-budget rubric

Per-platform-tier budgets. The artifact MUST declare its target tier(s) and provide capture evidence (Unity Profiler, Unreal Insights, RenderDoc, PIX, Razor, AMD GPUOpen) for every perf-tagged stage.

| Tier | Frame budget | Tris on screen | Draw calls | VRAM ceiling | Audio voices |
|---|---|---|---|---|---|
| PS5 / XSX (60fps) | 16.67 ms (~10 ms CPU + ~6 ms GPU) | 5–20M | 5–15k | 16 GB shared | 32–64 |
| PS5 / XSX (30fps cinematic) | 33.33 ms | 10–30M (Nanite) | 5–20k | 16 GB shared | 32–64 |
| Steam Deck (handheld) | 25–33 ms (TDP-bound) | 2–8M | 2–8k | 16 GB shared | 32 |
| Switch (docked 30fps) | 33.33 ms (ARM-bound) | 0.5–2M | 1–3k | 4 GB shared | 16–32 |
| Switch 2 (target) | DLSS-assisted | 2–8M | 2–6k | tier-up | 32 |
| Mobile A (flagship) | 16.67 ms | 0.5–2M | 0.5–1.5k | 4–8 GB | 16–32 |
| Mobile B (mid) | 33.33 ms | 0.2–1M | 0.3–1k | 2–4 GB | 16 |
| Mobile C (low) | 33.33 ms | <0.5M | <0.5k | 1–2 GB | 8–16 |
| VR Quest 3 (90fps) | 11.11 ms | 0.5–1.5M / eye | <1k / eye | 8 GB | 16 |

**Input-latency budgets**: competitive shooter < 50 ms motion-to-photon; fighting games rollback budget 4–7 frames at 60 fps; VR sub-frame.

Score 0..1 per cluster:

- **frame_time**: GPU + CPU frame-time captures within tier budget for the target scenes (combat, hub, menu, loading).
- **memory**: VRAM + RAM peaks within ceiling; texture-streaming working without thrash.
- **draw_calls**: within tier ceiling on representative scenes.
- **audio_voices**: voice peak within tier ceiling; voice-stealing policy declared.
- **input_latency**: motion-to-photon measured (not estimated) for the target genre.
- **capture_evidence**: each above metric has a linked capture file (.upi, .uprofile, .rdc, .pix, .razor, etc.).

Outcome:
- pass: every cluster ≥ 0.7 AND capture_evidence present.
- revise: any cluster in [0.5, 0.7) OR capture missing for one tier.
- fail: any cluster < 0.5 OR perf claim made without any capture artifact.`,
    schema_json: SCORE_SCHEMA_GENERIC,
  },
  {
    id: "dcc-asset-validation@1",
    kind: "contract",
    version: "1",
    title: "DCC 3D asset & rig validation (Blender → engine)",
    source_url: "https://registry.khronos.org/glTF/specs/2.0/glTF-2.0.html",
    markdown: `# DCC asset & rig validation rubric

Validates a 3D asset (mesh and/or rig) produced in a DCC (Blender, via blender-mcp) against engine-import correctness and the studio geometry/rig budgets. The artifact MUST declare its target engine + platform tier and link capture evidence (viewport/import screenshots, exporter validation log, engine import log). Mirrors the RLM-Gaming \`mesh-topology-budget\` (mesh) and \`rig-quality\` (rig) acceptance bars.

Score 0..1 per cluster:

- **poly_topology**: within the declared tri/quad budget; quad-dominant; no n-gons on deforming/subdivided meshes; poles kept off deformation lines.
- **lod_chain**: an LOD ladder is present and monotonic with declared screen-coverage transition distances (or Nanite justified on UE5).
- **uv_layout**: UVs packed, no unintended overlap, consistent texel density (±10%); lightmap UVs present where required.
- **pbr_set**: material channels match the contract (albedo / ORM / normal / emissive); no engine-incompatible (e.g. Cycles-only) nodes on export.
- **transform_axis_scale**: scale=1 / rotation=0 applied; 1 unit = 1 m (or engine unit); pivot at the contract origin; correct up/forward axis preset for the target engine.
- **rig_hierarchy** *(rig only)*: single root at origin; unique bone names; no cycles; \`.L/.R\` symmetric; deform vs control separation.
- **skin_weights** *(rig only)*: per-vertex Σw = 1 (±1e-5); ≤4 influences; no distant-bone weights; no animated/non-uniform bone scale; no Euler jump > 120°/frame.
- **export_import**: exports to the target format (FBX / glTF 2.0 / USD) and imports cleanly in the engine (single root, baked anim, no validation errors).
- **provenance**: gen-AI assets carry a valid C2PA signature/sidecar (cross-ref \`ai-content-provenance\`).
- **capture_evidence**: each cluster above has a linked capture (viewport/import screenshot, exporter log, engine import log).

Outcome:
- pass: every applicable cluster ≥ 0.7 AND capture_evidence present.
- revise: any cluster in [0.5, 0.7) OR capture missing for one target.
- fail: any cluster < 0.5 OR a topology/weight/export claim made without any capture artifact.`,
    schema_json: SCORE_SCHEMA_GENERIC,
  },
  {
    id: "igda-gasig@1",
    kind: "design",
    version: "1",
    title: "IGDA Game Accessibility SIG guidelines",
    source_url: "https://igda-gasig.org/get-involved/sig-initiatives/resources-for-game-developers/sig-guidelines/",
    markdown: `# IGDA-GASIG rubric

IGDA's Game Accessibility SIG guidelines complement GAG with a community-of-practice lens. Score 0..1 per cluster (pass thresholds align with GAG-Basic on most titles, GAG-Intermediate on accessibility-forward titles):

- **vision**: high-contrast UI; remappable text size and color; screen-reader for menus.
- **hearing**: subtitles + captions for important sounds and speech; speaker identification.
- **motor**: full input remap; toggle-vs-hold; adjustable timing.
- **cognitive**: clear UI hierarchy; configurable difficulty; revisitable tutorials; pause everywhere.
- **process**: accessibility advocate identified on the team; playtests with disabled players or AbleGamers / IGDA-GASIG consultation logged.

Outcome:
- pass: every cluster ≥ 0.7 AND a named accessibility owner exists.
- revise: any cluster in [0.5, 0.7).
- fail: any cluster < 0.5 OR no accessibility owner identified.`,
    schema_json: SCORE_SCHEMA_GENERIC,
  },
];

export function getRubric(id: string): Rubric | null {
  return RUBRICS.find(r => r.id === id) ?? null;
}

export function listRubrics(): Array<Pick<Rubric, "id" | "kind" | "version" | "title" | "source_url">> {
  return RUBRICS.map(({ id, kind, version, title, source_url }) => ({ id, kind, version, title, source_url }));
}
