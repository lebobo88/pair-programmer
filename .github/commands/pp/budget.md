---
name: "pp:budget"
description: Show pair-programmer harness budget totals. Optionally pass a scope ("run:<id>", "day:YYYY-MM-DD", "model:<id>", "tier:opus|sonnet|haiku").
argument-hint: [scope]
---

<!-- Generated from .claude\commands\pp\budget.md. Edit the .claude source file and rerun node scripts/sync-copilot-assets.mjs. -->

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

Skip rows that return null (no spend yet on that tier). Only Claude generators tally to `tier:*` scopes; Codex/Gemini spend rolls up only to `model:<id>` and `run:*` / `day:*`.
