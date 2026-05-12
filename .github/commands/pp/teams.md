---
name: "pp:teams"
description: List the specialized teams available in this project (project overrides → user → built-in).
---

<!-- Generated from .claude\commands\pp\teams.md. Edit the .claude source file and rerun node scripts/sync-copilot-assets.mjs. -->

Call `mcp__pp_harness__team_list` with `project_path` set to the current working directory.

Render as:

| name | origin | description | profiles_compatible | taxonomy_required |
|------|--------|-------------|---------------------|-------------------|

Group by origin (project first, then user, then builtin) and add a footer:
- "To use a team: `/pp:team <name> <request>`"
- "To override a built-in team: copy it to `<project>/.claude/teams/<name>.yaml` and edit"
- "To see a team's stage pipeline: `mcp__pp_harness__team_get` returns the full YAML."
