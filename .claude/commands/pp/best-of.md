---
description: Run a coding request with N parallel Claude candidates (different model/seed mix). The judge picks a winner via Borda count when N≥3; the winner's worktree is committed and merged back to the project tree, and losers are archived.
argument-hint: <N> <free-text request>
---

You are about to drive a `/pp:best-of` invocation. Follow the `pair-programmer` skill protocol exactly. Parse `$ARGUMENTS` as `N` (integer in [2, 8]) followed by the free-text request.

**Tier flags are not honored here.** If `$ARGUMENTS` contains `--tier-cap=`, `--tier-floor=`, or `--no-tier-policy`, STOP immediately and print: "best-of-N uses a fixed Sonnet+Opus rotation per candidate slot (see step 6 below). The tier-policy flags from /pp:run / /pp:team are intentionally not applied — ensemble diversity is the whole point. Re-run without the flag, or use /pp:run if you want tier control." Do NOT silently ignore the flags — that would mask a misuse.

## Lifecycle

1. **Triage + profile snapshot** — same as `/pp:run`. Best-of-N is heavy; if triage returns `trivial`, suggest `/pp:run` instead.

2. **Start run.** `mcp__pp_harness__start_run(mode="best_of", n=N, request_text=<rest>, project_path=<cwd>)`.

3. **Taxonomy mapping** — same as `/pp:run`.

4. **Open the best-of stage.** `mcp__pp_harness__start_best_of_stage(run_id, kind="code", gate_type="code_style", n=N)`. Returns `{stage_id, candidates: [{candidate_index, attempt_slot_id, worktree_path, worktree_mode}, ...]}`. The daemon refuses to open the stage unless at least one non-Claude vendor (codex OR agy) is reachable, since judges need cross-vendor capability when all candidates are Claude.

5. **Pre-judge gate decision.** `mcp__pp_harness__gate_eligible_judges` with the request keywords + profile. Capture rubric_id + cross_vendor.

6. **Fan out IN PARALLEL — all candidates run as Claude.** In a SINGLE message, invoke the Task tool N times with the `engineer` sub-agent. All candidates are pinned to `producer="claude"`; only the model/seed varies for diversity:
   - candidate 1: `producer="claude"`, `model="claude-sonnet-5"`, `seed="primary"`
   - candidate 2: `producer="claude"`, `model="claude-opus-5"`, `seed="primary"`
   - candidate 3: `producer="claude"`, `model="claude-sonnet-5"`, `seed="devils-advocate"`
   - if N>3: cycle adding `claude-opus-5` with `seed="terse-diff"`, `claude-sonnet-5` with `seed="failing-test-first"`, etc.
   Pass `cwd=<worktree_path[i]>` and `attempt_slot_id` from the per-candidate slot. **Also pass `profile.runtime_smoke_test`** if the active profile sets it — the engineer reads this to decide whether to run the dev-server smoke test before committing. Each engineer authors files DIRECTLY into its worktree using its native Write/Edit/Bash tools (see engineer.md), runs the verification step (3.5) on UI projects, then `git add -A && git commit -m "<msg>"` inside the worktree before returning. The harness will auto-commit if the engineer forgets, but explicit is preferred.

   Codex and Antigravity (agy) do NOT generate candidates. Their CLIs are reserved for the judge stage (step 8) when cross-vendor is required.

