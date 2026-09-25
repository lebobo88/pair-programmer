---
name: "pp:taxonomy"
description: Show the taxonomy mapping for a run, or list the 16 sections of taxonomy_blueprint.md.
argument-hint: [run_id]
---

<!-- Generated from .claude\commands\pp\taxonomy.md. Edit the .claude source file and rerun node scripts/sync-copilot-assets.mjs. -->

<!-- Frontmatter rationale preserved from .claude\commands\pp\taxonomy.md (YAML comments are dropped by the
     frontmatter rebuild in scripts/sync-copilot-assets.mjs; kept here so the reasoning
     survives in the mirror):
     Phase M (issue #54): `model: haiku` for the render.
     
     WHY THIS IS SAFE, verified rather than assumed. The blocking question was whether Haiku can drive
     a DEFERRED MCP tool –– every one of these commands calls one, so if it cannot, they all break at
     once. The plan asserted Haiku was supported, the validation round demoted that to NOT-FOUND, and
     the tool-search docs settle it verbatim: "Model support: Claude Sonnet 4.5, Claude Haiku 4.5,
     Claude Opus 4.5, and later models". The plan was right and the demotion was wrong.
     
     SCOPE OF THE OVERRIDE, which is wider than "the render" and worth knowing: per the frontmatter
     reference, a command's `model` "applies for the rest of the current turn and is not saved to
     settings; the session model resumes on your next prompt". So anything else that happens in the
     turn that invoked this command also runs on Haiku. That is acceptable here only because this
     command is one tool call and a table; it is NOT acceptable for a command that dispatches work.
     
     WHY THIS COMMAND: renders the 16 taxonomy sections, or a run's mapping. Fixed fields.
     
     Revert by deleting the `model:` line –– the command then follows the session model, which is the
     pre-Phase-M behaviour.
-->

If $ARGUMENTS is empty, call `mcp__pp_harness__list_taxonomy_sections` and render the 16 sections as:

| id | title | default_artifact_kinds | master_plan_section |
|----|-------|------------------------|---------------------|

If $ARGUMENTS is a `run_id`, call `mcp__pp_harness__get_run` for it and:
1. Render the run's `taxonomy_mapping_json` if present (sections that fired, signals, missability_required).
2. Render the artifacts that were produced and which taxonomy section each landed under.
3. Render coverage: of the sections the mapping required, which are covered by ≥1 artifact and which aren't.
