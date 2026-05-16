---
description: Manually retry a surfaced stage with the verdict's critique fed back to the generator. Honors the Reflexion ×1 invariant.
argument-hint: <run_id> [stage_id]
---

**Delegation contract:** All MCP tool access flows through sub-agent delegation per the Delegation Contract in `pair-programmer.md` (the master skill). Do not bypass. `PP_ALLOW_AD_HOC=1` is daemon-developer-debug only and MUST NOT be proposed as a remedy in this lifecycle.

Parse $ARGUMENTS as `run_id` (required) and optional `stage_id`. If stage_id is omitted, find the most recent surfaced stage in the run.

1. Call `mcp__pp_harness__get_run` with `run_id`. Find the target stage (the surfaced one or the one identified).
2. Find the latest attempt for that stage and its verdict.
3. If the verdict outcome is `pass`, refuse — there's nothing to retry.
4. Use the Task tool to invoke the `reflexion-coach` agent with `{ attempt_id, original_prompt, critique_md, score_json }`. The coach calls `mcp__pp_harness__retry_with_critique` to enforce the ×1 invariant and the loop ceiling.
5. If the coach returns `ok: false`, surface the reason to the user and stop.
6. If `ok: true`, take the `retry_prompt` and invoke the generator agent (e.g. `engineer`) with the retry prompt. Pass `parent_attempt_id`. The agent records a new attempt with `retry_index=1`.
7. Re-judge via the same `judge-router` flow as the original.
8. If the new verdict passes, call `mcp__pp_harness__get_stage_finalize_readiness(stage_id)` before finalizing. If it returns `next_action="run_tdd_pre_check" | "run_tdd_post_check" | "run_artifact_validate"`, call that tool and re-check readiness. Only when readiness returns `next_action="finalize_passed"` should you finalize the stage as passed and the run as complete (calling `master-plan-patcher` first). If the retry verdict fails again, or readiness still blocks passing, finalize the stage as `surfaced`.