6.5. **Collect smoke results.** After all N engineer Tasks return, build a smoke summary from each Task's return payload:
   `smoke_summary = { candidate_index → { smoke_status, smoke_reason } }`.
   The engineers should already have called `record_smoke_status` (the daemon's authoritative record). Sanity check: if any candidate's payload is missing `smoke_status`, call `mcp__pp_harness__record_smoke_status({stage_id, candidate_index, status: "infra_error", reason: "engineer_did_not_report"})` yourself as a fallback so the gate has a value to read.

   **Do NOT include smoke status in the judge prompt (step 8).** The judge ranks on the rubric blind to runtime outcomes — leaking smoke status biases ranking on a dimension the rubric wasn't written for. The smoke gate runs as a post-filter (step 9.5) after the judge has ranked.

7. **Diff entropy.** Collect the N artifact texts (read from each worktree). `mcp__pp_harness__diff_entropy(candidate_texts=[…])`. If `warning` is non-null, capture it for the user-facing summary.

8. **Judge routing.** Use the Task tool to invoke `judge-router`. Since every candidate has `producer="claude"`, cross-vendor gates should route to `judge-cross-vendor`; same-vendor gates should route to `judge-same-vendor`. Capture `{ judge_agent, preferred_producers, rubric_id, decision_reason }`.

9. **Judge execution + verdicts.** Invoke the chosen judge agent on the candidate artifacts in the daemon-randomized order. The chosen judge agent records one `record_verdict` per attempt; store the routed `rubric_id` on every verdict. For N≥3, optionally route to a second judge (the OTHER eligible judge lane) and call `mcp__pp_harness__borda_count` with both rankings.

9.5. **Smoke post-filter.** Read `smoke_summary` from step 6.5 and apply this rule before picking the winner:
   - If the rubric/Borda winner has `smoke_status="fail"`, walk the ranking in order (rank 1, 2, 3, …) and pick the FIRST candidate with `smoke_status` ∈ {`pass`, `skipped`}.
   - `infra_error` is treated as `skipped` for ranking — don't punish a candidate when `npm install` failed for network reasons. Flag it in the report (step 14) so the user knows to investigate.
   - If NO candidate has a clean smoke status (all `fail` or all `infra_error` with at least one `fail`), force `final_status="surfaced"` and skip the merge. The user gets all N losers archived but no winner merged.
   - If the rubric-winner was overridden, log it for the report: `"winner overridden by smoke gate: rubric-winner=c<N> (smoke_fail: <reason>) → smoke-corrected-winner=c<M>"`.

10. **Archive winner & losers.** `mcp__pp_harness__archive_winner_and_losers(run_id, stage_id, stage_kind="code", winner_candidate_index=<>, candidate_paths=[…])`. The daemon now (a) checks the winner's runtime-smoke status and refuses to merge if `status="fail"` (returns `merge_status="smoke_failed"` with `smoke_failed_reason`; override with `PP_ALLOW_SMOKE_FAILED_WINNER=1`), (b) auto-commits any uncommitted candidate-branch changes before diffing, (c) refuses to write a 0-byte `winner.diff` and surfaces `merge_status="empty"` when the candidate produced no committed changes, (d) attempts `git merge --no-ff <branch>`. If the response carries `merge_status="conflict"`, `merge_status="empty"`, or `merge_status="smoke_failed"`, override `final_status="surfaced"` and surface the cause.

    Note: step 9.5 should already have prevented `merge_status="smoke_failed"` here by picking a clean winner. The daemon's check is defense-in-depth — if the driver instructions are bypassed (e.g., a future LLM skips step 9.5), the daemon still refuses the merge.

11. **Teardown.** `mcp__pp_harness__teardown_candidates(project_path=<cwd>, candidate_paths=[…], run_id, stage_kind="code")`. Before destroying each worktree the daemon copies any DB-registered artifact whose path lives inside that worktree to `.harness/<run_id>/<kind>/preserved/candidate-<N>/<rest>` and rewrites the `artifacts.path` accordingly. If preservation fails the worktree is left in place and `teardown_status="preserve_failed"` is returned — surface the run rather than retrying. To accept data loss explicitly, pass `allow_data_loss=true`.

12. **Finalize stage.** `finalize_stage(stage_id, status="passed", winner_attempt_id=<winner attempt id>)` (or `surfaced` on merge conflict, empty diff, or failed preservation).

13. **Missability + master-plan + finalize.** Same as `/pp:run` steps 7–9. Reflexion ×1 applies only to the winner. **Trigger Reflexion when the winner has `smoke_status="fail"`** — construct the critique from `smoke_reason` (the matched fail pattern + first 30 stderr lines) and feed it to the engineer for a single retry. Reflexion does NOT trigger on `smoke_status="infra_error"` (that's an environment problem, not a code crash, so the retry won't help).

14. **Report.** Show:
   - Winning candidate (index, model, seed, attempt id) and its critique.
   - All N attempts with rubric scores so the user can see what was rejected.
   - **Runtime smoke** column for every candidate: ✓ pass / ✗ fail (reason) / ⚠ infra-error / ⊘ skipped. If any candidate failed, surface the matched fail pattern verbatim.
   - If the rubric-winner was overridden by the smoke gate (step 9.5), call it out explicitly: `"winner overridden by smoke gate: rubric-winner=c<N> (smoke_fail: <pattern>) → smoke-corrected-winner=c<M>"`.
   - Path to `winner.diff` (or `winner.tree/` for non-git fallback).
   - Diff-entropy warning if any.
   - Merge status (`merged` / `conflict` / `empty` / `copy` / `smoke_failed`).
   - Teardown status and any preserved paths.
   - Total tokens / cost; master-plan delta; missability tally.

## Archive-path rules

`archive_artifact` is for run-level metadata only — files OUTSIDE any candidate worktree. Legal: `run.summary.md`, `INDEX.md`, `code/winner.diff`. ILLEGAL (the daemon will reject): anything matching `code/candidate-<N>/...` while the stage is open. The candidate's deliverable IS the worktree contents, delivered via git merge in step 10.
