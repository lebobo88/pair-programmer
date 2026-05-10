---
description: Run a request through the full pair-programmer lifecycle (triage → profile → taxonomy → stage loop with judge routing + Reflexion ×1 → missability → master-plan patch → finalize).
argument-hint: <free-text request>
---

You are about to drive a `/pp:run` invocation through the pair-programmer harness. Follow the `pair-programmer` skill protocol exactly. This command runs in `mode="single"`. For multi-candidate runs, use `/pp:best-of`. For team-driven pipelines, use `/pp:team`. For governance reviews, use `/pp:review`.

**Delegation contract:** All MCP tool access flows through sub-agent delegation per the Delegation Contract in `pair-programmer.md` (the master skill). Do not bypass. `PP_ALLOW_AD_HOC=1` is daemon-developer-debug only and MUST NOT be proposed as a remedy in this lifecycle.

User request: $ARGUMENTS

## Lifecycle (do these steps in order)

1. **Triage.** Use the Task tool to invoke the `triage` sub-agent. Pass `request_text=$ARGUMENTS`. Capture `{ class, signals }`.

2. **Profile snapshot.** Use the Task tool to invoke the `profile-loader` sub-agent. Pass `cwd` (current working directory) and `request_text`. Capture the snapshot. If `source = "needs_bootstrap"`, follow the bootstrap flow in `pair-programmer` skill step 2 (detect → confirm → write → re-load). Only proceed to step 3 once a profile is bound or the user explicitly chose `skip` / generic mode.

3. **Start run.** Call `mcp__pp_harness__start_run` with `request_text=$ARGUMENTS`, `project_path=<cwd>`, `mode="single"`. Capture `run_id`, `artifact_dir`, and `started_at`.

4. **Persist profile snapshot artifact.** If the profile-loader returned a snapshot, archive it via `mcp__pp_harness__archive_artifact`:
   - `relative_path: "profile_snapshot.yaml"`
   - `kind: "profile_snapshot"`
   - `taxonomy_section: "4.14"` (governance — profile is a governance signal)
   - `bytes`: the snapshot YAML.

5. **Taxonomy mapping.** Use the Task tool to invoke the `taxonomy-mapper` sub-agent. Pass `request_text`, the triage class/signals, and the profile snapshot. The agent returns `{ scope, signals, sections, missability_required }`. Persist via `mcp__pp_harness__record_taxonomy_mapping(run_id, …)`.

