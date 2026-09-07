---
name: "pp:rubrics"
description: List standard-aligned rubrics shipped with the harness, or show the body of one.
argument-hint: [list|show <id>]
---

<!-- Generated from .claude\commands\pp\rubrics.md. Edit the .claude source file and rerun node scripts/sync-copilot-assets.mjs. -->

<!-- Frontmatter rationale preserved from .claude\commands\pp\rubrics.md (YAML comments are dropped by the
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
     
     WHY THIS COMMAND: lists rubrics or renders one rubric's dimensions. Fixed fields.
     
     Revert by deleting the `model:` line –– the command then follows the session model, which is the
     pre-Phase-M behaviour.
-->

Parse $ARGUMENTS as a sub-command:

- empty or `list` — Call `mcp__pp_harness__list_rubrics`. Render: `id | kind | title | source_url`.
- `show <id>` — Call `mcp__pp_harness__get_rubric` with that id (e.g. `wcag-2.2-aa@1`). Render the markdown body, the source_url, and note the rubric is used at gates of that kind.

Available rubric kinds: design (UX/architecture), security (OWASP ASVS, SLSA, SBOM), contract (OpenAPI/AsyncAPI), spec (RFC 2119, metric dictionary), ai (NIST AI RMF Govern/Measure).
