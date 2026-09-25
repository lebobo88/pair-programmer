---
name: "pp:budget"
description: Show pair-programmer harness budget totals. Optionally pass a scope ("run:<id>", "day:YYYY-MM-DD", "model:<id>", "tier:opus|sonnet|haiku").
argument-hint: [scope]
---

<!-- Generated from .claude\commands\pp\budget.md. Edit the .claude source file and rerun node scripts/sync-copilot-assets.mjs. -->

<!-- Frontmatter rationale preserved from .claude\commands\pp\budget.md (YAML comments are dropped by the
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
     
     WHY THIS COMMAND: the pilot. One `budget_status` call rendered as a fixed 5-column table –– the most trivially verifiable output of the eight, which is why the plan named it first.
     
     Revert by deleting the `model:` line –– the command then follows the session model, which is the
     pre-Phase-M behaviour.
-->

Call `mcp__pp_harness__budget_status` with $ARGUMENTS as the optional `scope` argument (omit if no argument was passed). Print the result as a small table:

| scope | tokens_in | tokens_out | cost_usd | updated_at |

If a single scope was queried, show one row. Otherwise show up to the 25 most-recently-updated scopes.

**When no scope is passed**, also fetch and surface a Claude tier-breakdown at the top of the output, in addition to the recent-scopes table:

```
mcp__pp_harness__budget_status(scope="tier:opus")
mcp__pp_harness__budget_status(scope="tier:sonnet")
mcp__pp_harness__budget_status(scope="tier:haiku")
```

Render as a separate small table titled "Spend by Claude tier" so the user can see whether the tier-aware delegation is paying off:

| tier   | tokens_in | tokens_out | cost_usd |

Skip rows that return null (no spend yet on that tier). Only Claude generators tally to `tier:*` scopes; Codex/Antigravity (agy) spend rolls up only to `model:<id>` and `run:*` / `day:*`.
