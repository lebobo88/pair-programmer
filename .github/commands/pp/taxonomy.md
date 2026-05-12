---
name: "pp:taxonomy"
description: Show the taxonomy mapping for a run, or list the 16 sections of taxonomy_blueprint.md.
argument-hint: [run_id]
---

<!-- Generated from .claude\commands\pp\taxonomy.md. Edit the .claude source file and rerun node scripts/sync-copilot-assets.mjs. -->

If $ARGUMENTS is empty, call `mcp__pp_harness__list_taxonomy_sections` and render the 16 sections as:

| id | title | default_artifact_kinds | master_plan_section |
|----|-------|------------------------|---------------------|

If $ARGUMENTS is a `run_id`, call `mcp__pp_harness__get_run` for it and:
1. Render the run's `taxonomy_mapping_json` if present (sections that fired, signals, missability_required).
2. Render the artifacts that were produced and which taxonomy section each landed under.
3. Render coverage: of the sections the mapping required, which are covered by ≥1 artifact and which aren't.
