/**
 * Project profile loader. Reads <project>/.harness/profile.yaml and
 * surfaces gate overrides per project type. Phase 6 ships 10 profile
 * templates that the user can copy into their project.
 */

import { readFileSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";

export type ProfileName =
  | "web-ui" | "api-platform" | "internal-tool" | "enterprise"
  | "ai-agentic" | "mobile" | "sdk" | "data-product"
  | "embedded" | "non-ui-cli"
  // Game-dev family (engine sub-modes). `game-dev` is the base; the engine
  // sub-modes extend it. detect_profile picks the right sub-mode from engine
  // manifests; mobile/web targets layer the corresponding non-game profile via
  // the `extends` field at runtime.
  | "game-dev"
  | "game-dev-unity" | "game-dev-unreal" | "game-dev-godot"
  | "game-dev-web"   | "game-dev-custom";

export type RuntimeSmokeTestSpec = {
  enabled: boolean;
  build_cmd?: string;          // default: "npm run build"
  dev_cmd?: string;            // default: "npm run dev" (engineer applies PORT=0)
  port?: number;               // 0 = ephemeral, parsed from "Local:" line. default: 0
  routes?: string[];           // default: ["/"]
  ready_patterns?: string[];   // default: ["Ready in", "Local:", "ready in", "ready started", "➜  Local:"]
  fail_patterns?: string[];    // default: React/Vite/Next crash markers (see engineer.md)
  timeout_ms?: number;         // default: 60000
};

export type ProfileSpec = {
  name: ProfileName;
  description: string;
  // Profile composition. When set, the resolver loads each base by name from
  // BUILTIN_PROFILES and deep-merges into this spec (arrays union+dedupe;
  // records shallow-merge; this spec wins on scalar conflicts). Used by the
  // game-dev family so engine sub-modes can layer over `game-dev` and, when a
  // mobile/web target is detected, also over `mobile` or `web-ui`.
  extends?: ProfileName[];
  required_taxonomy_sections?: string[];     // e.g. ["4.4", "4.9"]
  required_rubrics?: Record<string, string>;  // gate_type -> rubric_id
  required_artifacts?: string[];              // canonical artifact kinds that must exist
  required_missability_checks?: string[];     // check_ids forced for every run
  // Runtime smoke-test gate (post-incident-2026-05-05). When enabled, the
  // engineer sub-agent runs the project's dev server, hits the listed routes,
  // and scans output for crash patterns BEFORE committing. archive_winner_and_losers
  // refuses to merge a candidate whose smoke status="fail".
  runtime_smoke_test?: RuntimeSmokeTestSpec;
  // Artifact-validator gate bindings. Maps artifact_kind → validator_kind[].
  // Profile-level overrides UNION with the built-in DEFAULT_VALIDATOR_BINDINGS
  // (see artifact-validators/validator-policy.ts). Profiles like `api-platform`
  // demand contracts_lint on `openapi`; `web-ui` demands mermaid_render on
  // wireframe artifacts; etc.
  required_validators?: Record<string, string[]>;
  // When a validator's binary is missing on PATH it returns `skipped` by
  // default (non-blocking). Listing it here promotes `skipped` to
  // `execution_error` so the gate fails closed — useful for enterprise /
  // regulated profiles that demand evidence of validation.
  required_validators_strict?: string[];
  notes?: string;
};

/**
 * Resolve a profile by walking `extends` and deep-merging the chain.
 *
 * - Arrays union+dedupe (preserve first-seen order).
 * - Records shallow-merge (spec wins on key collision).
 * - Scalars: spec wins.
 * - Cycles are short-circuited (a name visited twice is skipped).
 *
 * Pure: does not mutate `BUILTIN_PROFILES` or the input spec.
 */
export function resolveProfile(spec: ProfileSpec, seen: Set<string> = new Set()): ProfileSpec {
  if (!spec.extends || spec.extends.length === 0) return spec;
  if (seen.has(spec.name)) return spec;
  seen.add(spec.name);

  const merged: ProfileSpec = {
    name: spec.name,
    description: spec.description,
  };

  for (const baseName of spec.extends) {
    const base = BUILTIN_PROFILES[baseName as ProfileName];
    if (!base) continue;
    const resolvedBase = resolveProfile(base, seen);
    merged.required_taxonomy_sections = uniq([
      ...(merged.required_taxonomy_sections ?? []),
      ...(resolvedBase.required_taxonomy_sections ?? []),
    ]);
    merged.required_artifacts = uniq([
      ...(merged.required_artifacts ?? []),
      ...(resolvedBase.required_artifacts ?? []),
    ]);
    merged.required_missability_checks = uniq([
      ...(merged.required_missability_checks ?? []),
      ...(resolvedBase.required_missability_checks ?? []),
    ]);
    merged.required_rubrics = { ...(merged.required_rubrics ?? {}), ...(resolvedBase.required_rubrics ?? {}) };
    if (resolvedBase.runtime_smoke_test) merged.runtime_smoke_test = resolvedBase.runtime_smoke_test;
    merged.required_validators = mergeStringArrayMap(merged.required_validators, resolvedBase.required_validators);
    merged.required_validators_strict = uniq([
      ...(merged.required_validators_strict ?? []),
      ...(resolvedBase.required_validators_strict ?? []),
    ]);
  }

  // Spec's own values win over inherited.
  merged.required_taxonomy_sections = uniq([
    ...(merged.required_taxonomy_sections ?? []),
    ...(spec.required_taxonomy_sections ?? []),
  ]);
  merged.required_artifacts = uniq([
    ...(merged.required_artifacts ?? []),
    ...(spec.required_artifacts ?? []),
  ]);
  merged.required_missability_checks = uniq([
    ...(merged.required_missability_checks ?? []),
    ...(spec.required_missability_checks ?? []),
  ]);
  merged.required_rubrics = { ...(merged.required_rubrics ?? {}), ...(spec.required_rubrics ?? {}) };
  if (spec.runtime_smoke_test) merged.runtime_smoke_test = spec.runtime_smoke_test;
  merged.required_validators = mergeStringArrayMap(merged.required_validators, spec.required_validators);
  merged.required_validators_strict = uniq([
    ...(merged.required_validators_strict ?? []),
    ...(spec.required_validators_strict ?? []),
  ]);
  if (spec.notes) merged.notes = spec.notes;

  return merged;
}

function mergeStringArrayMap(
  a: Record<string, string[]> | undefined,
  b: Record<string, string[]> | undefined,
): Record<string, string[]> | undefined {
  if (!a && !b) return undefined;
  const out: Record<string, string[]> = { ...(a ?? {}) };
  for (const [k, v] of Object.entries(b ?? {})) {
    out[k] = uniq([...(out[k] ?? []), ...v]);
  }
  return out;
}

function uniq<T>(arr: T[]): T[] {
  const out: T[] = [];
  const seen = new Set<T>();
  for (const x of arr) {
    if (!seen.has(x)) {
      seen.add(x);
      out.push(x);
    }
  }
  return out;
}

export function loadProjectProfile(projectPath: string): ProfileSpec | null {
  const path = join(projectPath, ".harness", "profile.yaml");
  if (!existsSync(path)) return null;
  try {
    const text = readFileSync(path, "utf8");
    const parsed = YAML.parse(text) as ProfileSpec;
    if (!parsed?.name) return null;
    return resolveProfile(parsed);
  } catch {
    return null;
  }
}

export const BUILTIN_PROFILES: Record<ProfileName, ProfileSpec> = {
  "web-ui": {
    name: "web-ui",
    description: "User-facing web product. UX-team gates required; WCAG 2.2 AA on UI artifacts; screen-state matrix (8 states); visual regression on UI changes; localization plan and responsive matrix when shipping.",
    required_taxonomy_sections: ["4.4", "4.13"],
    required_rubrics: { design: "wcag-2.2-aa@1" },
    required_artifacts: [
      "screen_state_matrix",
      "a11y_plan",
      "localization_plan",
      "responsive_matrix",
      "visual_regression_report",
      "browser_validation_report",
    ],
    required_missability_checks: [
      "ui-error-empty-loading",
      "accessibility-localization",
      "rollout-reversibility",
      "browser-validation-evidence",
    ],
    runtime_smoke_test: { enabled: true, port: 0, routes: ["/"], timeout_ms: 60000 },
  },
  "api-platform": {
    name: "api-platform",
    description: "External API or platform. Contract gates required (OpenAPI/AsyncAPI rubric). Versioning + compatibility ADR.",
    required_taxonomy_sections: ["4.7", "4.13"],
    required_rubrics: { contract: "openapi-3.1-stability@1" },
    required_artifacts: ["openapi"],
    required_missability_checks: ["third-party-failure"],
    runtime_smoke_test: { enabled: false },
  },
  "internal-tool": {
    name: "internal-tool",
    description: "Internal admin/ops tool. Workflow-fit + admin-UX gates; audit-log spec required. Lighter UX rubric (RFC 2119 normative compliance instead of full WCAG).",
    required_taxonomy_sections: ["4.3", "4.4", "4.13"],
    required_rubrics: { ux: "rfc-2119-normative@1" },
    required_artifacts: ["audit_log_spec"],
    runtime_smoke_test: { enabled: true, port: 0, routes: ["/"], timeout_ms: 60000 },
  },
  "enterprise": {
    name: "enterprise",
    description: "Regulated / B2B enterprise. SBOM + supply-chain (SLSA) gate; PIA/DPIA on data changes; cross-vendor on every gate; control matrix on security gates.",
    required_taxonomy_sections: ["4.9", "4.10", "4.13", "4.14"],
    required_rubrics: {
      security: "owasp-asvs-l2@1",
      supply_chain: "slsa-l2@1",
    },
    required_artifacts: ["sbom", "dpia", "control_matrix"],
    required_missability_checks: [
      "supply-chain-integrity",
      "operational-ownership",
      "decision-logging",
    ],
    runtime_smoke_test: { enabled: true, port: 0, routes: ["/"], timeout_ms: 60000 },
    notes: "Enterprise profile forces cross-vendor on every gate via gate_eligible_judges.",
  },
  "ai-agentic": {
    name: "ai-agentic",
    description: "Product with AI/agentic features. NIST AI RMF rubric; eval-suite gate; tool-permission matrix; HITL workflow; data-egress review.",
    required_taxonomy_sections: ["4.9", "4.10", "4.13", "4.15"],
    required_rubrics: { security: "owasp-asvs-l1@1", design: "nist-ai-rmf-govern@1" },
    required_artifacts: [
      "ai_system_spec",
      "eval_suite",
      "tool_permission_matrix",
      "hitl_workflow",
      "data_egress_review",
    ],
    required_missability_checks: ["ai-evals-hitl"],
    runtime_smoke_test: { enabled: true, port: 0, routes: ["/"], timeout_ms: 60000 },
  },
  "mobile": {
    name: "mobile",
    description: "iOS/Android native or cross-platform. Offline-state matrix; permission UX; crash-reporting; store-rollout plan.",
    required_taxonomy_sections: ["4.4", "4.11", "4.13"],
    required_artifacts: [
      "offline_state_matrix",
      "store_rollout_plan",
      "permission_ux_table",
      "crash_reporting_plan",
      "browser_validation_report",
    ],
    required_missability_checks: ["rollout-reversibility", "operational-ownership", "browser-validation-evidence"],
    runtime_smoke_test: { enabled: true, port: 0, routes: ["/"], timeout_ms: 90000 },
  },
  "sdk": {
    name: "sdk",
    description: "Developer SDK / library. SemVer policy; deprecation policy; sample-app artifact required.",
    required_taxonomy_sections: ["4.7", "4.13", "4.16"],
    required_rubrics: { contract: "openapi-3.1-stability@1" },
    required_artifacts: ["semver_policy", "deprecation_policy", "sample_app"],
    required_missability_checks: ["deprecation-sunset"],
    runtime_smoke_test: { enabled: false },
  },
  "data-product": {
    name: "data-product",
    description: "Analytics / data pipeline / data product. Metric dictionary + lineage map; freshness SLAs; reconciliation plan.",
    required_taxonomy_sections: ["4.5", "4.10", "4.12", "4.13"],
    required_rubrics: { spec: "metric-dictionary@1" },
    required_artifacts: ["metric_dictionary", "lineage_map", "freshness_sla"],
    required_missability_checks: ["analytics-semantics", "schema-evolution"],
    runtime_smoke_test: { enabled: false },
  },
  "embedded": {
    name: "embedded",
    description: "Embedded / edge / OT. Device lifecycle; fleet-update plan; failure-safe policy; edge-observability spec.",
    required_taxonomy_sections: ["4.11", "4.12", "4.13"],
    required_artifacts: ["device_lifecycle", "fleet_update_plan", "failure_safe_policy"],
    required_missability_checks: ["rollout-reversibility", "operational-ownership"],
    runtime_smoke_test: { enabled: false },
  },
  "non-ui-cli": {
    name: "non-ui-cli",
    description: "CLI tool, batch job, or non-UI service. Operator-experience gate; runbook + retry/backoff doc.",
    required_taxonomy_sections: ["4.12", "4.13"],
    required_artifacts: ["runbook", "retry_backoff_doc"],
    required_missability_checks: ["supportability"],
    runtime_smoke_test: { enabled: false },
  },
  // ─── Game-dev family ─────────────────────────────────────────────────
  "game-dev": {
    name: "game-dev",
    description: "Professional game development (base). Engine sub-mode required (unity/unreal/godot/web/custom). Posture (indie vs console-cert vs live-service) auto-detected from project state. Console TRC/XR/Lotcheck gates kick in when build config targets PS5/XSX/Switch; live-ops + economy gates kick in on monetization keywords; SAG-AFTRA voice gate warns when voice tags present.",
    required_taxonomy_sections: ["4.1", "4.3", "4.4", "4.6", "4.10", "4.12", "4.13"],
    required_rubrics: {
      design: "game-accessibility-guidelines@1",
      spec:   "rfc-2119-normative@1",
    },
    required_artifacts: [
      "gdd",
      "tech_design_doc",
      "art_bible",
      "performance_profile",
      "accessibility_plan",
      "localization_plan",
      "build_release_plan",
      "telemetry_event_taxonomy",
    ],
    required_missability_checks: [
      "perf-budget-evidence",
      "accessibility-gag-basic",
      "ai-provenance-record",
      "audio-license-record",
      "font-embedding-license",
    ],
    runtime_smoke_test: { enabled: false },
    notes: "Base profile — engine sub-mode (game-dev-unity / -unreal / -godot / -web / -custom) selects the right gotcha-pack and additional artifact requirements. Detect_profile sets console-cert/live-service/online/voice flags from build config + spec keywords + middleware presence; the driver applies them via gate_eligible_judges and missability_required.",
  },
  "game-dev-unity": {
    name: "game-dev-unity",
    description: "Unity (C#). ScriptableObjects + Addressables / DOTS conventions; asmdef boundaries; SRP/URP/HDRP perf budget; Unity Profiler captures required for perf-tagged stages.",
    extends: ["game-dev"],
    required_artifacts: ["addressables_strategy", "asmdef_layout"],
    required_missability_checks: ["save-data-atomicity", "language-switch-ux"],
    runtime_smoke_test: { enabled: false },
    notes: "Engineer + technical-artist + game-ai-programmer agents read .claude/gotchas/unity.md before composing. When build config targets iOS/Android, layer `mobile` profile; the detector sets mobile-target=true and the driver merges accordingly.",
  },
  "game-dev-unreal": {
    name: "game-dev-unreal",
    description: "Unreal Engine 5 (C++/Blueprints). Lumen + Nanite + World Partition + Mass + Niagara composition; GAS for replicated abilities; DataAsset/PrimaryDataAsset config pattern; Chaos physics; Unreal Insights captures required for perf-tagged stages.",
    extends: ["game-dev"],
    required_artifacts: ["gas_design"],
    required_missability_checks: ["save-data-atomicity", "language-switch-ux"],
    runtime_smoke_test: { enabled: false },
    notes: "Engineer + technical-artist + netcode-programmer + game-ai-programmer agents read .claude/gotchas/unreal-5.md. World-partition open-world projects also require a world_partition_plan artifact (driver enforces when open-world tag present).",
  },
  "game-dev-godot": {
    name: "game-dev-godot",
    description: "Godot 4 (GDScript / C# hybrid). Scenes-first architecture; autoloads + custom Resource classes; GDScript for game logic, C# for perf-critical (note: C# web export not yet supported in Godot 4).",
    extends: ["game-dev"],
    required_artifacts: ["scene_topology"],
    required_missability_checks: ["save-data-atomicity", "language-switch-ux"],
    runtime_smoke_test: { enabled: false },
    notes: "Engineer + game-ai-programmer agents read .claude/gotchas/godot-4.md. Scene+resource colocation is mandatory; refuses to emit scenes without their exclusive resources in the same folder.",
  },
  "game-dev-web": {
    name: "game-dev-web",
    description: "Web-based game (Babylon.js 9 / three.js / PlayCanvas / Phaser). Inherits browser-validator + visual-regression-runner from web-ui profile; adds web-engine perf concerns (frame budget on browsers, GC pauses, asset streaming via fetch + IndexedDB).",
    extends: ["game-dev", "web-ui"],
    required_missability_checks: ["save-data-atomicity"],
    runtime_smoke_test: { enabled: true, port: 0, routes: ["/"], timeout_ms: 60000 },
    notes: "Engineer + technical-artist read .claude/gotchas/web-engines.md (covers Babylon.js NodeMaterials, three.js renderer/scene-graph/postprocessing, shared web-engine perf). Browser-validator and visual-regression-runner stages inherited from web-ui apply unchanged.",
  },
  "game-dev-custom": {
    name: "game-dev-custom",
    description: "Custom or non-mainstream engine (Bevy, GameMaker, in-house). Project must ship .harness/engine-conventions.md describing engine idioms; the engineer agent reads it before composing.",
    extends: ["game-dev"],
    required_missability_checks: ["save-data-atomicity"],
    runtime_smoke_test: { enabled: false },
    notes: "If .harness/engine-conventions.md is missing, the engineer agent surfaces a clear error rather than guessing engine idioms. Bevy projects typically use ECS-first patterns; GameMaker uses GML + room/object model. The harness ships .claude/gotchas/{bevy,gamemaker,custom}.md as starter packs.",
  },
};

export function getBuiltinProfile(name: string): ProfileSpec | null {
  const raw = BUILTIN_PROFILES[name as ProfileName];
  return raw ? resolveProfile(raw) : null;
}

export function listBuiltinProfiles(): ProfileSpec[] {
  return Object.values(BUILTIN_PROFILES).map((p) => resolveProfile(p));
}

/**
 * Persist a built-in profile spec to <projectPath>/.harness/profile.yaml.
 *
 * Called by the driver after the profile-loader sub-agent recommends a
 * profile via `detect_profile` and the user (or the high-confidence
 * auto-write path) has confirmed it. The body is a verbatim YAML
 * serialization of `BUILTIN_PROFILES[name]` with a provenance header
 * comment so future readers know it was bootstrapped, by which run, and
 * that the harness will not re-detect once the file exists.
 *
 * Throws if `name` is not a recognised ProfileName so callers fail loudly
 * instead of writing a malformed file.
 */
export function writeProjectProfile(
  projectPath: string,
  name: ProfileName,
  opts: {
    source: "detected" | "user-selected";
    runId?: string;
    signals?: string[];
  },
): { path: string; yaml: string } {
  const spec = BUILTIN_PROFILES[name];
  if (!spec) {
    throw new Error(
      `writeProjectProfile: unknown profile name "${name}". ` +
        `Valid names: ${Object.keys(BUILTIN_PROFILES).join(", ")}`,
    );
  }

  const harnessDir = join(projectPath, ".harness");
  if (!existsSync(harnessDir)) {
    mkdirSync(harnessDir, { recursive: true });
  }

  const body = YAML.stringify(spec);
  const ts = new Date().toISOString();
  const sourceLabel = opts.source === "detected"
    ? "auto-detected by harness"
    : "selected by user";
  const signalLines = (opts.signals ?? []).map((s) => `#   - ${s}`);
  const headerLines: string[] = [
    "# Bootstrapped by pair-programmer harness.",
    `# Source: ${sourceLabel}`,
    `# Generated: ${ts}`,
  ];
  if (opts.runId) headerLines.push(`# Run: ${opts.runId}`);
  if (signalLines.length > 0) {
    headerLines.push("# Signals:");
    headerLines.push(...signalLines);
  }
  headerLines.push(
    "# Hand-edit freely; the harness will not re-detect once this file exists.",
    "# Delete this file to trigger detection again on the next run.",
    "",
  );

  const yaml = headerLines.join("\n") + body;
  const path = join(harnessDir, "profile.yaml");
  writeFileSync(path, yaml, "utf8");
  return { path, yaml };
}
