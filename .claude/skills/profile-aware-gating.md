---
name: profile-aware-gating
description: How `<project>/.harness/profile.yaml` modifies gates. Loaded by the `profile-loader` agent and referenced by the master skill. On first run, the harness detects the project type and writes profile.yaml after a one-line confirmation; only an explicit `skip` (or pre-existing absent file the user opts not to bootstrap) leaves the run in generic mode.
---

# Profile-aware gating

A project declares its type by placing a YAML file at `<project>/.harness/profile.yaml`. The driver reads the profile during step 2 of the lifecycle (via the `profile-loader` agent) and passes the profile name to `mcp__pp_harness__gate_eligible_judges` in every stage. The daemon then applies profile-specific overrides on top of the base gate decision.

## How profile.yaml looks

```yaml
name: web-ui                              # one of the 10 built-in names
description: User-facing web product
required_taxonomy_sections: ["4.4", "4.13"]
required_rubrics:
  design: wcag-2.2-aa@1
  contract: openapi-3.1-stability@1
required_artifacts:
  - screen_state_matrix
  - a11y_plan
  - localization_plan
  - responsive_matrix
  - visual_regression_report
required_missability_checks:
  - ui-error-empty-loading
  - accessibility-localization
  - rollout-reversibility
notes: ...
```

If the file is missing, the driver invokes `mcp__pp_harness__detect_profile` and follows the bootstrap flow in the `pair-programmer` skill step 2 (auto-write on confidence=high, prompt the user otherwise). The user can answer `skip` to run in **generic mode** (no overrides) for that single run. If the file is unparseable, the loader returns `source: "error"` and the driver decides whether to abort or continue in generic mode.

## What each built-in profile does (summary)

| Profile | Forces cross-vendor everywhere? | Notable rubric bindings | Notable required artifacts | Notable missability ids |
|---|---|---|---|---|
| `web-ui` | no | design: WCAG 2.2 AA | screen_state_matrix, a11y_plan, localization_plan, responsive_matrix, visual_regression_report | ui-error-empty-loading, accessibility-localization, rollout-reversibility |
| `api-platform` | no | contract: OpenAPI 3.1 stability | openapi | third-party-failure |
| `internal-tool` | no | ux: rfc-2119-normative (lighter) | audit_log_spec | — |
| `enterprise` | **YES** | security: OWASP ASVS L2; supply_chain: SLSA L2 | sbom, dpia, control_matrix | supply-chain-integrity, operational-ownership, decision-logging |
| `ai-agentic` | upgrade on eval/tool-permission gates | security: ASVS L1; design: NIST AI RMF Govern | ai_system_spec, eval_suite, tool_permission_matrix, hitl_workflow, data_egress_review | ai-evals-hitl |
| `mobile` | no | — | offline_state_matrix, store_rollout_plan, permission_ux_table, crash_reporting_plan | rollout-reversibility, operational-ownership |
| `sdk` | no | contract: OpenAPI 3.1 stability | semver_policy, deprecation_policy, sample_app | deprecation-sunset |
| `data-product` | no | spec: metric-dictionary | metric_dictionary, lineage_map, freshness_sla | analytics-semantics, schema-evolution |
| `embedded` | no | — | device_lifecycle, fleet_update_plan, failure_safe_policy | rollout-reversibility, operational-ownership |
| `non-ui-cli` | no | — | runbook, retry_backoff_doc | supportability |

## How `gate_eligible_judges` uses the profile

When the driver calls `gate_eligible_judges(gate_type, generator_producer, prompt_keywords, profile, artifact_kind)`:

1. Compute the **base tier** from `gate_type` (cross-vendor required for spec/design/security/contract; same-vendor OK otherwise).
2. Apply **content-aware upgrade** by scanning `prompt_keywords` for the security/concurrency regex set.
3. Apply **profile-aware upgrade**:
   - `enterprise` → cross-vendor on every gate.
   - `ai-agentic` → cross-vendor on any gate touching evals or tool permissions.
4. Pick the **rubric** in this priority order: profile's `required_rubrics[gate_type]` → built-in default for the gate (WCAG for design, ASVS for security, OpenAPI for contract, RFC 2119 for spec).

The decision payload returned to the driver carries `upgraded`, `reason`, and `rubric_id`, so the user can see *why* a gate was tightened.

## Profile + missability

After all stages complete, `mcp__pp_harness__run_missability_checks` runs. The driver passes `required_check_ids` = (the run's taxonomy mapping `missability_required` ∪ profile's `required_missability_checks`). Any failure in that union surfaces the run.

## Profile snapshot is captured at run start

`start_run` reads `<project>/.harness/profile.yaml` and persists the YAML body verbatim into `runs.profile_snapshot_json`. If the file changes mid-run, the snapshot is unaffected. Replay reconstructs the run with the exact profile that was active.

## Authoring a custom profile

Copy a built-in template via `mcp__pp_harness__get_builtin_profile(name)` and adjust. Recognized fields: `name`, `description`, `required_taxonomy_sections`, `required_rubrics`, `required_artifacts`, `required_missability_checks`, `notes`. Other fields are ignored.
