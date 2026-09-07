---
name: "pp:profile"
description: Show the active project profile, list available built-in profiles, or render one for copying into <project>/.harness/profile.yaml.
argument-hint: [show|list|template <name>]
---

<!-- Generated from .claude\commands\pp\profile.md. Edit the .claude source file and rerun node scripts/sync-copilot-assets.mjs. -->

<!-- Frontmatter rationale preserved from .claude\commands\pp\profile.md (YAML comments are dropped by the
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
     
     WHY THIS COMMAND: shows the active profile, lists built-ins, or prints one verbatim for copying.
     
     Revert by deleting the `model:` line –– the command then follows the session model, which is the
     pre-Phase-M behaviour.
-->

Parse $ARGUMENTS as a sub-command:

- empty or `show` — Call `mcp__pp_harness__get_profile` with the current working directory. Render the profile (name, description, required sections/rubrics/artifacts/missability) or "no profile.yaml at <project>/.harness/profile.yaml" if absent. Suggest `/pp:profile list` to pick one.
- `list` — Call `mcp__pp_harness__list_profiles`. Render a table: `name | description (first 80 chars)`. Suggest `/pp:profile template <name>` to render one for copying.
- `template <name>` — Call `mcp__pp_harness__get_builtin_profile` with that name. Render the YAML body fenced with three backticks so the user can copy it. Tell them to save it as `<project>/.harness/profile.yaml`.
