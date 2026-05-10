---
description: Show the active project profile, list available built-in profiles, or render one for copying into <project>/.harness/profile.yaml.
argument-hint: [show|list|template <name>]
---

Parse $ARGUMENTS as a sub-command:

- empty or `show` — Call `mcp__pp_harness__get_profile` with the current working directory. Render the profile (name, description, required sections/rubrics/artifacts/missability) or "no profile.yaml at <project>/.harness/profile.yaml" if absent. Suggest `/pp:profile list` to pick one.
- `list` — Call `mcp__pp_harness__list_profiles`. Render a table: `name | description (first 80 chars)`. Suggest `/pp:profile template <name>` to render one for copying.
- `template <name>` — Call `mcp__pp_harness__get_builtin_profile` with that name. Render the YAML body fenced with three backticks so the user can copy it. Tell them to save it as `<project>/.harness/profile.yaml`.
