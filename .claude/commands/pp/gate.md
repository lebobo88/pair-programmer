---
description: Re-run only the judge step on a stage (without regenerating). Useful when a rubric was updated or you want a fresh verdict.
argument-hint: <run_id> <stage_id>
---

**Delegation contract:** All MCP tool access flows through sub-agent delegation per the Delegation Contract in `pair-programmer.md` (the master skill). Do not bypass. `PP_ALLOW_AD_HOC=1` is daemon-developer-debug only and MUST NOT be proposed as a remedy in this lifecycle.

## CLI-flag pre-parse

Strip the judge-override flags out of `$ARGUMENTS` into a `cli_flags` object **before** parsing `run_id` / `stage_id`. Canonical rules live in run.md's "CLI-flag pre-parse"; they apply here verbatim.

- `--judge-vendor=codex|agy`, `--judge-model=<id>`, `--judge-effort=low|medium|high|xhigh`, `--judge-escalate`, `--judge-reason="<text>"` → `cli_flags.{judge_vendor, judge_model, judge_effort, judge_escalate, judge_reason}`.
- Apply **every** parse-time STOP condition from run.md's table verbatim (model+escalate mutually exclusive; model without vendor; model or effort without a ≥ 8-character reason; `--judge-vendor=claude` invalid; unknown values; `xhigh` unavailable on agy). These fire before any daemon call.
- Tier flags are not meaningful here (nothing is regenerated); reject them with "`/pp:gate` re-judges an existing attempt — the tier flags govern generators. Use `/pp:retry` if you want a regeneration."
- **No prompt layer:** a prose match on `/\b(judge (this|it) with|use \S+ (to )?judge)\b/i` prints one hint line naming the equivalent flag and continues with defaults. Never infer.

`/pp:gate` re-judges inside an EXISTING run, so there is no `start_run` and no `cli_flags` to persist on a run row. The override is recorded on the verdict and in `judge_decisions.json` instead.

Parse the remaining $ARGUMENTS as `run_id` and `stage_id` (both required).

1. Call `mcp__pp_harness__get_run` to find the stage and its winning attempt (or most recent attempt).
2. Read the artifact via Read tool from `<project>/.harness/<run_id>/<artifact_path>`.
2.5. **Validate judge overrides (only when a judge flag is set).** Call `mcp__pp_harness__doctor` before invoking `judge-router`. Validate `cli_flags.judge_model` against `judge_capabilities[judge_vendor].allowed_critique_models` and `cli_flags.judge_effort` against `allowed_reasoning_efforts`. If `judge_vendor="agy"` and `agy_disabled` is true, STOP with the `PP_DISABLE_AGY=1` kill-switch remediation. On any failure, print the rejected value AND the allow-list and STOP — do not dispatch the judge and do not touch the run's status.
3. Use the Task tool to invoke the `judge-router` agent with the stage's `gate_type`, the attempt's `producer`, the attempt's `model_id`, the user's `prompt_keywords` (use the run's `request_text`), and `judge_override { vendor?, model?, reasoning_effort?, escalate?, source: "cli", reason: cli_flags.judge_reason }` when any judge flag is set (omit otherwise). Capture `override_status`. **On `override_status="rejected"`: STOP** and print `override_rejection_reason` verbatim with its remediation — do not fall back to the default judge. (`/pp:gate` does not own the run's lifecycle, so it does not call `finalize_run`; it simply refuses.)
4. Invoke the chosen judge agent (`judge-cross-vendor` or `judge-same-vendor`) with the artifact and the routed override fields (`judge_vendor`, `judge_model`, `judge_reasoning_effort`, `judge_escalate`, `override_source`, `override_reason`). Records a fresh verdict.
4.5. **Archive `judge_decisions.json`.** Append a `per_stage` entry for this re-judge and re-archive via `archive_artifact` with `relative_path: "judge_decisions.json"`, `kind: "judge_decisions"`, `taxonomy_section: "4.14"`, `force_overwrite: true`. Shape and field semantics: `/pp:run` step 6c. Read the existing artifact first when present so earlier stages' entries survive.
5. **If the judge returns `judge_tool_failed=true`** (instead of a verdict): print the failure context to the user (vendor, model, exit_code, stderr_tail, failure_archive_path) and STOP. Do NOT record a fabricated verdict. The user must fix the bridge and re-run.
6. Show the user: prior verdict, new verdict, diff in scores, and a `judge` line `vendor/model@effort` for each (plus ` ⚠pin_mismatch` when the critique envelope reported one). If the new verdict's `source != "default"`, print an **"Operator judge overrides"** line naming the source and reason.

The loop ceiling counter increments — if you exceed it, the daemon will reject the verdict.
