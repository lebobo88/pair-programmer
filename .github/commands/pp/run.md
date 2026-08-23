---
name: "pp:run"
description: Run a request through the full pair-programmer lifecycle (triage → profile → taxonomy → stage loop with judge routing + Reflexion ×1 → missability → master-plan patch → finalize).
argument-hint: <free-text request>
---

<!-- Generated from .claude\commands\pp\run.md. Edit the .claude source file and rerun node scripts/sync-copilot-assets.mjs. -->

You are about to drive a `/pp:run` invocation through the pair-programmer harness. Follow the `pair-programmer` skill protocol exactly. This command runs in `mode="single"`. For multi-candidate runs, use `/pp:best-of`. For team-driven pipelines, use `/pp:team`. For governance reviews, use `/pp:review`.

**Delegation contract:** All MCP tool access flows through sub-agent delegation per the Delegation Contract in `pair-programmer.md` (the master skill). Do not bypass. `PP_ALLOW_AD_HOC=1` is daemon-developer-debug only and MUST NOT be proposed as a remedy in this lifecycle.

User request: $ARGUMENTS

## Tier-flag pre-parse

Before treating `$ARGUMENTS` as request text, strip recognised tier flags. Same convention as `pp:doctor --quick`.

- `--tier-cap=opus|sonnet|haiku` — upper bound on the resolved Claude tier for every stage in this run.
- `--tier-floor=opus|sonnet|haiku` — lower bound on the resolved Claude tier for every stage in this run.
- `--no-tier-policy` — bypass the profile's `model_tier_policy` block entirely (debug only; agent frontmatter + team-yaml + CLI flags still apply).

Parse with a single regex pass: extract any of the above into a `cli_flags` object, then remove their tokens from the request text. Reject unknown tier values with a clear error message ("expected opus|sonnet|haiku, got 'X'") rather than silently ignoring. Persist the parsed flags in the run row (the daemon stores `cli_flags_json` on `runs` since schema v5) and include them in `tier_decisions.json` so `/pp:replay` can re-issue with the same overrides.

## AGENT_TIER_DEFAULTS (mirror of agent frontmatter)

This driver mirrors `.github/agents/*.agent.md` frontmatter `model:` values so the tier resolver can log the chosen tier even when the Task() call would have fallen through to the agent default. The source of truth is the agent file; this table is for traceability. On a mismatch, the agent file wins — `/pp:doctor` reports the drift.

