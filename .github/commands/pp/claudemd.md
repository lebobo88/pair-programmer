---
name: "pp:claudemd"
description: Show, scaffold, or status-check the project's AGENTS.md + CLAUDE.md (the cross-tool behavioral contract that every AI agent reads at session start).
argument-hint: [status|scaffold|check]
---

<!-- Generated from .claude\commands\pp\claudemd.md. Edit the .claude source file and rerun node scripts/sync-copilot-assets.mjs. -->

The harness treats AGENTS.md as the source of truth (cross-tool, loaded by Claude / Codex / Gemini / Cursor) and CLAUDE.md as a thin Claude-specific import shim (`@AGENTS.md` plus Claude-Code-only add-ons). PROJECT_MASTER.md is the planning artifact; AGENTS.md is the slim operating manual derived from it.

If $ARGUMENTS is empty or `status`, call `mcp__pp_harness__agents_md_status` with `project_path` set to the current working directory. Render:
- `AGENTS.md`: exists / bytes / line count / `over_adherence_cliff` flag (true when >200 lines). A table of the six canonical sections (Build and test commands, Project layout, Coding conventions, Workflow rules, Do not, Notes from the harness) with their populated bool and bytes.
- `CLAUDE.md`: exists / bytes / `imports_agents_md` bool (should be true — if false, the shim is broken).

If $ARGUMENTS is `scaffold`, call `mcp__pp_harness__ensure_agents_md` with `project_path: <cwd>` and `also_claude_md: true`. If the active project profile has `agents_md_template`, forward its `profile`, `conventions`, `build_commands`, `extra_sections` fields so the scaffolded file is profile-flavored. Report which files were created vs. already present.

If $ARGUMENTS is `check`, run `agents_md_status` and surface any issues:
- AGENTS.md missing → "Run `/pp:claudemd scaffold` or `/pp:run` to create it."
- CLAUDE.md missing → same.
- CLAUDE.md exists but `imports_agents_md=false` → "CLAUDE.md does not import AGENTS.md. The two files have drifted. Recommend deleting CLAUDE.md and re-running `/pp:claudemd scaffold`."
- `over_adherence_cliff=true` → "AGENTS.md is over 200 lines, which Anthropic guidance flags as the adherence cliff. Consider trimming or splitting profile-specific content into the `extra_sections` of `.harness/profile.yaml`'s `agents_md_template` block so it stays editable but isn't part of the always-loaded core."

Do not invoke any `apply_agents_md_patch` from this command — patching is a `/pp:run` finalize-time responsibility owned by `agents-md-author`. This command is read-only except for `scaffold`.
