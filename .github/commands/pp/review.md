---
name: "pp:review"
description: Run a focused multi-agent review pipeline for one of the 10 governance forums (Section 8 of taxonomy_blueprint.md). Uses the same Phase-11 lifecycle as /pp:run with the forum's pipeline.
argument-hint: <forum> [--scope files|stage|run|project]
---

<!-- Generated from .claude\commands\pp\review.md. Edit the .claude source file and rerun node scripts/sync-copilot-assets.mjs. -->

You are about to drive a `/pp:review` invocation. Follow the `pair-programmer` skill protocol exactly. Parse `$ARGUMENTS` as `<forum>` (one of: framing, scope, design, architecture, contract, threat, test-readiness, release-readiness, incident, service) followed by optional `--scope <files|stage|run|project>` and any free-text context.

**Delegation contract:** All MCP tool access flows through sub-agent delegation per the Delegation Contract in `pair-programmer.md` (the master skill). Do not bypass. `PP_ALLOW_AD_HOC=1` is daemon-developer-debug only and MUST NOT be proposed as a remedy in this lifecycle.

## CLI-flag pre-parse

Strip the judge-override flags out of `$ARGUMENTS` into a `cli_flags` object **before** parsing `<forum>` and `--scope`. Canonical rules live in run.md's "CLI-flag pre-parse"; they apply here verbatim.

- `--judge-vendor=codex|agy`, `--judge-model=<id>`, `--judge-effort=low|medium|high|xhigh`, `--judge-escalate`, `--judge-reason="<text>"` → `cli_flags.{judge_vendor, judge_model, judge_effort, judge_escalate, judge_reason}`.
- Apply **every** parse-time STOP condition from run.md's table verbatim (model+escalate mutually exclusive; model without vendor; model or effort without a ≥ 8-character reason; `--judge-vendor=claude` invalid; unknown values; `xhigh` unavailable on agy). These fire before any daemon call — no run row is created.
- Tier flags (`--tier-cap` / `--tier-floor` / `--no-tier-policy`) are parsed the same way as in `/pp:run` and stored in the same `cli_flags` object.
- **No prompt layer:** a prose match on `/\b(judge (this|it) with|use \S+ (to )?judge)\b/i` prints one hint line naming the equivalent flag and continues with defaults. Never infer.

**Judge-override precedence** is the run.md table, resolved per field: daemon default < forum/stage judge config (`source: "team_yaml"`) < CLI flag (`source: "cli"`, reason from `--judge-reason`).

## Lifecycle

1. **Resolve the forum.** `mcp__pp_harness__get_forum(id=<forum>)`. If null, list forums via `mcp__pp_harness__list_forums` and refuse. Capture `stages` and `required_missability_checks`.

2. **Triage + profile snapshot** — same as `/pp:run`.

2.5. **Validate judge overrides (only when a judge flag is set).** Identical to `/pp:run` step 2.5 and it runs BEFORE `start_run`: call `mcp__pp_harness__doctor`, validate `cli_flags.judge_model` against `judge_capabilities[judge_vendor].allowed_critique_models` and `cli_flags.judge_effort` against `allowed_reasoning_efforts`, and STOP with the `PP_DISABLE_AGY=1` kill-switch remediation when `judge_vendor="agy"` and `agy_disabled` is true. Any failure STOPS before a run row exists — print the rejected value and the allow-list, and do not call `start_run`.

3. **Start run.** `mcp__pp_harness__start_run(mode="review", forum=<id>, request_text=<context>, project_path=<cwd>, cli_flags=<the parsed object, including the judge fields>)`. Archive profile snapshot.

4. **Taxonomy mapping.** Augment with forum-specific sections (e.g. `threat` ⇒ 4.9 + 4.13).

