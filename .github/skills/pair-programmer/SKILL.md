---
name: pair-programmer
description: Master skill for the pair-programmer harness. Loaded by every /pp:* slash command. Defines the full Phase-11 request lifecycle — triage, profile snapshot, taxonomy mapping, judge routing with cross-vendor policy, Reflexion ×1, missability gate, master-plan patching, and run finalization. Read this before driving any harness run.
---

<!-- Generated from .claude\skills\pair-programmer.md. Edit the .claude source file and rerun node scripts/sync-copilot-assets.mjs. -->

# Pair Programmer harness — driver protocol

You are driving the pair-programmer harness. Every request that flows through `/pp:*` follows this protocol. The harness's durable state lives in a local daemon reachable via three MCP servers:

- `pp_harness` — orchestration (start_run, record_attempt, record_verdict, finalize_run, gate_eligible_judges, run_missability_checks, apply_master_plan_patch, …)
- `pp_codex`   — wraps OpenAI Codex CLI (`generate`, `critique`)
- `pp_agy`  — wraps Google Antigravity (agy) CLI (`generate`, `critique`)

Both vendors are required for cross-vendor gates. `mcp__pp_harness__doctor` reports the configured matrix; if `cross_vendor_ready=false`, security/spec/design/contract gates will refuse to run.

## Delegation contract (load-bearing — read first)

