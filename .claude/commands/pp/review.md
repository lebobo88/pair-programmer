---
description: Run a focused multi-agent review pipeline for one of the 10 governance forums (Section 8 of taxonomy_blueprint.md). Uses the same Phase-11 lifecycle as /pp:run with the forum's pipeline.
argument-hint: <forum> [--scope files|stage|run|project]
---

You are about to drive a `/pp:review` invocation. Follow the `pair-programmer` skill protocol exactly. Parse `$ARGUMENTS` as `<forum>` (one of: framing, scope, design, architecture, contract, threat, test-readiness, release-readiness, incident, service) followed by optional `--scope <files|stage|run|project>` and any free-text context.

**Delegation contract:** All MCP tool access flows through sub-agent delegation per the Delegation Contract in `pair-programmer.md` (the master skill). Do not bypass. `PP_ALLOW_AD_HOC=1` is daemon-developer-debug only and MUST NOT be proposed as a remedy in this lifecycle.

## Lifecycle

1. **Resolve the forum.** `mcp__pp_harness__get_forum(id=<forum>)`. If null, list forums via `mcp__pp_harness__list_forums` and refuse. Capture `stages` and `required_missability_checks`.

2. **Triage + profile snapshot** — same as `/pp:run`.

3. **Start run.** `mcp__pp_harness__start_run(mode="review", forum=<id>, request_text=<context>, project_path=<cwd>)`. Archive profile snapshot.

4. **Taxonomy mapping.** Augment with forum-specific sections (e.g. `threat` ⇒ 4.9 + 4.13).

5. **Stage loop.** For each stage in `forum.stages` (in order):
   - `start_stage(kind=stage.kind, gate_type=stage.gate_type)`.
   - `gate_eligible_judges(gate_type, generator_producer=stage.generator_agent_producer, prompt_keywords=<context>, profile, artifact_kind=stage.kind)`.
   - Generator: use the Task tool to invoke `stage.generator_agent` with the per-stage inputs. Output paths land under `<run_id>/review-<forum>/<stage.kind>/`.
   - Judge routing: use the Task tool to invoke `judge-router`. Capture `{ judge_agent, preferred_producers, rubric_id, decision_reason }`. The routed rubric should normally match `stage.rubric_id`; if they conflict, follow the daemon decision and warn.
   - Judge execution: use the Task tool to invoke the chosen judge agent with the review artifact plus `rubric_id` (or `rubric_md` if already resolved). Only the chosen judge agent records the verdict.
   - **If judge returns `judge_tool_failed=true`**: archive the failure to `critique_failures/<stage_id>.json` via `archive_artifact` (`kind: "critique_failure"`), `finalize_stage(surfaced)`, `finalize_run(status="aborted", summary_md=<failure context>)`, STOP. Do NOT Reflexion. Do NOT fabricate a verdict.
   - On `pass`: continue. On `fail/revise`: invoke `reflexion-coach` once. If still failing, finalize stage as `surfaced` and BREAK.

6. **Missability** — pass `required_check_ids` = (mapping ∪ `forum.required_missability_checks` ∪ profile).

7. **Master-plan patch.** `master-plan-patcher` writes the review's outputs under the relevant master-plan section (e.g. `threat` → "14. Security, privacy, and compliance").

8. **Finalize.** `run-finalizer` with `mode="review"`.

9. **Report.** Forum id + title; per-stage table; missability tally; artifact paths under `.harness/<run_id>/review-<forum>/`; master-plan delta; one-paragraph summary of findings.
