---
name: "pp:evolution"
description: List, review, or trigger pp's autogenesis evolution proposals (T4 — self-evolving rubrics/teams/profiles).
argument-hint: [list|review <id> <approve|reject>|propose <run_id>]
---

<!-- Generated from .claude\commands\pp\evolution.md. Edit the .claude source file and rerun node scripts/sync-copilot-assets.mjs. -->

The autogenesis-analyzer sweeps for recurring drift patterns at every `finalize_run` — a rubric flagging the same artifact kind ≥3 times, a stage surfacing ≥2 times, a missability check failing ≥3 times. When a pattern is detected, it lands in the local `evolution_proposals` table AND (when TheEights is reachable) gets posted to TheEights' evolution queue for cross-system propagation.

This command surfaces and curates the queue. **Approved low-risk proposals get auto-committed by TheEights' PpWriteBridge to a `theeights/auto/pp-<resource>-<version>` side-branch — pp itself never edits its own `.claude/*` files.**

## Behavior

If `$ARGUMENTS` is empty or `list`:
- Call `mcp__pp_harness__list_evolution_proposals` with `project_path` set to cwd and `status=pending`.
- Render a table: id, resource_rid, pattern (decoded from proposed_change JSON), signal_count, risk_class, age.
- If empty, tell the user "no pending evolution proposals — pp hasn't detected recurring drift in this project yet."
- Mention `/pp:evolution list approved` / `rejected` / `committed` for status filtering.

If `$ARGUMENTS` matches `list <status>`:
- Same as above but with the requested status filter.

If `$ARGUMENTS` matches `review <proposal_id> <approve|reject>`:
- Show the full proposal (justification, signal_count, risk_class).
- Confirm with the user via `AskUserQuestion` before dispatching. **Never approve high-risk proposals (rubric_id in {owasp-*, wcag-*, slsa-*, nist-*}) without explicit textual confirmation** — these are standards-aligned rubrics and changes have legal/compliance implications.
- Call `mcp__pp_harness__review_evolution_proposal({proposal_id, decision})`.
- Report `updated` and `eights_dispatched`. Tell the user that on approval, TheEights' PpWriteBridge will commit to a side-branch they can `git fetch` and review.

If `$ARGUMENTS` matches `propose <run_id>`:
- Manually trigger the analyzer for a run (otherwise it auto-fires on finalize). Useful when an operator says "I just saw the same critique three times — what does the analyzer think?"
- Call `mcp__pp_harness__analyze_autogenesis({run_id, project_path})`.
- Render the returned proposals.

If `$ARGUMENTS` is anything else, treat as `list`.

## Read this before approving anything

The analyzer detects *recurrence*, not *correctness*. A rubric flagging an artifact 3 times might mean the rubric is too tight — OR it might mean the code really does have 3 instances of the problem. Treat the proposal as a *prompt to investigate*, not a directive. Review each instance before approving the evolution.
