---
description: Run Section 10's 15-item completion checklist against PROJECT_MASTER.md.
---

Call `mcp__pp_harness__master_plan_status` with `project_path` set to the current working directory. From the result, extract `completion_checklist` (an array of `{item, pass}`).

Render as:
- ✓ for pass, ✗ for fail.
- One line per item.
- A summary count at the end: "X / 15 passing".
- For each ✗ item, name the master-plan section that needs work (the heuristic mapping is in `daemon/src/orchestrator/master-plan.ts`'s `sectionByItem`).