5. **Stage loop.** For each stage in `forum.stages` (in order):
   - `start_stage(kind=stage.kind, gate_type=stage.gate_type)`.
   - `gate_eligible_judges(gate_type, generator_producer=stage.generator_agent_producer, generator_model=<attempt.model_id when known>, prompt_keywords=<context>, profile, artifact_kind=(stage.artifact_kind ?? stage.kind), rubric_hint=stage.rubric_id when set, requested_judge_model=<resolved judge model or omit>, requested_judge_effort=<resolved effort or omit>)`.
   - Generator: use the Task tool to invoke `stage.generator_agent` with the per-stage inputs. Output paths land under `<run_id>/review-<forum>/<stage.kind>/`.
   - Judge routing: use the Task tool to invoke `judge-router`, passing the same `artifact_kind=(stage.artifact_kind ?? stage.kind)` and `rubric_hint=stage.rubric_id when set` that you used for the preflight daemon call. Also pass `judge_override { vendor?, model?, reasoning_effort?, escalate?, source, reason }` (the per-field resolution above; omit when every field is at the daemon default). Capture `{ judge_agent, preferred_producers, rubric_id, decision_reason, judge_vendor, judge_model, judge_reasoning_effort, judge_escalate, override_source, override_reason, override_status, override_rejection_reason }`. **On `override_status="rejected"`: STOP**, print `override_rejection_reason` verbatim, and `finalize_run(status="aborted")` — never silently drop a rejected override. The routed rubric should normally match `stage.rubric_id`; if they conflict, follow the daemon decision and warn.
   - Judge execution: use the Task tool to invoke the chosen judge agent with the review artifact plus `rubric_id` (or `rubric_md` if already resolved) and the routed override fields (`judge_vendor`, `judge_model`, `judge_reasoning_effort`, `judge_escalate`, `override_source`, `override_reason`). Only the chosen judge agent records the verdict. Capture the judge's returned `model` / `reasoning_effort` / `override_source` / `pin_mismatch` from the critique RESULT envelope.
   - **Archive `judge_decisions.json`.** After each verdict (including Reflexion retries), append a `per_stage` entry and re-archive via `archive_artifact` with `relative_path: "judge_decisions.json"`, `kind: "judge_decisions"`, `taxonomy_section: "4.14"`, `force_overwrite: true`. Shape and field semantics: `/pp:run` step 6c.
   - **If judge returns `judge_tool_failed=true`**: archive the failure to `critique_failures/<stage_id>.json` via `archive_artifact` (`kind: "critique_failure"`), `finalize_stage(surfaced)`, `finalize_run(status="aborted", summary_md=<failure context>)`, STOP. Do NOT Reflexion. Do NOT fabricate a verdict.
   - On `pass`: call `mcp__pp_harness__get_stage_finalize_readiness(stage_id)` before advancing. If it returns `next_action="run_tdd_pre_check" | "run_tdd_post_check" | "run_artifact_validate"`, call that tool and re-check readiness. If readiness returns `next_action="finalize_passed"`, finalize the stage as `passed` and continue. If it returns `next_action="surface_stage"`, finalize as `surfaced` and BREAK. If it returns `next_action="retry_or_surface"`, treat the blocker as critique and enter the Reflexion path below.
   - On `fail/revise` **or** readiness `next_action="retry_or_surface"`: invoke `reflexion-coach` once, re-run the same `judge-router` flow against the retry attempt, then re-check `get_stage_finalize_readiness(stage_id)`. If the retry now returns `next_action="finalize_passed"`, finalize the stage as `passed`; otherwise finalize it as `surfaced` and BREAK.

6. **Missability** — pass `required_check_ids` = (mapping ∪ `forum.required_missability_checks` ∪ profile).

7. **Master-plan patch.** `master-plan-patcher` writes the review's outputs under the relevant master-plan section (e.g. `threat` → "14. Security, privacy, and compliance").

8. **Finalize.** `run-finalizer` with `mode="review"`.

9. **Report.** Forum id + title; per-stage table with a `judge` column showing `vendor/model@effort` from `judge_decisions.json`'s `resolved` block (append ` ⚠pin_mismatch` when reported); an **"Operator judge overrides"** block listing every stage whose `source != "default"` (`stage | source | resolved vendor/model@effort | reason`), omitted when every stage ran at the default; missability tally; artifact paths under `.harness/<run_id>/review-<forum>/` plus `judge_decisions.json`; master-plan delta; one-paragraph summary of findings.
