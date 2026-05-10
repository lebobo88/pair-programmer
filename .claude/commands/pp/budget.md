---
description: Show pair-programmer harness budget totals. Optionally pass a scope ("run:<id>", "day:YYYY-MM-DD", "model:<id>").
argument-hint: [scope]
---

Call `mcp__pp_harness__budget_status` with $ARGUMENTS as the optional `scope` argument (omit if no argument was passed). Print the result as a small table:

| scope | tokens_in | tokens_out | cost_usd | updated_at |

If a single scope was queried, show one row. Otherwise show up to the 25 most-recently-updated scopes.
