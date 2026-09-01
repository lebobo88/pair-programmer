---
name: "pp:constitution"
description: Show, scaffold, or amend the project's CONSTITUTION.md — the Immortal Head.
argument-hint: [status|scaffold|amend]
---

<!-- Generated from .claude\commands\pp\constitution.md. Edit the .claude source file and rerun node scripts/sync-copilot-assets.mjs. -->

The Constitution is the per-project covenant document. The harness reads it, hashes it, and attests against it — no agent ever rewrites it.

## Behavior

If `$ARGUMENTS` is empty or `status`:
- Call `mcp__pp_harness__constitution_status` with `project_path` set to the current working directory.
- If `exists=false`, tell the user a constitution has not been adopted yet and suggest `/pp:constitution scaffold`.
- If `exists=true`, render: file path, SHA prefix, and the bullets under Article III (forbidden operations).

If `$ARGUMENTS` is `scaffold`:
- Call `mcp__pp_harness__ensure_constitution` with `project_path` set to the cwd.
- If `created=true`, tell the user the constitution was scaffolded from the template and prompt them to author Articles I–III before continuing. **Do NOT edit the file yourself** — Article I is the user's voice.
- If `created=false`, tell them a constitution is already present and show the current SHA.

If `$ARGUMENTS` is `amend`:
- This is HITL-only. **Do NOT edit `CONSTITUTION.md` automatically.** Instead:
  1. Read the current `CONSTITUTION.md` and present its current state.
  2. Ask the user what amendment they want to make (use `AskUserQuestion`).
  3. Show them the proposed diff and require explicit confirmation.
  4. Only after explicit confirmation, apply the edit.
  5. Tell the user the new SHA. Note that runs started before this amendment remain pinned to the prior SHA for replay determinism.

If `$ARGUMENTS` is anything else, treat as `status`.
