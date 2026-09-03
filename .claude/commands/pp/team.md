---
description: Run a request through a specialized team's pipeline (e.g., feature-team, bug-fix-team, ux-team, security-review-team). Uses the same Phase-11 lifecycle as /pp:run with the team yaml's stage set.
argument-hint: <team_name> <free-text request>
---

You are about to drive a `/pp:team` invocation. Follow the `pair-programmer` skill protocol exactly. Parse `$ARGUMENTS` as `team_name` followed by the free-text request.

**Delegation contract:** All MCP tool access flows through sub-agent delegation per the Delegation Contract in `pair-programmer.md` (the master skill). Do not bypass. `PP_ALLOW_AD_HOC=1` is daemon-developer-debug only and MUST NOT be proposed as a remedy in this lifecycle.

**CLI-flag pre-parse:** Same convention as `/pp:run` — see the "CLI-flag pre-parse" section of `run.md`, which is canonical. Strip both flag families out of the request text into a `cli_flags` object **before** parsing `team_name`:

- Tier flags: `--tier-cap=opus|sonnet|haiku`, `--tier-floor=opus|sonnet|haiku`, `--no-tier-policy`. Unknown tier values → STOP with a clear error.
- Judge-override flags (JUDGE-1a): `--judge-vendor=codex|agy`, `--judge-model=<id>`, `--judge-effort=low|medium|high|xhigh`, `--judge-escalate`, `--judge-reason="<text>"`. Stored as `judge_vendor`, `judge_model`, `judge_effort`, `judge_escalate`, `judge_reason`. Apply **every** parse-time STOP condition from run.md's table verbatim (model+escalate mutually exclusive; model without vendor; model or effort without a ≥ 8-character reason; `--judge-vendor=claude` invalid; unknown values; `xhigh` unavailable on agy). These fire before any daemon call — no run row is created.

**No prompt layer:** identical to run.md. If `$ARGUMENTS` matches `/\b(judge (this|it) with|use \S+ (to )?judge)\b/i`, print one hint line naming the equivalent flag and continue with defaults. Never infer an override from prose.

See `/pp:run` (run.md) for the AGENT_TIER_DEFAULTS table, the full tier-resolver precedence, and the **Judge-override precedence** table (default < team yaml `judge` block < CLI flag, resolved per field); this driver applies both per stage in step 6.

## Lifecycle

1. **Resolve the team.** Call `mcp__pp_harness__team_get` with `name=<team_name>`, `project_path=<cwd>`. If null, refuse and suggest `/pp:teams`. Capture the parsed yaml: `stages`, `taxonomy_required`, `missability_required`, `profiles_compatible`.

2. **Triage.** Use the Task tool to invoke `triage`. (Triage may downgrade scope; on `trivial`, fall back to `/pp:run` semantics — do not run the full team pipeline for typo-shaped requests.)

3. **Profile snapshot.** Use the Task tool to invoke `profile-loader`. If `profiles_compatible` is set on the team and the resolved profile is not in that list, warn the user but proceed.

3.5. **Validate judge overrides (only when a judge flag is set).** Identical to `/pp:run` step 2.5, and it runs **before** `start_run`. Call `mcp__pp_harness__doctor`; validate `cli_flags.judge_model` against `judge_capabilities[judge_vendor].allowed_critique_models` and `cli_flags.judge_effort` against `allowed_reasoning_efforts`. If `judge_vendor="agy"` and `agy_disabled` is true, STOP with the `PP_DISABLE_AGY=1` kill-switch remediation. Any failure STOPS before a run row exists — print the rejected value and the allow-list, and do not call `start_run`.

   Note the team yaml is also read here: a `stage.judge` block may carry `model` / `reasoning_effort` / `escalate` (the daemon validates these at team load). Resolve each judge field per the precedence table in run.md — daemon default < team yaml < CLI flag — recording `source` and `reason` per field.

