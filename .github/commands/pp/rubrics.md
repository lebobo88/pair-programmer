---
name: "pp:rubrics"
description: List standard-aligned rubrics shipped with the harness, or show the body of one.
argument-hint: [list|show <id>]
---

<!-- Generated from .claude\commands\pp\rubrics.md. Edit the .claude source file and rerun node scripts/sync-copilot-assets.mjs. -->

Parse $ARGUMENTS as a sub-command:

- empty or `list` — Call `mcp__pp_harness__list_rubrics`. Render: `id | kind | title | source_url`.
- `show <id>` — Call `mcp__pp_harness__get_rubric` with that id (e.g. `wcag-2.2-aa@1`). Render the markdown body, the source_url, and note the rubric is used at gates of that kind.

Available rubric kinds: design (UX/architecture), security (OWASP ASVS, SLSA, SBOM), contract (OpenAPI/AsyncAPI), spec (RFC 2119, metric dictionary), ai (NIST AI RMF Govern/Measure).
