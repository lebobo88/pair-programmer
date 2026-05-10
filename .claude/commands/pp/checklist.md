---
description: Run Section 10's 15-item completion checklist against PROJECT_MASTER.md.
---

Call `mcp__pp_harness__master_plan_status` with `project_path` set to the current working directory. From the result, extract `completion_checklist` (an array of `{item, pass}`).

Render as:
- ✓ for pass, ✗ for fail.
- One line per item.
- A summary count at the end: "X / 15 passing".
- For each ✗ item, name the master-plan section that needs work (the heuristic mapping is in `daemon/src/orchestrator/master-plan.ts`'s `sectionByItem`).

## Additional governance check: tier-decision archive

After the 15 standard items, also check whether the latest `/pp:run` / `/pp:team` archived a `tier_decisions.json` artifact. Query `mcp__pp_harness__list_runs` for the most recent non-aborted run, then check whether any of its artifacts has `path` ending in `tier_decisions.json`. Render as a 16th line:

- ✓ "Tier-decision plan archived (most recent run: <run_id>)"
- ✗ "No tier_decisions.json on the most recent run — driver may be running an out-of-date /pp:run that pre-dates the tier resolver."

This is not part of the daemon's `completion_checklist` (it's per-run, not per-project), so render it under a separate "Governance" heading rather than as item 16 in the numbered list.
