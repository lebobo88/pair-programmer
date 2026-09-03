---
name: "pp:retry"
description: Manually retry a surfaced stage with the verdict's critique fed back to the generator. Honors the Reflexion ×1 invariant.
argument-hint: <run_id> [stage_id]
---

<!-- Generated from .claude\commands\pp\retry.md. Edit the .claude source file and rerun node scripts/sync-copilot-assets.mjs. -->

**Delegation contract:** All MCP tool access flows through sub-agent delegation per the Delegation Contract in `pair-programmer.md` (the master skill). Do not bypass. `PP_ALLOW_AD_HOC=1` is daemon-developer-debug only and MUST NOT be proposed as a remedy in this lifecycle.

## CLI-flag pre-parse

Strip the judge-override flags out of `$ARGUMENTS` into a `cli_flags` object **before** parsing `run_id` / `stage_id`. Canonical rules live in run.md's "CLI-flag pre-parse"; they apply here verbatim.

- `--judge-vendor=codex|agy`, `--judge-model=<id>`, `--judge-effort=low|medium|high|xhigh`, `--judge-escalate`, `--judge-reason="<text>"` → `cli_flags.{judge_vendor, judge_model, judge_effort, judge_escalate, judge_reason}`.
- Apply **every** parse-time STOP condition from run.md's table verbatim (model+escalate mutually exclusive; model without vendor; model or effort without a ≥ 8-character reason; `--judge-vendor=claude` invalid; unknown values; `xhigh` unavailable on agy). These fire before any daemon call.
- `--judge-escalate` is especially apt here: `judge-policy.md` sanctions the escalated lane for a last-resort Reflexion verdict. Passing it explicitly records `source: "cli"` with the operator's reason rather than the implicit `"escalated"` source.
- **No prompt layer:** a prose match on `/\b(judge (this|it) with|use \S+ (to )?judge)\b/i` prints one hint line naming the equivalent flag and continues with defaults. Never infer.

`/pp:retry` operates inside an EXISTING run, so there is no `start_run` and no `cli_flags` to persist on a run row. The override is recorded on the verdict and in `judge_decisions.json` instead.

Parse the remaining $ARGUMENTS as `run_id` (required) and optional `stage_id`. If stage_id is omitted, find the most recent surfaced stage in the run.

1. Call `mcp__pp_harness__get_run` with `run_id`. Find the target stage (the surfaced one or the one identified).
2. Find the latest attempt for that stage and its verdict.
2.5. **Validate judge overrides (only when a judge flag is set).** Call `mcp__pp_harness__doctor` before invoking `reflexion-coach`. Validate `cli_flags.judge_model` against `judge_capabilities[judge_vendor].allowed_critique_models` and `cli_flags.judge_effort` against `allowed_reasoning_efforts`. If `judge_vendor="agy"` and `agy_disabled` is true, STOP with the `PP_DISABLE_AGY=1` kill-switch remediation. On any failure, print the rejected value AND the allow-list and STOP before spending the Reflexion ×1 slot — a retry burned on an unroutable judge is unrecoverable.
3. If the verdict outcome is `pass`, refuse — there's nothing to retry.
4. Use the Task tool to invoke the `reflexion-coach` agent with `{ attempt_id, original_prompt, critique_md, score_json }`. The coach calls `mcp__pp_harness__retry_with_critique` to enforce the ×1 invariant and the loop ceiling.
5. If the coach returns `ok: false`, surface the reason to the user and stop.
6. If `ok: true`, take the `retry_prompt` and invoke the generator agent (e.g. `engineer`) with the retry prompt. Pass `parent_attempt_id`. The agent records a new attempt with `retry_index=1`.
7. Re-judge via the same `judge-router` flow as the original, passing `judge_override { vendor?, model?, reasoning_effort?, escalate?, source: "cli", reason: cli_flags.judge_reason }` when any judge flag is set (omit otherwise). **On `override_status="rejected"`: STOP** and print `override_rejection_reason` verbatim with its remediation — do not fall back to the default judge. Pass the routed override fields (`judge_vendor`, `judge_model`, `judge_reasoning_effort`, `judge_escalate`, `override_source`, `override_reason`) to the chosen judge agent.
7.5. **Archive `judge_decisions.json`.** Append a `per_stage` entry for the retry's verdict and re-archive via `archive_artifact` with `relative_path: "judge_decisions.json"`, `kind: "judge_decisions"`, `taxonomy_section: "4.14"`, `force_overwrite: true`. Shape and field semantics: `/pp:run` step 6c. Read the existing artifact first when present so earlier stages' entries survive. Report the retry's `judge` as `vendor/model@effort`, and print an **"Operator judge overrides"** line when `source != "default"`.
8. If the new verdict passes, call `mcp__pp_harness__get_stage_finalize_readiness(stage_id)` before finalizing. If it returns `next_action="run_tdd_pre_check" | "run_tdd_post_check" | "run_artifact_validate"`, call that tool and re-check readiness. Only when readiness returns `next_action="finalize_passed"` should you finalize the stage as passed and the run as complete (calling `master-plan-patcher` first). If the retry verdict fails again, or readiness still blocks passing, finalize the stage as `surfaced`.
