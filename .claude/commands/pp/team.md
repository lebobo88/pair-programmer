---
description: Run a request through a specialized team's pipeline (e.g., feature-team, bug-fix-team, ux-team, security-review-team). Uses the same Phase-11 lifecycle as /pp:run with the team yaml's stage set.
argument-hint: <team_name> <free-text request>
---

You are about to drive a `/pp:team` invocation. Follow the `pair-programmer` skill protocol exactly. Parse `$ARGUMENTS` as `team_name` followed by the free-text request.

**Delegation contract:** All MCP tool access flows through sub-agent delegation per the Delegation Contract in `pair-programmer.md` (the master skill). Do not bypass. `PP_ALLOW_AD_HOC=1` is daemon-developer-debug only and MUST NOT be proposed as a remedy in this lifecycle.

## Lifecycle

1. **Resolve the team.** Call `mcp__pp_harness__team_get` with `name=<team_name>`, `project_path=<cwd>`. If null, refuse and suggest `/pp:teams`. Capture the parsed yaml: `stages`, `taxonomy_required`, `missability_required`, `profiles_compatible`.

2. **Triage.** Use the Task tool to invoke `triage`. (Triage may downgrade scope; on `trivial`, fall back to `/pp:run` semantics — do not run the full team pipeline for typo-shaped requests.)

3. **Profile snapshot.** Use the Task tool to invoke `profile-loader`. If `profiles_compatible` is set on the team and the resolved profile is not in that list, warn the user but proceed.

4. **Start run.** Call `mcp__pp_harness__start_run` with `mode="team"`, `team=<team_name>`, `request_text=<rest>`. Archive the profile snapshot if present.

5. **Taxonomy mapping.** Use the Task tool to invoke `taxonomy-mapper`. Augment `sections` with the team's `taxonomy_required` ids and `missability_required` with the team's required checks. Persist via `record_taxonomy_mapping`.

6. **Stage loop.** For each `stage` in `team.stages`, in order:
   - `start_stage(kind=stage.kind, gate_type=stage.gate_type)`.
   - `gate_eligible_judges(gate_type, generator_producer=stage.generator.primary, prompt_keywords=<request>, profile, artifact_kind=stage.kind)`. Capture decision.
   - Generator: use the Task tool to invoke `stage.generator.agent` with the per-stage inputs. For a `tests_pre` stage: pass the run's prior artifact paths (any `repro`, `invariants`, `spec`, `contracts`) so the strategist can pick its TDD mode correctly.
   - Judge: use the Task tool to invoke `judge-router` (the router uses the daemon decision; the team yaml's `stage.judge.tier` and `stage.judge.rubric` are HINTS that the router may honor when consistent with the daemon's gate decision).
   - **If judge returns `judge_tool_failed=true`**: archive the failure to `critique_failures/<stage_id>.json` via `archive_artifact` (`kind: "critique_failure"`), `finalize_stage(surfaced)`, `finalize_run(status="aborted", summary_md=<failure context>)`, STOP. Do NOT Reflexion. Do NOT fabricate a verdict.
   - On `pass`:
     - **If `stage.kind == "tests_pre"`:** call `mcp__pp_harness__tdd_pre_check(stage_id)`. The daemon validates and executes the strategist's manifest against the working tree. If the returned row's `status == "verified"`, finalize the stage and continue. If `status == "violation"`, invoke `reflexion-coach` once with the row's `reason` and `output_path` excerpt as the critique, then re-run the generator and re-call `tdd_pre_check`. If the second attempt is still not `verified`, `finalize_stage(surfaced)` and BREAK. If `status == "execution_error"`, do NOT reflex (the runner couldn't even start — it's an environment problem, not a generator problem). Surface with the row's `reason` and `output_path` and BREAK.
     - **If `stage.kind == "code"` AND the immediately-prior stage in this run was `tests_pre`:** call `mcp__pp_harness__tdd_post_check(stage_id)` (pass the CODE stage_id; the daemon resolves the prior tests_pre internally). On `verified`, finalize and continue. On `violation`, invoke `reflexion-coach` once with the failing-test list as critique and re-run the engineer + judge + tdd_post_check. If still `violation`, `finalize_stage(surfaced)` and BREAK. On `execution_error`, surface and BREAK as above.
     - **Otherwise:** finalize the stage and continue.
   - On `fail/revise`: invoke `reflexion-coach` once. If still failing, `finalize_stage(surfaced)` and BREAK.
   - The daemon's `finalize_stage` enforces the same rules as defense-in-depth: it refuses to mark a `tests_pre` stage `passed` without a verified pre-check, and refuses to mark a `code` stage `passed` (when the prior was `tests_pre`) without a verified post-check. If you somehow skip the calls above, the daemon will throw `TddGateViolation` here — that's a driver bug; do not work around it by passing `surfaced` to hide the violation.

7. **Missability.** Use the Task tool to invoke `missability-inspector`, passing `required_check_ids` = (mapping ∪ team ∪ profile). Any fail → `final_status="surfaced"`.

8. **Master-plan patch.** Use the Task tool to invoke `master-plan-patcher`.

9. **Finalize.** Use the Task tool to invoke `run-finalizer` with `mode="team"`.

10. **Report.** Per-stage table (`stage | gate_type | rubric | producer/judge | verdict | tokens | cost`), missability tally, master-plan delta, total cost, artifact paths. **For TDD-shaped runs**, add a `TDD checks` section: per `tests_pre`/`code` pair, show `mode | runner | pre: expected→actual (status) | post: expected→actual (status) | duration_ms | output_path`. Surface any violation or execution_error verbatim.

## Notes

- The team yaml is authoritative for stage ordering and generator binding. The daemon's `gate_eligible_judges` is authoritative for cross-vendor policy.
- For UI-shaped teams (`ux-team`, `design-system-team`) on `web-ui` / `mobile` profiles, an extra `visual_regression` stage is added at the end of the pipeline (handled inside the team yaml).
