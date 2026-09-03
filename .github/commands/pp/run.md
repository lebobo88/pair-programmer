---
name: "pp:run"
description: Run a request through the full pair-programmer lifecycle (triage → profile → taxonomy → stage loop with judge routing + Reflexion ×1 → missability → master-plan patch → finalize).
argument-hint: <free-text request>
---

<!-- Generated from .claude\commands\pp\run.md. Edit the .claude source file and rerun node scripts/sync-copilot-assets.mjs. -->

You are about to drive a `/pp:run` invocation through the pair-programmer harness. Follow the `pair-programmer` skill protocol exactly. This command runs in `mode="single"`. For multi-candidate runs, use `/pp:best-of`. For team-driven pipelines, use `/pp:team`. For governance reviews, use `/pp:review`.

**Delegation contract:** All MCP tool access flows through sub-agent delegation per the Delegation Contract in `pair-programmer.md` (the master skill). Do not bypass. `PP_ALLOW_AD_HOC=1` is daemon-developer-debug only and MUST NOT be proposed as a remedy in this lifecycle.

User request: $ARGUMENTS

## CLI-flag pre-parse

Before treating `$ARGUMENTS` as request text, strip recognised flags. Same convention as `pp:doctor --quick`. This section is the canonical definition — `/pp:team`, `/pp:best-of`, `/pp:gate`, `/pp:retry`, and `/pp:review` reference it.

### Tier flags

- `--tier-cap=opus|sonnet|haiku` — upper bound on the resolved Claude tier for every stage in this run.
- `--tier-floor=opus|sonnet|haiku` — lower bound on the resolved Claude tier for every stage in this run.
- `--no-tier-policy` — bypass the profile's `model_tier_policy` block entirely (debug only; agent frontmatter + team-yaml + CLI flags still apply).

### Judge-override flags (JUDGE-1a)

`CONSTITUTION.md` Article V **JUDGE-1a** permits an explicit operator override of the judge vendor, model, or reasoning effort. These flags are that override path. They never downgrade a cross-vendor gate — the closing verdict is always `judge-cross-vendor`.

- `--judge-vendor=codex|agy` — which non-Claude vendor issues the closing verdict. `--judge-vendor=claude` is INVALID (Claude is the generator vendor in this harness; a Claude judge could not be cross-vendor).
- `--judge-model=<id>` — an allow-listed critique model id for that vendor (`JUDGE_MODEL_POLICY` in `daemon/src/config.ts`, surfaced by `doctor().judge_capabilities[<vendor>].allowed_critique_models`).
- `--judge-effort=low|medium|high|xhigh` — reasoning effort. `xhigh` is Codex-only; agy has no `xhigh`.
- `--judge-escalate` — select the vendor's pinned escalated lane (Codex `gpt-5.6-sol`, agy `gemini-3.1-pro-high`) instead of naming a model.
- `--judge-reason="<text>"` — the operator's reason, recorded on every verdict. Required (≥ 8 characters) whenever `--judge-model` or `--judge-effort` is given.

### Parsing and STOP conditions

Parse with a single regex pass: extract any of the above into a `cli_flags` object, then remove their tokens from the request text. Store the judge flags as `judge_vendor`, `judge_model`, `judge_effort`, `judge_escalate`, `judge_reason`.

Reject unknown tier values with a clear error message ("expected opus|sonnet|haiku, got 'X'") rather than silently ignoring.

**These are parse-time STOP conditions. They fire BEFORE any daemon call — no `start_run`, no run row, nothing to finalize:**

| Condition | Message |
|---|---|
| `--judge-model` together with `--judge-escalate` | "`--judge-model` and `--judge-escalate` are mutually exclusive: escalate selects the vendor's pinned escalated model. Pass one or the other." |
| `--judge-model` without `--judge-vendor` | "`--judge-model` requires `--judge-vendor=codex\|agy` — a model id is only meaningful against a vendor's allow-list." |
| `--judge-model` or `--judge-effort` without `--judge-reason` | "`--judge-reason=\"<text>\"` (≥ 8 characters) is required when overriding the judge model or effort (JUDGE-1a(b))." |
| `--judge-reason` shorter than 8 characters | "`--judge-reason` must be at least 8 characters; got N." |
| `--judge-vendor=claude` | "`--judge-vendor=claude` is invalid: every gate is cross-vendor (JUDGE-1) and the generator is Claude. Use `codex` or `agy`." |
| unknown `--judge-vendor` value | "expected codex\|agy, got 'X'" |
| unknown `--judge-effort` value | "expected low\|medium\|high\|xhigh, got 'X'" |
| `--judge-effort=xhigh` with `--judge-vendor=agy` | "agy has no `xhigh` reasoning effort. Use low\|medium\|high, or `--judge-vendor=codex`." |