4. **Start run.** Call `mcp__pp_harness__start_run` with `mode="team"`, `team=<team_name>`, `request_text=<rest>`, and `cli_flags` (including the judge fields). Archive the profile snapshot if present.

5. **Taxonomy mapping.** Use the Task tool to invoke `taxonomy-mapper`. Augment `sections` with the team's `taxonomy_required` ids and `missability_required` with the team's required checks. Persist via `record_taxonomy_mapping`.

5b. **Archive tier-decision plan.** Same shape as `/pp:run` step 5b — pre-compute the effective tier for every team stage using the resolver in step 6, and archive `tier_decisions.json` (taxonomy_section `4.14`). Includes `cli_flags`, `profile_policy`, and `per_stage[]` with the resolver trace. The retry path appends a `retry` entry per stage that escalates.

6. **Stage loop.** For each `stage` in `team.stages`, in order:
   - `start_stage(kind=stage.kind, gate_type=stage.gate_type)`.
   - `gate_eligible_judges(gate_type, generator_producer=stage.generator.primary, generator_model=<planned/actual model id when known>, prompt_keywords=<request>, profile, artifact_kind=(stage.artifact_kind ?? stage.kind), rubric_hint=stage.judge.rubric when set, requested_judge_model=<resolved judge model or omit>, requested_judge_effort=<resolved effort or omit>)`. Capture decision.

   - **6a. Resolve Claude tier for this stage** using the same resolver as `/pp:run` step 6a. Layers low→high: `AGENT_TIER_DEFAULTS[stage.generator.agent]` → `stage.generator.model_tier` (team yaml) → `profile.model_tier_policy.scope_adjust[triage.scope]` → `profile.model_tier_policy.per_stage_override[stage.kind]` or `profile.model_tier_policy.default_cap` → `cli_flags.tier_cap` / `cli_flags.tier_floor`. Skip the profile layer if `cli_flags.no_tier_policy` is set. The resolver only governs Claude generators (`stage.generator.primary === "claude"` or Path-A inside the engineer agent); for Codex/Antigravity (agy) producers, use the vendor's default model id from `DEFAULT_MODELS`.

   - **6b. Best-of-N on major scope (R3-tail Fix 0.4, 2026-05-21).** If `triage.scope === "major"` AND `stage.best_of_n_on_major_scope` is a positive integer, replace the single-generator dispatch below with a best-of-N candidate race: call `mcp__pp_harness__start_best_of_stage(stage_id, N=stage.best_of_n_on_major_scope, seeds=["primary","devils-advocate","terse-diff","failing-test-first","fresh-stack"].slice(0,N))` to allocate the candidate slots, then `Task()` the generator agent N times in parallel — once per slot, each with its `seed` and the same `attempted_tier` — and call `mcp__pp_harness__borda_count(stage_id)` to pick the winner. R3-tail δ took 10 retry rounds + 4 operator overrides on what should have been a 3-candidate race; this branch makes the comparison-shopping pattern the default for major-scope work without changing trivial/standard. Skip this branch when `stage.best_of_n_on_major_scope` is missing/null (e.g., docs / spec / contracts stages) or when `triage.scope !== "major"`.

   - Generator (single-mode dispatch path, used when step 6b doesn't apply): use the Task tool to invoke `stage.generator.agent` with the per-stage inputs. For Claude generators, pass `model: <CLAUDE_TIER_MODELS[initial_tier]>` AND `attempted_tier: <initial_tier>` so the Agent tool honors the per-call override and `record_attempt` captures the tier. For a `tests_pre` stage: pass the run's prior artifact paths (any `repro`, `invariants`, `spec`, `contracts`) so the strategist can pick its TDD mode correctly.
   - Judge routing: use the Task tool to invoke `judge-router`, passing the same `artifact_kind=(stage.artifact_kind ?? stage.kind)` and `rubric_hint=stage.judge.rubric when set` that you used for the preflight daemon call. The router uses the daemon decision; the team yaml's `stage.judge.tier` and `stage.judge.rubric` are hints that must flow through that daemon decision instead of bypassing it. Also pass `judge_override { vendor?, model?, reasoning_effort?, escalate?, source, reason }` — the per-field resolution of daemon default < `stage.judge` block (`source: "team_yaml"`, `reason: "team yaml <team>/<stage> judge block"`) < CLI flags (`source: "cli"`, reason from `--judge-reason`). Omit `judge_override` when every field is at the daemon default. Capture `{ judge_agent, preferred_producers, rubric_id, decision_reason, judge_vendor, judge_model, judge_reasoning_effort, judge_escalate, override_source, override_reason, override_status, override_rejection_reason }`. **On `override_status="rejected"`: STOP**, print `override_rejection_reason` verbatim, and `finalize_run(status="aborted")` — a rejected override is never silently dropped. **The closing verdict is always recorded by `judge-cross-vendor`** — every gate is cross-vendor per JUDGE-1, so a `stage.judge.tier` hint can never route the closing verdict to a same-vendor lane. If `judge-router` returns a same-vendor lane it is supplementary only and cannot be the verdict used for `finalize_stage(passed)` (JUDGE-2).
   - Judge execution: use the Task tool to invoke the chosen judge agent with the attempt / artifact context plus `rubric_id` (or `rubric_md` if already resolved) and the routed override fields (`judge_vendor`, `judge_model`, `judge_reasoning_effort`, `judge_escalate`, `override_source`, `override_reason`). Only the chosen judge agent records the verdict. Capture the judge's returned `model` / `reasoning_effort` / `override_source` / `pin_mismatch` from the critique RESULT envelope.
   - **6c. Archive `judge_decisions.json`.** After each verdict (including Reflexion retries and rejudges), append a `per_stage` entry and re-archive via `archive_artifact` with `relative_path: "judge_decisions.json"`, `kind: "judge_decisions"`, `taxonomy_section: "4.14"`, `force_overwrite: true`. Exact shape and field semantics: `/pp:run` step 6c — same mechanics as `tier_decisions.json`, but rewritten on every verdict.
   - **If judge returns `judge_tool_failed=true`**: archive the failure to `critique_failures/<stage_id>.json` via `archive_artifact` (`kind: "critique_failure"`), `finalize_stage(surfaced)`, `finalize_run(status="aborted", summary_md=<failure context>)`, STOP. Do NOT Reflexion. Do NOT fabricate a verdict.
   - On `pass`: call `mcp__pp_harness__get_stage_finalize_readiness(stage_id)` **before** any `finalize_stage(status="passed")`.
     - If readiness returns `next_action="run_tdd_pre_check"`, call `mcp__pp_harness__tdd_pre_check(stage_id)`, then re-call readiness.
     - If readiness returns `next_action="run_tdd_post_check"`, call `mcp__pp_harness__tdd_post_check(stage_id)` (pass the CODE stage_id; the daemon resolves the prior tests_pre internally), then re-call readiness.
     - If readiness returns `next_action="run_artifact_validate"`, call `mcp__pp_harness__artifact_validate(...)` for the required artifact validator(s), then re-call readiness.
     - If readiness returns `next_action="finalize_passed"`, finalize the stage and continue.
     - If readiness returns `next_action="surface_stage"`, finalize the stage as `surfaced` and BREAK.
     - If readiness returns `next_action="retry_or_surface"`, use the first blocker message / evidence as the critique and enter the Reflexion path below instead of attempting `finalize_stage(status="passed")`.
   - On `fail/revise` **or** readiness `next_action="retry_or_surface"`: invoke `reflexion-coach` once. **Escalate the Claude tier by one step** (`retry_tier = shiftTier(initial_tier, +1)`; haiku→sonnet, sonnet→opus, opus stays; off-ladder tier like fable: unchanged). cli_floor still applies on retry for LADDER tiers only — guard: `if cli_flags.tier_floor and tierIndex(retry_tier) >= 0 and tierIndex(retry_tier) < tierIndex(cli_flags.tier_floor)`. Off-ladder tiers (e.g. fable) bypass cli_floor and cli_cap on retry. cli_cap does NOT apply on retry (escalation is intentional). Append the escalation to `tier_decisions.json`.
     - If the coach returns `ok: false`, `finalize_stage(surfaced)` and BREAK.
     - If the coach returns `ok: true`, the **driver** MUST use the returned `retry_prompt` to re-dispatch the original generator agent. Pass `parent_attempt_id`, `retry_index=1`, `attempted_tier=retry_tier`, and `model: CLAUDE_TIER_MODELS[retry_tier]` on the retry dispatch so the new attempt is recorded in the daemon ledger as the Reflexion retry.
     - After the retry generator finishes, the **driver** MUST re-run `judge-router` + the chosen judge against the new attempt. Do NOT treat the coach's narrative output as proof that the retry happened.
     - Before advancing, verify the daemon ledger now contains **both** the retry attempt (`retry_index=1`, `parent_attempt_id=<original attempt>`) and the new verdict for that retry attempt (for example via `mcp__pp_harness__get_run`). If either row is missing, treat it as a sub-agent-contract violation: archive the evidence to `contract_violations/<stage_id>.json`, `finalize_stage(surfaced)`, `finalize_run(status="aborted", summary_md=<ledger mismatch context>)`, and STOP.
     - On retry verdict `pass`, call `mcp__pp_harness__get_stage_finalize_readiness(stage_id)` again and only `finalize_stage(passed)` when it returns `next_action="finalize_passed"`. If retry readiness is still blocked, `finalize_stage(surfaced)` and BREAK.
   - `get_stage_finalize_readiness` is the branching primitive; the daemon's `finalize_stage` exceptions are defense-in-depth only. If you somehow skip the readiness branch and hit a `TddGateViolation` / validator refusal inside `finalize_stage`, that's a driver bug — fix the flow, do not use the exception path as normal control flow.

7. **Missability.** Use the Task tool to invoke `missability-inspector`, passing `required_check_ids` = (mapping ∪ team ∪ profile). Any fail → `final_status="surfaced"`.

8. **Master-plan patch.** Use the Task tool to invoke `master-plan-patcher`.

9. **Finalize.** Use the Task tool to invoke `run-finalizer` with `mode="team"`.

10. **Report.** Per-stage table (`stage | gate_type | rubric | producer/judge | model_tier | judge | verdict | tokens | cost`). The `model_tier` column shows `<tier>` for Claude generators (e.g. `sonnet`, or `sonnet→opus` if Reflexion escalated) and `—` for Codex/agy. The `judge` column shows `vendor/model@effort` from `judge_decisions.json`'s `resolved` block (e.g. `codex/gpt-5.6-terra@medium`), with ` ⚠pin_mismatch` appended when the critique envelope reported one. Add an **"Operator judge overrides"** block listing every stage whose `source != "default"` (`stage | source | resolved vendor/model@effort | reason`), omitted entirely when every stage ran at the default. Add a tier-breakdown row from `budget_status(scope="tier:opus|sonnet|haiku")` so the user sees where spend went. Missability tally, master-plan delta, total cost, artifact paths (including `tier_decisions.json` and `judge_decisions.json`). **For TDD-shaped runs**, add a `TDD checks` section: per `tests_pre`/`code` pair, show `mode | runner | pre: expected→actual (status) | post: expected→actual (status) | duration_ms | output_path`. Surface any violation or execution_error verbatim.

## Notes

- The team yaml is authoritative for stage ordering and generator binding. The daemon's `gate_eligible_judges` is authoritative for cross-vendor policy.
- For UI-shaped teams (`ux-team`, `design-system-team`) on `web-ui` / `mobile` profiles, an extra `visual_regression` stage is added at the end of the pipeline (handled inside the team yaml).
