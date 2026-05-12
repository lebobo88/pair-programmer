---
name: taxonomy-adherence
description: Reusable policy text the master skill injects into every stage. Every task maps to ≥1 of the 16 taxonomy sections. Trivial tasks reduce to a changelog entry; standard tasks produce required artifacts; major tasks invoke a team. Loaded on demand by the `pair-programmer` skill.
---

<!-- Generated from .claude\skills\taxonomy-adherence.md. Edit the .claude source file and rerun node scripts/sync-copilot-assets.mjs. -->

# Taxonomy adherence

Every request that flows through `/pp:*` MUST map to one or more sections of the 16-section blueprint at `taxonomy_blueprint.md`. The mapping is not optional: it determines which artifacts the run produces, which missability checks are required, and which sections of `PROJECT_MASTER.md` get patched at finalize.

## Mapping rules

- **Trivial scope** — typos, doc tweaks, single-line fixes. Required artifact: a changelog entry under `<run_id>/docs/CHANGELOG.md`. Maps to taxonomy section `4.13` (docs/release notes). Skip stage loop and run only the `code` (or `docs`) stage and finalize.
- **Standard scope** — anything that touches behavior, schema, or contracts. Required artifacts: spec (4.3), code (4.8), tests (4.10), docs (4.13). Add architecture (4.6) when surface area extends beyond the file currently being edited. Add data (4.5) when persistence is touched. Add security (4.9) when authentication, authorization, or sensitive data is touched.
- **Major scope** — net-new features, refactors crossing module boundaries, anything that alters NFRs. Map to all of `4.3, 4.6, 4.7, 4.8, 4.10, 4.13` plus profile-driven additions. Strongly consider `/pp:team feature-team` or another team mode.

The `triage` agent emits `{ class, signals }`. The `taxonomy-mapper` agent emits the structured mapping with `required_artifacts` and `missability_required` per section. Persist via `mcp__pp_harness__record_taxonomy_mapping`.

## Per-section artifact stubs

Use the `mcp__pp_harness__list_taxonomy_sections` tool for the canonical list. The map looks like:

| Section | Title | Default artifact kinds |
|---|---|---|
| 4.1 | Strategy | vision, business_case, okrs, kill_criteria |
| 4.2 | Discovery | research_brief, personas, journeys, glossary |
| 4.3 | Spec | prd, acceptance_criteria, nfrs |
| 4.4 | UX | ia_map, user_flows, screen_state_matrix, content_guide, a11y_plan |
| 4.5 | Data | erd, lineage, retention_deletion, migration |
| 4.6 | Architecture | adr, c4_context, runtime_topology |
| 4.7 | Contracts | openapi, asyncapi, versioning_policy |
| 4.8 | Code | unified_diff, new_files |
| 4.9 | Security | threat_model, control_mapping |
| 4.10 | Tests | test_strategy, contract_tests |
| 4.11 | Release | rollout_plan, rollback_plan, comms |
| 4.12 | Ops | slo_doc, runbook, dashboards, alerts |
| 4.13 | Docs | changelog, release_notes, runbook |
| 4.14 | Governance | raci, decision_log, review_forums |
| 4.15 | AI controls | ai_system_spec, eval_suite, hitl_workflow |
| 4.16 | Retirement | eol_plan, sunset_comms |

## How to call `record_taxonomy_mapping`

```jsonc
{
  "run_id": "run_xxx",
  "scope": "standard",                    // from triage
  "signals": ["touches schema", "auth-related"],
  "sections": [
    {
      "id": "4.3",
      "title": "Spec",
      "rationale": "user-facing behavior change requires PRD-level statement",
      "required_artifacts": ["prd", "acceptance_criteria"]
    },
    {
      "id": "4.9",
      "title": "Security",
      "rationale": "auth keyword detected",
      "required_artifacts": ["threat_model"]
    }
  ],
  "missability_required": ["nfrs-declared", "schema-evolution"]
}
```

## Trivial-task exception

If the triage class is `trivial`, the mapping is allowed to contain only `4.13` with `required_artifacts: ["changelog"]`. Skip stages other than the obvious change + changelog entry, but still run the missability inspector — it is permissive on trivial scope (most checks return `n/a`).

## What the master skill does after mapping

After `record_taxonomy_mapping` succeeds, every artifact archived via `archive_artifact` SHOULD pass `taxonomy_section: "<id>"` so the post-finalize master-plan patch can route the contribution to the right section of `PROJECT_MASTER.md`.