Persist the parsed flags in the run row: pass `cli_flags` to `mcp__pp_harness__start_run` (the daemon stores `cli_flags_json` on `runs` since schema v5). Include them in `tier_decisions.json` and in `judge_decisions.json` so `/pp:replay` can re-issue with the same overrides.

### No prompt layer

Judge overrides are NEVER inferred from request prose (JUDGE-1a: "Overrides are never inferred from request prose"). If the operator's `$ARGUMENTS` text matches `/\b(judge (this|it) with|use \S+ (to )?judge)\b/i`, print exactly one hint line naming the equivalent flag — e.g. `hint: to route the judge explicitly, pass --judge-vendor=agy --judge-reason="<why>"; continuing with defaults` — and then continue with the defaults. Do NOT set any judge flag from the match, and do NOT introduce a `prompt` override source.

## AGENT_TIER_DEFAULTS (mirror of agent frontmatter)

This driver mirrors `.github/agents/*.agent.md` frontmatter `model:` values so the tier resolver can log the chosen tier even when the Task() call would have fallen through to the agent default. The source of truth is the agent file; this table is for traceability. On a mismatch, the agent file wins — `/pp:doctor` reports the drift.

| agent | tier |
|-------|------|
| strategy-author, spec-author, architect, security-reviewer, discovery-researcher, ai-controls-author, narrative-designer, encounter-designer, level-designer, game-ai-programmer, netcode-programmer, game-security | opus (`claude-opus-5`) |
| engineer, api-designer, designer, design-system-curator, test-strategist, docs-author, ops-author, data-modeler, release-planner, retirement-planner, governance-author, economy-designer, live-ops-manager, tech-animator, technical-artist, game-accessibility-specialist | sonnet (`claude-sonnet-5`) |
| triage, taxonomy-mapper, profile-loader, judge-router, missability-inspector, master-plan-patcher, run-finalizer, reflexion-coach, browser-validator, visual-regression-runner | haiku (`claude-haiku-4-5-20251001`) |
| judge-cross-vendor, judge-same-vendor | — (judges pick their own model from internal rotation; see those agents' Procedure sections) |

Resolve the canonical tier→model-id map via `mcp__pp_harness__get_copilot_claude_tier_models` (it returns `{ tiers: { opus, sonnet, haiku }, order: ["haiku","sonnet","opus"] }`).

## Judge-override precedence

Resolved **per field** (`vendor`, `model`, `reasoning_effort`, `escalate`), lowest precedence first. A layer that does not set a field leaves the lower layer's value intact — a team yaml that sets only `reasoning_effort` does not clear a CLI `--judge-model`, and a CLI `--judge-effort` does not clear the team yaml's `model`.

| # | Layer | `override_source` | `override_reason` |
|---|---|---|---|
| 1 | Daemon default (Codex `gpt-5.6-terra` / medium; agy `gemini-3.8-flash-medium` / medium) | `"default"` | — |
| 2 | Team yaml `judge` block (`model` / `reasoning_effort` / `escalate`) | `"team_yaml"` | `"team yaml <team>/<stage> judge block"` |
| 3 | CLI flags (`--judge-vendor` / `--judge-model` / `--judge-effort` / `--judge-escalate`) | `"cli"` | the `--judge-reason` text verbatim |

`"escalated"` is the source recorded when the escalated lane is selected without an operator override (a sanctioned hard gate or last-resort Reflexion verdict per `judge-policy.md`). `"hydra"` is reserved for overrides arriving on a Hydra `DevTask` envelope. There is **no `"prompt"` source** — see "No prompt layer" above.

Build a `trace` array as you resolve, one `{ layer, field }` entry per field a layer actually set (`{"layer":"team_yaml","field":"reasoning_effort"}`, `{"layer":"cli","field":"model"}`, …). It goes into `judge_decisions.json`.

The resolved object is passed to `judge-router` as `judge_override { vendor?, model?, reasoning_effort?, escalate?, source, reason }`. `judge-router` validates it and returns `override_status`; on `"rejected"` the driver **aborts the run** (see step 6).

## Lifecycle (do these steps in order)

1. **Triage.** Use the Task tool to invoke the `triage` sub-agent. Pass `request_text=$ARGUMENTS`. Capture `{ class, signals }`.

2. **Profile snapshot.** Use the Task tool to invoke the `profile-loader` sub-agent. Pass `cwd` (current working directory) and `request_text`. Capture the snapshot. If `source = "needs_bootstrap"`, follow the bootstrap flow in `pair-programmer` skill step 2 (detect → confirm → write → re-load). Only proceed to step 3 once a profile is bound or the user explicitly chose `skip` / generic mode.

2.5. **Validate judge overrides (only when a judge flag is set).** If `cli_flags` carries any of `judge_vendor` / `judge_model` / `judge_effort` / `judge_escalate`, call `mcp__pp_harness__doctor` BEFORE `start_run` and validate against what it reports. Capture `judge_capabilities` (per vendor: `allowed_critique_models[]`, `default_critique_model`, `escalated_critique_model`, `allowed_reasoning_efforts[]`) and `agy_disabled`.

   - `judge_vendor="agy"` and `doctor().agy_disabled === true` → **STOP**. Print: "`--judge-vendor=agy` is unavailable: the agy kill-switch `PP_DISABLE_AGY=1` is set. Unset it in `.claude/settings.local.json` (and re-authenticate the agy CLI: run `agy` bare for interactive Google Sign-In, or set `GEMINI_API_KEY`/`GOOGLE_API_KEY`/`ANTIGRAVITY_API_KEY`), or re-run with `--judge-vendor=codex`."
   - `judge_model` not in `judge_capabilities[judge_vendor].allowed_critique_models` → **STOP**. Print the rejected id AND the full allow-list for that vendor, plus its `default_critique_model` and `escalated_critique_model`. A non-allow-listed id also throws at the bridge; catching it here means no orphan run row.
   - `judge_effort` not in `judge_capabilities[judge_vendor].allowed_reasoning_efforts` → **STOP**. Print the rejected value and the allow-list. (When no `judge_vendor` was given, validate the effort against every vendor whose lane could be routed; if it is allowed by none, STOP.)
   - The chosen vendor is not configured at all in `doctor().vendors_configured` → **STOP** with the vendor-configuration remediation from `judge-policy.md`.

   Every failure here STOPS **before a run row exists**. Do not call `start_run` and then `finalize_run(status="aborted")` — there is nothing to abort yet. Print the error and exit.

3. **Start run.** Call `mcp__pp_harness__start_run` with `request_text=$ARGUMENTS`, `project_path=<cwd>`, `mode="single"`, and `cli_flags` (the object parsed in the CLI-flag pre-parse, including the judge fields). Capture `run_id`, `artifact_dir`, and `started_at`.

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
   - `mcp__pp_harness__gate_eligible_judges` with `gate_type`, `requested_judge_model=<resolved judge model or omit>`, `requested_judge_effort=<resolved effort or omit>`, `generator_producer="claude"` (the `engineer` producer is **Path A / Claude** — see `.github/agents/engineer.agent.md`; Paths B/C codex/agy *generation* are deprecated, external CLIs are critique-only, so cross-vendor judging resolves to codex), `generator_model=<the resolved Claude tier model id from step 6a when known; otherwise let the daemon infer a default>`, `prompt_keywords=$ARGUMENTS`, `profile=<profile.name or null>`, `artifact_kind` (per-stage canonical kind). Capture `{ required_cross_vendor, rubric_id, allowed_judges, upgraded, reason }`.

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
   - Judge routing: use the Task tool to invoke `judge-router` with `gate_type`, `generator_producer`, `generator_model=<attempt.model_id or planned model id>`, `prompt_keywords`, `profile`, `artifact_kind`, and `judge_override` (the object resolved in "Judge-override precedence"; omit it when every field is at the daemon default). Capture `{ judge_agent, preferred_producers, rubric_id, decision_reason, judge_vendor, judge_model, judge_reasoning_effort, judge_escalate, override_source, override_reason, override_status, override_rejection_reason }`.
     - **On `override_status="rejected"`: STOP.** Print `override_rejection_reason` verbatim plus the remediation for it (see `judge-router.md`), then `mcp__pp_harness__finalize_run(status="aborted", summary_md=<the rejection context>)`. A rejected override is NEVER silently dropped and NEVER downgraded to the default — the operator asked for a specific judge and must be told they cannot have it.
     - On `override_status="applied"`, carry `judge_vendor` / `judge_model` / `judge_reasoning_effort` / `judge_escalate` / `override_source` / `override_reason` through to the judge invocation unchanged.
     **The closing verdict is ALWAYS recorded by `judge-cross-vendor`** — every gate type is cross-vendor per JUDGE-1 (`CONSTITUTION.md` Article V), so `gate_eligible_judges` returns `required_cross_vendor: true` at every gate. If `judge-router` returns a same-vendor lane, that lane is **supplementary only**: its verdict may be recorded for an extra opinion but it can never be the verdict used for `finalize_stage(passed)` (JUDGE-2 — a same-vendor-only verdict cannot close a stage).
   - Judge execution: use the Task tool to invoke the chosen judge agent (`judge-cross-vendor` or `judge-same-vendor`) with the attempt / artifact context plus `rubric_id` (or `rubric_md` if already resolved). **Also pass `artifact_path`** — the project-relative path the generator archived (`.harness/<run_id>/<relative_path>`, as returned by `archive_artifact`). The judge needs it to cite the artifact under judgment in `findings_provenance`; without it the judge invents a path, the daemon fails to resolve it, and the verdict is flagged `hallucination_suspected=1`. This is the main reason document stages tripped PP-VG-6 while code stages (which cite real repo paths) did not. **Also pass the routed override fields** (`judge_vendor`, `judge_model`, `judge_reasoning_effort`, `judge_escalate`, `override_source`, `override_reason`) so the judge can hand them to the critique tool. The chosen judge fetches the rubric if needed, runs `pp_<other>__critique` (or in-process Claude judging on the supplementary same-vendor Claude lane), and records the verdict. Only a verdict with `cross_vendor=true` may close the stage. Capture `verdict.outcome`, `cross_vendor`, and the judge's returned `model` / `reasoning_effort` / `override_source` / `pin_mismatch` (all read from the critique RESULT envelope, never the request).

   - **6c. Archive `judge_decisions.json`.** After each verdict is recorded (including a Reflexion retry's verdict and any PP-VG-6 rejudge), append a `per_stage` entry and re-archive the whole document. Same mechanics as `tier_decisions.json` in step 5b, but with `force_overwrite: true` because it is rewritten on every verdict:

     ```
     mcp__pp_harness__archive_artifact({
       run_id,
       relative_path: "judge_decisions.json",
       kind: "judge_decisions",
       taxonomy_section: "4.14",   // governance
       force_overwrite: true,
       bytes: JSON.stringify({
         cli_flags: {
           judge_vendor, judge_model, judge_effort, judge_escalate, judge_reason
         },                                  // parsed in the CLI-flag pre-parse; nulls when unset
         allowed_critique_models,            // doctor().judge_capabilities[<vendor>].allowed_critique_models, per vendor
         per_stage: [
           {
             stage_id, stage_kind, gate_type,
             required_cross_vendor,          // from gate_eligible_judges (always true)
             judge_agent,                    // "judge-cross-vendor"
             generator_producer, generator_model,
             resolved: { vendor, model, reasoning_effort, escalate },
             source,                         // "default" | "escalated" | "cli" | "team_yaml" | "hydra"
             reason,                         // the override reason, or null at the default
             trace: [{ layer, field }],      // which layer set which field
             verdict_id, outcome, cross_vendor, pin_mismatch
           },
           ...
         ],
       })
     })
     ```

     `resolved` and `pin_mismatch` are taken from the critique RESULT envelope the judge returned (`model`, `reasoning_effort`, `override_source`, `override_reason`, `pin_mismatch`) — record what actually ran, not what was requested. If `pin_mismatch` is true, surface it in the run summary.
   - **Assert the recorded provenance.** `record_verdict` returns the daemon-computed `cross_vendor` flag. If judge routing said `required_cross_vendor=true` and the returned `cross_vendor` is `false`, the gate was NOT satisfied, whatever the outcome says: STOP, print the attempt's `producer` and the verdict's `judge_producer`, and `finalize_run(status="aborted")`. Do NOT `finalize_stage(status="passed")`. Capturing the requirement from `gate_eligible_judges` and never checking the result is what let every verdict in a real run record `cross_vendor: false` while codex and agy were genuinely judging.
   - **If the judge sub-agent returns `judge_tool_failed=true`** (instead of a verdict): the underlying critique CLI failed persistently. Archive the failure context via `mcp__pp_harness__archive_artifact` with `relative_path: "critique_failures/<stage_id>.json"`, `kind: "critique_failure"`, and `bytes` = the JSON payload `{ judge_tool_failed, reason, vendor, model, exit_code, stderr_tail, attempts, failure_archive_path }`. Then call `mcp__pp_harness__finalize_stage(stage_id, status="surfaced")` and `mcp__pp_harness__finalize_run(status="aborted", summary_md=<judge tool failure context including failure_archive_path>)`. STOP. Do NOT advance to the next stage. Do NOT invoke Reflexion (Reflexion fixes generators, not broken judge environments). Do NOT fabricate a passing verdict to "unblock the pipeline" — halting is correct.
   - On `outcome="pass"`: call `mcp__pp_harness__get_stage_finalize_readiness(stage_id)` **before** any `finalize_stage(status="passed")`.
     - If it returns `next_action="run_tdd_pre_check" | "run_tdd_post_check" | "run_artifact_validate"`, call that tool immediately, then re-call `get_stage_finalize_readiness(stage_id)`.
     - If readiness returns `next_action="finalize_passed"`, call `mcp__pp_harness__finalize_stage(stage_id, status="passed", winner_attempt_id=<>)` and continue to the next stage.
     - If readiness returns `next_action="retry_or_surface"`, treat the first blocker message / evidence as the critique and enter the Reflexion path below instead of attempting `finalize_stage(status="passed")`.
     - If readiness returns `next_action="surface_stage"`, call `mcp__pp_harness__finalize_stage(stage_id, status="surfaced")` and BREAK.
     - If readiness returns `next_action="dispatch_cross_vendor_rejudge"` (the PP-VG-6 hallucination gate, or the PP-VG-4 findings-closure gate), do NOT surface yet and do NOT invoke Reflexion — the artifact is not what is being questioned, the *verdict* is. Instead:
       1. Read the blocker's `attempt_id` and `verdict_id`. Confirm the `attempt_id` belongs to the stage you are finalizing; if it does not, surface the stage and report the inconsistency rather than re-judging a foreign attempt.
       2. Identify the suspect verdict's `judge_producer` — the blocker `message` names the vendor that MUST NOT issue the clearing verdict. (`cross_vendor` is computed generator-vs-judge, so without this the suspecting vendor could clear its own flag; the daemon enforces `judge_producer != <suspect>` on the clearance query, so a re-judge by the same vendor will NOT clear the gate and you will simply loop.)
       3. Call `mcp__pp_harness__gate_eligible_judges` and pick a judge vendor that differs BOTH from the attempt's `producer` AND from the suspect verdict's `judge_producer`. If no such vendor is configured, call `mcp__pp_harness__finalize_stage(stage_id, status="surfaced")` and BREAK — report that no independent judge was available. Do NOT retract the suspect verdict to get around this; `retract_verdict` is an operator decision, not a driver one.
       4. Use the Task tool to invoke `judge-cross-vendor` against that `attempt_id` with the chosen vendor, the same rubric, and the artifact context. It records a new verdict.
       5. **Bound this to ONE rejudge per stage.** Track a per-stage `rejudge_used` flag. This budget is SEPARATE from the Reflexion ×1 slot (a rejudge re-judges; it does not re-generate). If readiness returns `dispatch_cross_vendor_rejudge` a second time for the same stage, call `finalize_stage(stage_id, status="surfaced")` and BREAK.
       6. Re-call `get_stage_finalize_readiness(stage_id)` and branch on the **newly returned** `next_action` — do not assume the original blocker is still first in the list. Only `finalize_passed` may finalize the stage as passed.
     - **Unknown `next_action` fallback.** If readiness returns any `next_action` not handled above, call `mcp__pp_harness__finalize_stage(stage_id, status="surfaced")` and BREAK, printing the blocker `message` verbatim. Never treat an unrecognized action as permission to pass, and never fall through silently — an unhandled action is what made the PP-VG-6 gate an undefined stall instead of a recoverable state.
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
    - A per-stage table: `stage | gate_type | rubric | producer/judge | model_tier | judge | verdict | tokens_in/out | cost_usd`. The `model_tier` column shows `<tier>` for Claude generators (e.g. `sonnet`, or `sonnet→opus` if Reflexion escalated) and `—` for Codex/agy producers. The `judge` column shows `vendor/model@effort` from `judge_decisions.json`'s `resolved` block — e.g. `codex/gpt-5.6-terra@medium`, `agy/gemini-3.8-flash-medium@medium`, `codex/gpt-5.6-sol@medium` when escalated. Append ` ⚠pin_mismatch` when the critique envelope reported one.
    - An **"Operator judge overrides"** block listing every stage whose `source != "default"`: `stage | source | resolved vendor/model@effort | reason`. Omit the block entirely when every stage ran at the default. If the run aborted on a rejected override, print the rejection reason here instead.
    - The artifact paths under `<project>/.harness/<run_id>/` (including `tier_decisions.json` and `judge_decisions.json`).
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
- `required_cross_vendor=true` but the `cross_vendor` returned by `record_verdict` is `false` → STOP, print the attempt `producer` + verdict `judge_producer`, and `finalize_run(status="aborted")`. The vendor-matrix probe above checks *readiness*; this checks what was actually *recorded*. Both are required — a ready matrix does not prove the verdict that landed was cross-vendor.
- `record_attempt` / `record_verdict` rejects a producer ("is not a vendor id") → the driver passed a sub-agent role where a vendor id belongs. Re-record with the vendor (`claude` | `codex` | `agy` | `copilot`) and put the role in `agent_type`. Do NOT work around it by inventing a vendor.
- Loop ceiling reached → finalize as `surfaced` with the evidence in the summary.
- Missability fail → finalize as `surfaced` with the evidence path.
- Judge tool failed (`judge_tool_failed=true`) → archive the failure context, finalize stage `surfaced` + run `aborted`, STOP. Do NOT Reflexion. Do NOT fabricate a verdict.
- Manual-edit detection during `archive_artifact` → ask the user whether to merge or pass `force_overwrite=true`; do not silently clobber.
- Tier resolver: stage's agent name not in AGENT_TIER_DEFAULTS → STOP, print "agent X has no tier — add `model:` to .github/agents/X.agent.md or update the AGENT_TIER_DEFAULTS table at the top of run.md", `finalize_run(status="aborted")`. Refusing to dispatch beats silently inheriting Opus.
- Unknown tier value in CLI flag → STOP with "expected opus|sonnet|haiku, got 'X'", do NOT start the run.
- Any judge-flag parse-time STOP condition (see the table in the CLI-flag pre-parse) → print the message and exit. Do NOT call `start_run`; there is no run to abort.
- Step 2.5 validation failure (model not allow-listed, effort not allowed, `agy_disabled`, vendor unconfigured) → STOP before `start_run`, printing the rejected value AND the allow-list from `doctor().judge_capabilities`.
- `judge-router` returns `override_status="rejected"` → STOP, print `override_rejection_reason` verbatim with its remediation, `finalize_run(status="aborted")`. Never fall back to the default judge silently — that would hide the operator's rejected intent behind a green run.
- Critique envelope returns `pin_mismatch: true` → the effective model differs from the vendor's pin. Record it in `judge_decisions.json` and surface it in the summary; this is a warning, not a halt (the daemon already refused any non-allow-listed id).
