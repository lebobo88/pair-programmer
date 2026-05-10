---
description: Show or scaffold the project's PROJECT_MASTER.md (Section 9 master plan).
argument-hint: [status|scaffold]
---

If $ARGUMENTS is empty or `status`, call `mcp__pp_harness__master_plan_status` with `project_path` set to the current working directory. Render:
- File path + bytes + exists?
- A table of the 20 sections with their populated bool and bytes.
- Section 10's 15-item completion checklist with pass/fail for each.

If $ARGUMENTS is `scaffold`, call `mcp__pp_harness__ensure_master_plan`. If `created=true`, tell the user the file was scaffolded; if `false`, tell them it was already present.