The driver (you) and the sub-agents have **different MCP tool surfaces by design**. Most `mcp__pp_harness__*`, `mcp__pp_codex__*`, and `mcp__pp_agy__*` tools are exposed to the responsible sub-agent (via that agent's frontmatter `tools:` list) and reached via the `Task` tool — not by direct call from the driver. A small subset (`start_run`, `start_stage`, `gate_eligible_judges`, `record_taxonomy_mapping`, `archive_artifact`, `get_stage_finalize_readiness`, `finalize_stage`, `finalize_run`, `run_missability_checks`, `budget_status`, `retry_with_critique`) is also available to the driver where the lifecycle steps below explicitly call them. Use only the ones the steps explicitly name.

**Hard rules — never violate, even when stuck:**

- **ToolSearch silence is the design, not a binding failure.** When `ToolSearch` returns no match for an `mcp__pp_*__*` tool that a sub-agent is supposed to call, that means *you* don't have it — the sub-agent does. Delegate to the sub-agent. Do NOT conclude "the MCP server is unbound" and do NOT propose reconnecting `/mcp` unless you have evidence (a real exit-1 from a tool call, not absence from your own surface).
- **`PP_ALLOW_AD_HOC=1` is daemon-developer-debug only.** It is **never** the right answer inside any `/pp:run`, `/pp:gate`, `/pp:retry`, `/pp:replay`, `/pp:team`, or `/pp:review` lifecycle. The driver MUST NOT suggest it to the user. If the user offers it, decline politely, finalize the run as `aborted` with the failure surfaced, and ask the user to fix the underlying cause (a missing run-owned-edit, a broken vendor binding, etc.) instead of bypassing the harness.
- **Sub-agent contracts are write-once.** If a judge sub-agent returns without a recorded verdict (no `record_verdict` call landed in the daemon), treat that as `judge_tool_failed=true` regardless of what the agent said in its summary — the daemon ledger is the source of truth, not the agent's narration.
- **No file-system fallbacks for harness writes.** When a harness MCP tool fails, do NOT compensate by editing `PROJECT_MASTER.md`, `run.summary.md`, `taxonomy_mapping.json`, or anything under `.harness/<run_id>/` directly. The hook will block the edit; even if it didn't, the daemon ledger would diverge from disk. Surface the failure and STOP.

The exception to all of the above is **the harness's own working tree** (the `pair-programmer` repo and its descendants — typically the directory containing `daemon/`, `.claude/`, and `taxonomy_blueprint.md`). When editing the harness itself — its skills, agents, daemon source, build scripts — make edits directly. Phase 10 hooks have not yet shipped, so the harness's own code is not yet self-hosted under its own contract. Outside the harness's own tree (any consuming project), the rules above apply with no exceptions.

## Cross-references (read on demand)

- `taxonomy-adherence.md` — every task maps to ≥1 of the 16 sections; trivial = changelog only.
- `judge-policy.md` — base tier table, content-keyword upgrades, profile-aware upgrades, candidate-order randomization, Borda for N≥3.
- `artifact-conventions.md` — file layout under `<run_id>/`.
- `rubric-application.md` — how to invoke `get_rubric` and emit structured rubric scores.
- `profile-aware-gating.md` — how `<project>/.harness/profile.yaml` modifies gates.
- `master-plan-patching.md` — protocol for the `master-plan-patcher` and `run-finalizer` agents.

## Lifecycle (full)

**Step semantics (read once, apply to every step below).** Each step is one of two shapes:

- **"Use the Task tool to invoke `<agent>`"** ⇒ you MUST delegate to that sub-agent. Do NOT replicate its tool calls in the driver. If `Task` itself fails (the agent type is unavailable, the agent crashes, or the response is malformed), `mcp__pp_harness__finalize_run(status="aborted", summary_md=<failure context>)` and STOP. Do NOT compensate by calling the agent's MCP tools yourself.
- **"Call `mcp__pp_harness__<tool>`"** ⇒ this is a driver-callable tool (the small allowlist named in the Delegation Contract above). Call it directly. If it errors, halt per the failure handling rules below. Do NOT silently retry on a different surface or substitute a sub-agent.

The driver MUST NOT call any `mcp__pp_codex__*`, `mcp__pp_agy__*`, or `mcp__pp_harness__record_*` / `mcp__pp_harness__apply_master_plan_patch` / `mcp__pp_harness__retry_with_critique` (without a sub-agent shell) tool directly — those flow through sub-agents only.

1. **Triage.** Use the Task tool to invoke the `triage` agent. Pass `request_text`. It returns `{ class: "trivial" | "standard" | "major", signals: string[] }`. Trivial → minimum-artifact (changelog) path; major → consider escalating to `/pp:team` mode.

2. **Profile snapshot (with first-run bootstrap).** Use the Task tool to invoke the `profile-loader` agent. It calls `mcp__pp_harness__get_profile` (with `project_path = cwd`).

   - If the loader returns `source: "project"` or `source: "builtin"` → capture the snapshot and continue to step 3.
   - If the loader returns `source: "needs_bootstrap"`, branch on `detection.confidence`:
     - **`high`** → auto-write. Announce one line to the user before proceeding (`"Detected <recommendation> profile (signals: <signals>). Writing <project>/.harness/profile.yaml. Run /pp:profile <other> to switch."`), call `mcp__pp_harness__write_profile` with `name = detection.recommendation`, `source = "detected"`, `signals = detection.signals`, and the active `run_id`. Then re-invoke `profile-loader` so the next step sees `source: "project"`.
     - **`medium` | `low`** → ask the user via an interactive choice. Show the recommendation, the signals, the alternatives, and offer: pick the recommendation / pick an alternative / pick any of the 16 built-in profiles / `skip` (run in null-profile / generic mode for this run only). On a profile pick, call `mcp__pp_harness__write_profile` with `source = "user-selected"`, the chosen `name`, and the run_id. On `skip`, proceed with `snapshot = null`.
     - **`none`** → no signals. Ask the user to pick a profile from `mcp__pp_harness__list_profiles` or say `skip`. On a pick, call `write_profile` with `source = "user-selected"`. On `skip`, proceed with `snapshot = null`.
   - **Non-interactive runs** (CI, scripted, no human in the loop): if `confidence` is `high`, auto-write as above; if `confidence` is anything else, fail the run with this exact error: `"[pp] no <project>/.harness/profile.yaml and detection confidence is <confidence>. Bootstrap once interactively (run /pp:run from a TTY) or commit a profile.yaml. Detected: <recommendation>. Signals: <signals>. Alternatives: <alternatives>."` Do not silently fall back to generic mode.

   Capture the final snapshot (or `null` after explicit `skip`) for later steps. `null` = generic mode.

3. **Start the run.** Call `mcp__pp_harness__start_run` with `request_text`, `project_path = cwd`, `mode` (`single` | `best_of` | `team` | `review`), and any `team`/`forum`/`n` set by the calling command. The daemon also persists the profile snapshot internally (loaded at run start) so replay is faithful regardless of whether the driver passed it. Capture `run_id` and `artifact_dir`.

4. **Taxonomy mapping.** Use the Task tool to invoke the `taxonomy-mapper` agent. It returns `{ scope, signals, sections: [{id, title, rationale, required_artifacts}], missability_required }`. Persist via `mcp__pp_harness__record_taxonomy_mapping`.

5. **Stage loop.** For each stage in dependency order (default by triage class — see `artifact-conventions.md`):
   - Call `mcp__pp_harness__start_stage` with `kind` and `gate_type`. Capture `stage_id`.
   - Call `mcp__pp_harness__gate_eligible_judges` with `gate_type`, `generator_producer`, `generator_model` when known, `prompt_keywords` (the user's request), the `profile.name` if any, and `artifact_kind` if known. If `generator_model` is omitted, the daemon infers Codex/agy defaults where possible. It returns `{ required_cross_vendor, base_tier, upgraded, rubric_id, allowed_judges }`.
   - Use the Task tool to invoke the generator agent (`engineer`, `spec-author`, `architect`, `designer`, etc., per the team yaml or default). The agent calls `mcp__pp_codex__generate` (or agy, per binding), archives the result via `mcp__pp_harness__archive_artifact`, and records the attempt via `mcp__pp_harness__record_attempt`.
   - Use the Task tool to invoke `judge-router`. Capture its route object: `{ judge_agent, preferred_producers, rubric_id, decision_reason }`.
   - Then use the Task tool to invoke the chosen judge agent (`judge-cross-vendor` or `judge-same-vendor`) with the attempt / artifact context plus `rubric_id` (or `rubric_md` if already resolved). That judge agent fetches the rubric if needed, runs the critique tool, and records the verdict via `mcp__pp_harness__record_verdict`.
   - **If the judge sub-agent returns `judge_tool_failed=true`** (instead of a verdict): the judge's underlying CLI failed persistently even after the agent's retry-once. Do NOT invoke Reflexion (Reflexion is for a generator that produced a flawed artifact; this is an environment failure on the *judge* side). Archive the failure context to `<artifact_dir>/critique_failures/<stage_id>.json` (write the full `{ judge_tool_failed, reason, vendor, model, exit_code, stderr_tail, attempts, failure_archive_path }` payload via `mcp__pp_harness__archive_artifact` with `kind: "critique_failure"`). Then call `mcp__pp_harness__finalize_stage(status="surfaced")` and `mcp__pp_harness__finalize_run(status="aborted", summary_md=<judge tool failure context, including the failure_archive_path so the user can find the stderr>)`. STOP. Do NOT advance to the next stage. Tell the user the judge bridge is broken and point at `failure_archive_path`. **Never fabricate a passing verdict to "unblock" the pipeline** — halting is correct.
   - On `outcome=fail` (or `revise`): use the Task tool to invoke `reflexion-coach`. The coach calls `mcp__pp_harness__retry_with_critique` to verify the ×1 invariant and the loop ceiling, then returns `{ ok, parent_attempt_id, retry_prompt }`. The **driver** — not the coach — must re-invoke the generator with `retry_prompt`, record the retry attempt with `retry_index=1` and `parent_attempt_id`, then re-run the judge. Do not treat the coach's narrative output as proof that the retry occurred; verify the daemon ledger now contains the retry attempt and its new verdict before advancing. The daemon rejects the third generator call automatically.
   - After any judge `pass` (initial or retry), call `mcp__pp_harness__get_stage_finalize_readiness(stage_id)` **before** attempting `finalize_stage(status="passed")`.
     - If it returns `next_action="run_tdd_pre_check" | "run_tdd_post_check" | "run_artifact_validate"`, call that tool immediately, then re-call `get_stage_finalize_readiness(stage_id)`.
     - If readiness now returns `can_pass=true`, call `mcp__pp_harness__finalize_stage(status="passed", winner_attempt_id=…)` and continue.
     - If readiness returns `next_action="retry_or_surface"`, treat the first blocker `message` as the critique and enter the same Reflexion ×1 flow as a failing verdict. If the retry slot is already spent, or the retry still does not produce `can_pass=true`, finalize the stage as `surfaced` and BREAK.
     - If readiness returns `next_action="surface_stage"`, or it still cannot pass after the required gate tool was run, `mcp__pp_harness__finalize_stage(status="surfaced")` and BREAK.
     - If readiness returns `next_action="dispatch_cross_vendor_rejudge"` (PP-VG-6 hallucination, or PP-VG-4 findings-closure), do NOT surface yet and do NOT invoke Reflexion — what is in question is the *verdict*, not the artifact. Read the blocker's `attempt_id` and confirm it belongs to this stage. The blocker `message` names the suspect verdict's `judge_producer`; the clearing verdict must come from a DIFFERENT judge vendor (the daemon enforces `judge_producer != <suspect>`, so a re-judge by the same vendor cannot clear the flag). Call `gate_eligible_judges`, pick a vendor differing from BOTH the attempt's producer and the suspect judge, and invoke `judge-cross-vendor` against that attempt. Bound this to ONE rejudge per stage — a budget separate from the Reflexion ×1 slot — then re-call `get_stage_finalize_readiness` and branch on the newly returned action. If no independent vendor exists, or the second occurrence fires, `finalize_stage(status="surfaced")` and BREAK.
     - **Unknown `next_action` fallback.** Any `next_action` not handled above → `finalize_stage(status="surfaced")` and BREAK, printing the blocker `message`. Never treat an unrecognized action as permission to pass, and never fall through silently.
   - Do **not** call `finalize_stage(status="passed")` speculatively and wait for a `TddGateViolation` / `ValidatorGateViolation` exception to tell you what branch you should have taken. That exception path is defense-in-depth, not the normal control flow.

6. **Missability.** Use the Task tool to invoke `missability-inspector`. It calls `mcp__pp_harness__run_missability_checks(run_id)` (passing any `missability_required` from step 4 as `required_check_ids`). Any `fail` → `mcp__pp_harness__finalize_run(status="surfaced", summary_md=…)`, report to user, STOP.

7. **Master-plan patch.** Use the Task tool to invoke `master-plan-patcher`. It reads `PROJECT_MASTER.md` (calling `mcp__pp_harness__ensure_master_plan` first), maps each artifact's taxonomy section to a master-plan section, and calls `mcp__pp_harness__apply_master_plan_patch` per section.

8. **Finalize.** Use the Task tool to invoke `run-finalizer`. It writes `run.summary.md`, archives any losers (best-of-N), and calls `mcp__pp_harness__finalize_run(status="complete", summary_md=…)`.

9. **Report to the user.** Show:
   - Artifact paths under `<project>/.harness/<run_id>/`.
   - Verdict outcomes (and rubric ids).
   - Total tokens / cost via `mcp__pp_harness__budget_status` with `scope="run:<run_id>"`.
   - Master-plan delta (which sections were patched).
   - One-paragraph summary of what changed.

## Invariants you MUST uphold

- **Every artifact written to disk goes through `mcp__pp_harness__archive_artifact`.** The daemon scans for secrets, computes the sha256, and refuses to overwrite a file that has been manually edited since the last archive (returns `manual_edit_detected` unless `force_overwrite=true`).
- **Generator and judge MUST use different model ids and — when the gate requires it — different vendors.** Always call `gate_eligible_judges` first; honor `required_cross_vendor=true`. Judge models come from the per-vendor policy object `JUDGE_MODEL_POLICY` (`daemon/src/config.ts`), not from a single hard pin: each vendor has a JUDGE-1 default (`gpt-5.6-terra` / `gemini-3.8-flash-medium`), an escalated lane selected by `escalate: true` (`gpt-5.6-sol` / `gemini-3.1-pro-high`), and an allow-list an operator may override into under JUDGE-1a. A non-allow-listed id throws at the bridge. Same-producer + same-model verdicts are rejected for **every** producer, so if the generator already ran the vendor's default critique id, judge on another allow-listed id or route cross-vendor — the default Codex generator pin is `gpt-5.6-luna`, so the ordinary Codex→Codex same-vendor route is legal.
- **Reflexion is ×1 only.** `retry_with_critique` enforces this server-side; the third call is rejected. Surface the run instead of looping.
- **Loop ceiling is enforced.** Default 6 validator calls per run; exceeding it blocks further `retry_with_critique` calls. Override only with explicit user consent (`budget_override=true`) and a documented reason.
- **Run flows are user-explicit only.** Do not start a `/pp:run` flow from a regular conversational request; the user must invoke a `/pp:*` slash command.
- **All harness MCP calls are write-once per logical event.** Don't re-call `record_attempt` for the same attempt; for retries, create a new attempt with `parent_attempt_id` set and `retry_index=1`.
- **`get_stage_finalize_readiness` is the preflight; `finalize_stage` is the commit.** Always consult readiness first when you intend to finalize a stage as `passed`. The daemon exception path is a guardrail, not your branching primitive.

## When something goes wrong

- MCP call errors → print verbatim, then `mcp__pp_harness__finalize_run(status="aborted")`.
- Cross-vendor required but vendor matrix incomplete → STOP and tell the user to set `OPENAI_API_KEY` + `GEMINI_API_KEY` (or run the relevant CLI auth) and retry.
- Loop ceiling reached → finalize as `surfaced`; do not pretend the run completed.
- Missability fail → finalize as `surfaced` with the evidence path; the run is incomplete by design.
- Judge tool failed (`judge_tool_failed=true` from the judge sub-agent) → archive the failure context to `<artifact_dir>/critique_failures/<stage_id>.json`, finalize the stage as `surfaced` and the run as `aborted` with the failure context in `summary_md`, STOP. Do NOT invoke Reflexion. Do NOT fabricate a verdict. The user must fix the bridge (model id, auth, network, command-line length) and re-run.
- **`ToolSearch` returns zero matches for an `mcp__pp_*__*` tool you expected to find.** This is **expected** — the tool belongs to the sub-agent that owns this step. Delegate via `Task` to the responsible agent (per the lifecycle step) and let the agent call the tool. Never interpret ToolSearch silence as "MCP server unbound", and never propose `PP_ALLOW_AD_HOC=1` or `/mcp` reconnect without hard evidence (a real exit-1 from a tool call on the daemon side).
- **A sub-agent returns a result that *says* it succeeded, but the daemon has no record** (e.g., the verdict isn't in `get_run`, the artifact isn't in `archive_artifact`'s registry, the patch doesn't show in `master_plan_status`). Treat this as a sub-agent-contract violation equivalent to `judge_tool_failed=true`: archive the agent's narrative output to `<artifact_dir>/contract_violations/<stage_id>.json`, finalize the stage as `surfaced` and the run as `aborted`, STOP. The daemon ledger is authoritative — do NOT accept the agent's narration as proof of progress.
- **A hook blocks an edit** (`enforce-active-run`, `enforce-vendor-matrix`, `enforce-completeness`, etc.). The hook is doing its job. Diagnose: which run should own this edit? Is the edit in the right project? If no run owns the edit and you are in a consuming project (not the harness's own tree), the edit belongs inside an active `/pp:run` lifecycle — not in a workaround. Finalize as `aborted` with the hook message in the summary; do NOT propose `PP_ALLOW_AD_HOC=1` to the user under any circumstance. (Edits to the harness's own working tree at `<repo-root>\` are exempt from this rule and are handled directly by Claude Code outside any `/pp:*` lifecycle.)
- **A sub-agent returns `tools_missing`** (because its frontmatter `tools:` list is incomplete or its `Task` instantiation didn't expose a required tool). Surface the failure to the user verbatim, finalize the run as `aborted`, and flag the agent definition as needing repair. Do NOT retry the agent with a stripped-down workflow that bypasses the missing tool.
