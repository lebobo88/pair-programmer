---
name: "pp:teams"
description: List the specialized teams available in this project (project overrides → user → built-in).
---

<!-- Generated from .claude\commands\pp\teams.md. Edit the .claude source file and rerun node scripts/sync-copilot-assets.mjs. -->

<!-- Frontmatter rationale preserved from .claude\commands\pp\teams.md (YAML comments are dropped by the
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
     
     WHY THIS COMMAND: lists teams or renders one team's stages. Fixed fields, no interpretation.
     
     Revert by deleting the `model:` line –– the command then follows the session model, which is the
     pre-Phase-M behaviour.
-->

Call `mcp__pp_harness__team_list` with `project_path` set to the current working directory.

Render as:

| name | origin | description | profiles_compatible | taxonomy_required |
|------|--------|-------------|---------------------|-------------------|

Group by origin (project first, then user, then builtin) and add a footer:
- "To use a team: `/pp:team <name> <request>`"
- "To override a built-in team: copy it to `<project>/.claude/teams/<name>.yaml` and edit"
- "To see a team's stage pipeline: `mcp__pp_harness__team_get` returns the full YAML."
