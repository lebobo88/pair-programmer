---
name: "pp:gate"
description: Re-run only the judge step on a stage (without regenerating). Useful when a rubric was updated or you want a fresh verdict.
argument-hint: <run_id> <stage_id>
---

<!-- Generated from .claude\commands\pp\gate.md. Edit the .claude source file and rerun node scripts/sync-copilot-assets.mjs. -->

**Delegation contract:** All MCP tool access flows through sub-agent delegation per the Delegation Contract in `pair-programmer.md` (the master skill). Do not bypass. `PP_ALLOW_AD_HOC=1` is daemon-developer-debug only and MUST NOT be proposed as a remedy in this lifecycle.

Parse $ARGUMENTS as `run_id` and `stage_id` (both required).

1. Call `mcp__pp_harness__get_run` to find the stage and its winning attempt (or most recent attempt).
2. Read the artifact via Read tool from `<project>/.harness/<run_id>/<artifact_path>`.
3. Use the Task tool to invoke the `judge-router` agent with the stage's `gate_type`, the attempt's `producer`, and the user's `prompt_keywords` (use the run's `request_text`).
4. Invoke the chosen judge agent (`judge-cross-vendor` or `judge-same-vendor`) with the artifact. Records a fresh verdict.
5. **If the judge returns `judge_tool_failed=true`** (instead of a verdict): print the failure context to the user (vendor, model, exit_code, stderr_tail, failure_archive_path) and STOP. Do NOT record a fabricated verdict. The user must fix the bridge and re-run.
6. Show the user: prior verdict, new verdict, diff in scores.

The loop ceiling counter increments — if you exceed it, the daemon will reject the verdict.