6. **Stage loop.** Pick the stage set by triage class:
   - `trivial` → just `code` (or `docs` if the request is doc-shaped).
   - `standard` → `spec` → `code` → `tests` → `docs`.
   - `major` → STOP and tell the user to invoke `/pp:team feature-team` or another team-shaped flow instead. Finalize the run with `status="aborted"` and explain.

   For each stage:
   - `mcp__pp_harness__start_stage(run_id, kind, gate_type)`. Default `gate_type` per `kind`: `spec→spec`, `code→code_style`, `tests→lint_class`, `tests_pre→contract`, `docs→docs_polish`. Override per profile rubric bindings if the profile names a different gate type for the kind.
   - `mcp__pp_harness__gate_eligible_judges` with `gate_type`, `generator_producer="codex"` (default for `engineer`), `prompt_keywords=$ARGUMENTS`, `profile=<profile.name or null>`, `artifact_kind` (per-stage canonical kind). Capture `{ required_cross_vendor, rubric_id, allowed_judges, upgraded, reason }`.
   - Generator: use the Task tool to invoke the matching agent (`spec-author` for spec, `engineer` for code, `test-strategist` for tests, `docs-author` for docs). Pass `run_id`, `stage_id`, `cwd`, `request_text`, `artifact_dir`, and (when known) `profile`. The agent calls the appropriate `pp_<vendor>__generate`, archives via `archive_artifact`, and records via `record_attempt`. Capture `attempt_id`.
   - Judge: use the Task tool to invoke `judge-router` with `gate_type`, `generator_producer`, `prompt_keywords`, `profile`, `artifact_kind`. The router routes to `judge-cross-vendor` or `judge-same-vendor`. The judge fetches the rubric via `get_rubric`, runs `pp_<other>__critique`, and records the verdict. Capture `verdict.outcome` and `cross_vendor`.
   - **If the judge sub-agent returns `judge_tool_failed=true`** (instead of a verdict): the underlying critique CLI failed persistently. Archive the failure context via `mcp__pp_harness__archive_artifact` with `relative_path: "critique_failures/<stage_id>.json"`, `kind: "critique_failure"`, and `bytes` = the JSON payload `{ judge_tool_failed, reason, vendor, model, exit_code, stderr_tail, attempts, failure_archive_path }`. Then call `mcp__pp_harness__finalize_stage(stage_id, status="surfaced")` and `mcp__pp_harness__finalize_run(status="aborted", summary_md=<judge tool failure context including failure_archive_path>)`. STOP. Do NOT advance to the next stage. Do NOT invoke Reflexion (Reflexion fixes generators, not broken judge environments). Do NOT fabricate a passing verdict to "unblock the pipeline" — halting is correct.
   - On `outcome="pass"`: `mcp__pp_harness__finalize_stage(stage_id, status="passed", winner_attempt_id=<>)` and continue to the next stage.
   - On `outcome="fail" | "revise"`: use the Task tool to invoke `reflexion-coach`. It calls `mcp__pp_harness__retry_with_critique(attempt_id, critique_md)` (which enforces ×1 and the loop ceiling). If `ok: false`, surface the run (`finalize_stage(status="surfaced")`, BREAK). If `ok: true`, the coach re-invokes the generator agent with the critique injected, re-judges, and records a second verdict.
   - On retry verdict `pass`: `finalize_stage(passed)`. On retry verdict still failing: `finalize_stage(status="surfaced")`, BREAK.

7. **Missability.** Use the Task tool to invoke `missability-inspector`. It calls `mcp__pp_harness__run_missability_checks(run_id, required_check_ids=<from step 5>)`. If any check returns `fail`, set `final_status="surfaced"` and skip to step 9.

8. **Master-plan patch.** Use the Task tool to invoke `master-plan-patcher`. It calls `ensure_master_plan` then patches per touched section. Set `final_status="complete"`.

9. **Finalize.** Use the Task tool to invoke `run-finalizer` with `run_id`, `project_path`, `final_status`, `mode="single"`. The finalizer writes `run.summary.md`, calls `finalize_run`, and returns `{ ok, run_id, status, summary_path, master_plan_path, patches_applied }`.

10. **Report to the user.** Print:
    - The run id and status.
    - A per-stage table: `stage | gate_type | rubric | producer/judge | verdict | tokens_in/out | cost_usd`.
    - The artifact paths under `<project>/.harness/<run_id>/`.
    - The master-plan delta (`patches_applied` count + which sections were patched).
    - The missability check summary (`pass / fail / n/a` counts).
    - Total tokens and cost from `mcp__pp_harness__budget_status(scope="run:<run_id>")`.
    - A one-paragraph summary of what changed.

## Failure handling

- Any harness MCP call error → print verbatim, then `mcp__pp_harness__finalize_run(status="aborted", summary_md=<error context>)` and STOP.
- `cross_vendor_required` but `vendor-matrix` reports the matrix is incomplete → STOP, print remediation steps, and `finalize_run(status="aborted")`.
- Loop ceiling reached → finalize as `surfaced` with the evidence in the summary.
- Missability fail → finalize as `surfaced` with the evidence path.
- Judge tool failed (`judge_tool_failed=true`) → archive the failure context, finalize stage `surfaced` + run `aborted`, STOP. Do NOT Reflexion. Do NOT fabricate a verdict.
- Manual-edit detection during `archive_artifact` → ask the user whether to merge or pass `force_overwrite=true`; do not silently clobber.
