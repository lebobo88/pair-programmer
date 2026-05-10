---
name: master-plan-patching
description: Protocol for the `master-plan-patcher` and `run-finalizer` agents. The per-project `<project>/PROJECT_MASTER.md` follows the Section 9 20-section template. Every successful run patches the relevant sections with cross-references to the run's artifacts.
---

# Master plan patching

`<project>/PROJECT_MASTER.md` is the durable cross-run memory of the project. It follows the Section 9 20-section template (Executive summary → Deprecation & retirement plan + Appendices). Every successful run contributes to it; surfaced runs do not.

## When to patch

Patching happens at run finalize, not earlier. The `run-finalizer` agent invokes the `master-plan-patcher` agent immediately before `mcp__pp_harness__finalize_run(status="complete")`.

The daemon also calls `applyMasterPlanPatch` from inside `finalize_run` itself as a safety net so that if the agent path is skipped (e.g. an early `aborted` finalize that the user later flips to `complete` via direct DB edit), the master-plan still reflects the run.

## Section mapping

Every artifact has a `taxonomy_section` (4.x). Each 4.x section maps to exactly one master-plan section. The **canonical mapping lives in `daemon/src/orchestrator/taxonomy.ts`** as the `master_plan_section` field on each `TaxonomySection` row — read it directly via `mcp__pp_harness__list_taxonomy_sections`. Do not maintain a parallel mapping in the plugin or anywhere else; the daemon validates every entry against `MASTER_PLAN_SECTIONS` so a typo would surface as a "not in MASTER_PLAN_SECTIONS — skipping" warning at finalize time.

Quick reference (current values; check the tool output for ground truth):

| 4.x | Master-plan section |
|---|---|
| 4.1 | 2. Business and portfolio context |
| 4.2 | 3. Stakeholders and users |
| 4.3 | 6. Functional requirements |
| 4.4 | 9. UX/UI/content design |
| 4.5 | 10. Domain and data model |
| 4.6 | 11. Architecture and technical strategy |
| 4.7 | 12. Interfaces and contracts |
| 4.8 | 13. Engineering standards and delivery model |
| 4.9 | 14. Security, privacy, and compliance |
| 4.10 | 15. Test and verification strategy |
| 4.11 | 19. Launch, migration, and rollback plan |
| 4.12 | 16. Operations and support model |
| 4.13 | Appendices |
| 4.14 | 17. Team operating model and governance |
| 4.15 | Appendices |
| 4.16 | 20. Deprecation and retirement plan |

## What the patcher writes

For each touched master-plan section, the patcher writes a small block:

```markdown
### Run `<run_id>` — <one-line summary>

- Date: 2026-05-04
- Scope: <triage class>
- Artifacts:
  - `.harness/<run_id>/spec/attempt-1.md` (PRD)
  - `.harness/<run_id>/security/threat-model.md`
- Verdict: pass (cross-vendor)
- Decisions:
  - <ADR title or short bullet, if any>
```

The block is appended (`kind: append`) when the section has prior content; written to a placeholder section (`kind: update`) on first run.

## How to call `apply_master_plan_patch`

```jsonc
{
  "run_id":       "run_xxx",
  "project_path": "/abs/path/to/project",
  "section":      "11. Architecture and technical strategy",
  "kind":         "append",
  "content_md":   "### Run run_xxx — added OAuth middleware\n\n- ..."
}
```

The daemon computes prev/new sha and writes a `master_plan_patches` row. Multiple patches per run are normal — one per touched section.

## Surfaced runs

Surfaced runs (validator failed, missability failed, loop ceiling reached) do NOT patch the master plan. The daemon writes a `surfaced_skip` row to `master_plan_patches` for audit; the next run picks up where this one left off.

## Best-of-N

Best-of-N runs only patch from the **winner** candidate's artifacts. Losers are archived under `<run_id>/<stage>/losers/` but do not contribute to the master plan.

## Idempotency

The daemon's `update-master-plan` PostToolUse hook fires after every `finalize_run`. It calls `apply_master_plan_patch` again with the same content. The patcher is idempotent: if the prior section content already includes the run-id block, no change is made.

## Reading the current state of the master plan

`mcp__pp_harness__master_plan_status(project_path)` returns:
- which of the 20 sections are populated
- total bytes
- the Section 10 15-item completion checklist (each item pass/fail based on its mapped section's populated flag)

`/pp:checklist` and `/pp:master` invoke this and render the result.

## Scaffolding on first run

If `PROJECT_MASTER.md` does not exist, the patcher calls `mcp__pp_harness__ensure_master_plan(project_path)` first. The daemon writes the 20-section template using the project basename as the title. Subsequent runs patch into the template.