| agent | tier |
|-------|------|
| strategy-author, spec-author, architect, security-reviewer, discovery-researcher, ai-controls-author, narrative-designer, encounter-designer, level-designer, game-ai-programmer, netcode-programmer, game-security | opus (`claude-opus-5`) |
| engineer, api-designer, designer, design-system-curator, test-strategist, docs-author, ops-author, data-modeler, release-planner, retirement-planner, governance-author, economy-designer, live-ops-manager, tech-animator, technical-artist, game-accessibility-specialist | sonnet (`claude-sonnet-5`) |
| triage, taxonomy-mapper, profile-loader, judge-router, missability-inspector, master-plan-patcher, run-finalizer, reflexion-coach, browser-validator, visual-regression-runner | haiku (`claude-haiku-4-5-20251001`) |
| judge-cross-vendor, judge-same-vendor | — (judges pick their own model from internal rotation; see those agents' Procedure sections) |

Resolve the canonical tier→model-id map via `mcp__pp_harness__get_copilot_claude_tier_models` (it returns `{ tiers: { opus, sonnet, haiku }, order: ["haiku","sonnet","opus"] }`).

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

5b. **Archive tier-decision plan.** Compute the effective tier for every stage that will run (using the resolver in step 6a) and archive a single `tier_decisions.json` artifact so `/pp:replay` is deterministic and `/pp:doctor` can audit. Call:

```
mcp__pp_harness__archive_artifact({
  run_id,
  relative_path: "tier_decisions.json",
  kind: "tier_decisions",
  taxonomy_section: "4.14",   // governance
  bytes: JSON.stringify({
    cli_flags,                      // parsed in Tier-flag pre-parse
    profile_policy: profile?.model_tier_policy ?? null,
    per_stage: [
      { stage_kind, agent, initial_tier, model_id, trace: [layer entries] },
      ...
    ],
  })
})
```

The `trace` array records which layer set the final tier ("frontmatter", "team_yaml", "scope_adjust", "profile_per_stage", "profile_cap", "cli_cap", "cli_floor"). The retry path appends a `retry` entry per stage that escalates (see step 6).

5c. **Ensure AGENTS.md / CLAUDE.md.** Call `mcp__pp_harness__ensure_agents_md({ project_path: <cwd>, profile: profile?.name, also_claude_md: true, conventions: profile?.agents_md_template?.conventions, build_commands: profile?.agents_md_template?.build_commands, extra_sections: profile?.agents_md_template?.extra_sections })`. This is idempotent: existing files are not touched. The resulting AGENTS.md is the cross-tool behavioral contract every sub-agent (engineer, spec-author, architect, security-reviewer, docs-author) MUST read before producing artifacts. CLAUDE.md is its Claude-specific shim (one-line `@AGENTS.md` import plus Claude-Code-only add-ons). Both files are snapshotted into `<run>/agents_md_snapshot.md` and `<run>/claude_md_snapshot.md` automatically by `start_run`. Pass `agents_md_path: <cwd>/AGENTS.md` into every downstream Task() invocation so sub-agents know where to read it from.

6. **Stage loop.** Pick the stage set by triage class:
   - `trivial` → just `code` (or `docs` if the request is doc-shaped).
   - `standard` → `spec` → `code` → `tests` → `docs`.
   - `major` →
     - **If `signals` includes `"doc-only"`** (taxonomy.ts walks `doc-only` back from `major-keyword`/`security-keyword` by −3, but a high-signal stack can still resolve to `major`), continue into a **single doc stage** instead of aborting. Pick the stage kind from the doc-only payload — `docs` is the default; if the request explicitly names an ADR/spec/PRD/RFC, use `spec` (the spec-author agent handles ADR/MADR/spec/PRD/RFC shapes; spec gate_type still applies). Run exactly one stage through the standard `start_stage → generate → judge → finalize` flow with best-of-N=1 (single-stage best-of). Skip Reflexion-escalation past the cap if `cli_flags.tier_cap` is set, but otherwise follow the normal verdict/readiness branches. Then continue to step 7 (Missability).
     - **Otherwise** (true major scope without `doc-only`), STOP and tell the user to invoke `/pp:team feature-team` or another team-shaped flow instead. Finalize the run with `status="aborted"` and explain.

   For each stage:
   - `mcp__pp_harness__start_stage(run_id, kind, gate_type)`. Default `gate_type` per `kind`: `spec→spec`, `code→code_style`, `tests→lint_class`, `tests_pre→contract`, `docs→docs_polish`. Override per profile rubric bindings if the profile names a different gate type for the kind.
   - `mcp__pp_harness__gate_eligible_judges` with `gate_type`, `generator_producer="claude"` (the `engineer` producer is **Path A / Claude** — see `.github/agents/engineer.agent.md`; Paths B/C codex/agy *generation* are deprecated, external CLIs are critique-only, so cross-vendor judging resolves to codex), `generator_model=<the resolved Claude tier model id from step 6a when known; otherwise let the daemon infer a default>`, `prompt_keywords=$ARGUMENTS`, `profile=<profile.name or null>`, `artifact_kind` (per-stage canonical kind). Capture `{ required_cross_vendor, rubric_id, allowed_judges, upgraded, reason }`.

   - **6a. Resolve Claude tier for this stage.** Run the resolver below (highest-precedence wins, layers stack low→high). The resolver only governs Claude generators (Path A inside the `engineer` agent and any agent whose frontmatter pins `model:`). For Codex/Antigravity (agy) producers (engineer Paths B/C, api-designer when delegated to Codex, etc.) skip the resolver and use the vendor's default model id from `daemon/src/config.ts:DEFAULT_MODELS`.

     ```
     initial_tier = AGENT_TIER_DEFAULTS[stage.agent]   // hard error if missing — /pp:doctor catches new agents without frontmatter

     // Layer: team-yaml stage override
     if team_stage?.generator?.model_tier:
       initial_tier = team_stage.generator.model_tier
       trace.push({ layer: "team_yaml", tier: initial_tier })

     // Layer: triage scope adjustment
     delta = profile?.model_tier_policy?.scope_adjust?.[triage.scope] ?? 0
     if delta != 0:
       initial_tier = shiftTier(initial_tier, delta)
       trace.push({ layer: "scope_adjust", scope: triage.scope, delta, tier: initial_tier })

     // Layer: profile policy (per_stage_override beats default_cap)
     // Off-ladder guard: skip numeric cap/floor comparison when initial_tier is
     // off-ladder (tierIndex < 0, e.g. fable). An explicit off-ladder selection
     // must NOT be clamped down by an opus/sonnet/haiku cap or floor — the team
     // yaml set it intentionally and the numeric comparison is undefined for it.
     policy = profile?.model_tier_policy  // ignored if --no-tier-policy
     if !cli_flags.no_tier_policy:
       if policy?.per_stage_override?.[stage.kind]:
         initial_tier = policy.per_stage_override[stage.kind]
         trace.push({ layer: "profile_per_stage", tier: initial_tier })
       elif policy?.default_cap and tierIndex(initial_tier) >= 0 and tierIndex(initial_tier) > tierIndex(policy.default_cap):
         initial_tier = policy.default_cap
         trace.push({ layer: "profile_cap", tier: initial_tier })

     // Layer: CLI flags (highest precedence)
     // Off-ladder guard: only apply cap/floor when initial_tier is on the ladder
     // (tierIndex >= 0). An explicit fable tier set via team_yaml must not be
     // silently downgraded to opus/sonnet/haiku by a --tier-cap flag.
     if cli_flags.tier_cap and tierIndex(initial_tier) >= 0 and tierIndex(initial_tier) > tierIndex(cli_flags.tier_cap):
       initial_tier = cli_flags.tier_cap
       trace.push({ layer: "cli_cap", tier: initial_tier })
     if cli_flags.tier_floor and tierIndex(initial_tier) >= 0 and tierIndex(initial_tier) < tierIndex(cli_flags.tier_floor):
       initial_tier = cli_flags.tier_floor
       trace.push({ layer: "cli_floor", tier: initial_tier })

     model_id = CLAUDE_TIER_MODELS[initial_tier]
     ```

     Where `CLAUDE_TIER_MODELS` and `shiftTier`/`tierIndex` come from `mcp__pp_harness__get_copilot_claude_tier_models` (canonical). The order is `["haiku","sonnet","opus"]`; `shiftTier(t, delta)` clamps at both ends. Off-ladder tiers (e.g. `fable`) have `tierIndex < 0` and are never touched by the cap/floor logic above.

   - Generator: use the Task tool to invoke the matching agent (`spec-author` for spec, `engineer` for code, `test-strategist` for tests, `docs-author` for docs). Pass `run_id`, `stage_id`, `cwd`, `request_text`, `artifact_dir`, `attempted_tier=<initial_tier>`, and (when known) `profile`. **For Claude generators, also pass `model: <model_id>` on the Task invocation** so the Agent tool's per-call model override wins over the agent's frontmatter default. The agent calls the appropriate `pp_<vendor>__generate`, archives via `archive_artifact`, and records via `record_attempt` (passing `attempted_tier` through so cost-by-tier analytics work). Capture `attempt_id`.
   - Judge routing: use the Task tool to invoke `judge-router` with `gate_type`, `generator_producer`, `generator_model=<attempt.model_id or planned model id>`, `prompt_keywords`, `profile`, `artifact_kind`. Capture `{ judge_agent, preferred_producers, rubric_id, decision_reason }`.
   - Judge execution: use the Task tool to invoke the chosen judge agent (`judge-cross-vendor` or `judge-same-vendor`) with the attempt / artifact context plus `rubric_id` (or `rubric_md` if already resolved). The chosen judge fetches the rubric if needed, runs `pp_<other>__critique` (or in-process Claude judging on the same-vendor Claude lane), and records the verdict. Capture `verdict.outcome` and `cross_vendor`.
   - **If the judge sub-agent returns `judge_tool_failed=true`** (instead of a verdict): the underlying critique CLI failed persistently. Archive the failure context via `mcp__pp_harness__archive_artifact` with `relative_path: "critique_failures/<stage_id>.json"`, `kind: "critique_failure"`, and `bytes` = the JSON payload `{ judge_tool_failed, reason, vendor, model, exit_code, stderr_tail, attempts, failure_archive_path }`. Then call `mcp__pp_harness__finalize_stage(stage_id, status="surfaced")` and `mcp__pp_harness__finalize_run(status="aborted", summary_md=<judge tool failure context including failure_archive_path>)`. STOP. Do NOT advance to the next stage. Do NOT invoke Reflexion (Reflexion fixes generators, not broken judge environments). Do NOT fabricate a passing verdict to "unblock the pipeline" — halting is correct.
   - On `outcome="pass"`: call `mcp__pp_harness__get_stage_finalize_readiness(stage_id)` **before** any `finalize_stage(status="passed")`.
     - If it returns `next_action="run_tdd_pre_check" | "run_tdd_post_check" | "run_artifact_validate"`, call that tool immediately, then re-call `get_stage_finalize_readiness(stage_id)`.
     - If readiness returns `next_action="finalize_passed"`, call `mcp__pp_harness__finalize_stage(stage_id, status="passed", winner_attempt_id=<>)` and continue to the next stage.
     - If readiness returns `next_action="retry_or_surface"`, treat the first blocker message / evidence as the critique and enter the Reflexion path below instead of attempting `finalize_stage(status="passed")`.
     - If readiness returns `next_action="surface_stage"`, call `mcp__pp_harness__finalize_stage(stage_id, status="surfaced")` and BREAK.
   - On `outcome="fail" | "revise"` **or** readiness `next_action="retry_or_surface"`: use the Task tool to invoke `reflexion-coach`. It calls `mcp__pp_harness__retry_with_critique(attempt_id, critique_md)` (which enforces ×1 and the loop ceiling). If `ok: false`, surface the run (`finalize_stage(status="surfaced")`, BREAK). If `ok: true`:
     - **Escalate the Claude tier by one step.** `retry_tier = shiftTier(initial_tier, +1)` (haiku→sonnet, sonnet→opus, opus stays; off-ladder tier like fable: shiftTier returns it unchanged). The cli_floor still applies on the retry for LADDER tiers only — apply it with the same off-ladder guard as step 6a: `if cli_flags.tier_floor and tierIndex(retry_tier) >= 0 and tierIndex(retry_tier) < tierIndex(cli_flags.tier_floor): retry_tier = cli_flags.tier_floor`. cli_cap does NOT apply on retry (escalation is intentional). Off-ladder tiers (e.g. fable) bypass BOTH cli_floor and cli_cap on retry, preserving the explicit selection. Append `{ stage_id, initial: initial_tier, retry: retry_tier, reason: "verdict:<outcome>" }` to the in-memory tier-decision trace and re-archive `tier_decisions.json`.
     - Pass `initial_tier` and `retry_tier` to the `reflexion-coach` invocation so it can name the escalation in the retry prompt.
     - The coach re-invokes the generator agent with the critique injected AND **`model: CLAUDE_TIER_MODELS[retry_tier]`** on the Task call, re-judges, and records a second verdict. The new attempt's `attempted_tier` is `retry_tier`.
   - On retry verdict `pass`: call `mcp__pp_harness__get_stage_finalize_readiness(stage_id)` again and branch exactly as above; only call `finalize_stage(status="passed")` when readiness returns `next_action="finalize_passed"`. If retry readiness is still blocked, `finalize_stage(status="surfaced")`, BREAK.

7. **Missability.** Use the Task tool to invoke `missability-inspector`. It calls `mcp__pp_harness__run_missability_checks(run_id, required_check_ids=<from step 5>)`. If any check returns `fail`, set `final_status="surfaced"` and skip to step 9.

8. **Master-plan patch.** Use the Task tool to invoke `master-plan-patcher`. It calls `ensure_master_plan` then patches per touched section. Set `final_status="complete"`.

8b. **AGENTS.md sync.** If the master-plan-patcher touched any of sections 11 (architecture), 12 (interfaces), 13 (engineering standards), or 14 (security), use the Task tool to invoke `agents-md-author`. It reads the patched PROJECT_MASTER.md sections, distills them into AGENTS.md's "Coding conventions" / "Workflow rules" / "Do not" sections via `mcp__pp_harness__apply_agents_md_patch`, and appends a one-line entry to "Notes from the harness" with the run id. If no relevant sections were patched, skip this step. The agents-md-author is idempotent — re-runs on the same run id no-op.

9. **Finalize.** Use the Task tool to invoke `run-finalizer` with `run_id`, `project_path`, `final_status`, `mode="single"`. The finalizer writes `run.summary.md`, calls `finalize_run`, and returns `{ ok, run_id, status, summary_path, master_plan_path, patches_applied }`.

10. **Report to the user.** Print:
    - The run id and status.
    - A per-stage table: `stage | gate_type | rubric | producer/judge | model_tier | verdict | tokens_in/out | cost_usd`. The `model_tier` column shows `<tier>` for Claude generators (e.g. `sonnet`, or `sonnet→opus` if Reflexion escalated) and `—` for Codex/agy producers.
    - The artifact paths under `<project>/.harness/<run_id>/` (including `tier_decisions.json`).
    - The master-plan delta (`patches_applied` count + which sections were patched).
    - The missability check summary (`pass / fail / n/a` counts).
    - Total tokens and cost from `mcp__pp_harness__budget_status(scope="run:<run_id>")`.
    - A tier-breakdown row: query `budget_status(scope="tier:opus")`, `tier:sonnet`, `tier:haiku` and show their totals so the user sees where spend went.
    - A one-paragraph summary of what changed.

## Windows / PowerShell portability notes

**Subprocess spawn on Windows:** All daemon subprocesses (git, npx, plantuml, judge CLIs) are spawned via `trackedExeca` / `trackedExecaNoRefuse` with `windowsHide: true` and arguments passed as an array (never a shell string, never `shell: true`). `execa` resolves `.cmd` shims via PATHEXT automatically so `npx` works without extra shim handling.

**Binary existence probe:** The `onPath()` helper in `c4-render.ts` spawns the binary directly with a no-op flag rather than calling `which` (POSIX) or `where` (Windows). This avoids platform branching while catching ENOENT on all platforms.

**Parallel subagent spawn on Windows/PowerShell:** Parallel Task dispatch (e.g. multiple engineer candidates or browser-validator + engineer in the same stage) can be unreliable on Windows due to PowerShell process-group limits and pipe contention. If parallel dispatch hangs or produces incomplete results, fall back to sequential dispatch: invoke each sub-agent Task call in series, awaiting each before starting the next. The harness timer still applies to the full sequence.

## Failure handling

- Any harness MCP call error → print verbatim, then `mcp__pp_harness__finalize_run(status="aborted", summary_md=<error context>)` and STOP.
- `cross_vendor_required` but `vendor-matrix` reports the matrix is incomplete → STOP, print remediation steps, and `finalize_run(status="aborted")`.
- Loop ceiling reached → finalize as `surfaced` with the evidence in the summary.
- Missability fail → finalize as `surfaced` with the evidence path.
- Judge tool failed (`judge_tool_failed=true`) → archive the failure context, finalize stage `surfaced` + run `aborted`, STOP. Do NOT Reflexion. Do NOT fabricate a verdict.
- Manual-edit detection during `archive_artifact` → ask the user whether to merge or pass `force_overwrite=true`; do not silently clobber.
- Tier resolver: stage's agent name not in AGENT_TIER_DEFAULTS → STOP, print "agent X has no tier — add `model:` to .github/agents/X.agent.md or update the AGENT_TIER_DEFAULTS table at the top of run.md", `finalize_run(status="aborted")`. Refusing to dispatch beats silently inheriting Opus.
- Unknown tier value in CLI flag → STOP with "expected opus|sonnet|haiku, got 'X'", do NOT start the run.
