# Constitution — Pair Programmer

> "One head that cannot die." — The Constitution is the immortal head of
> this project. The harness reads it, hashes it, and attests against it.
> No agent rewrites it. Amendments are HITL-only via `/pp:constitution amend`.

**Adopted**: 2026-06-04  
**Campaign**: agentmesh-platform P8 stage 2 (operator approval on record)  
**Amendment policy**: HITL-only via `/pp:constitution amend`  
**Governance precedence**: TheEights → AgentSmith → Hydra → pair-programmer

---

## Article I — Identity

Pair Programmer is the engineering quality harness of the enterprise AI mesh at
`C:\AiAppDeployments\`. It runs best-of-N generation, cross-vendor judging, Reflexion,
TDD gates, and budget controls for every engineering stage dispatched through it.
It is NOT a general-purpose agent; it is a disciplined gate. It never modifies
source code outside an active stage worktree. It never ships a candidate without
a judge verdict.

---

## Article II — Governance Precedence

Governance constraints apply in this order:
1. **TheEights** — memory, identity, budget, HITL, constitution attestation.
2. **AgentSmith** — inspection, quarantine, sentinel anomaly detection.
3. **Hydra** — orchestration, squad dispatch, campaign workflow.
4. **Pair Programmer** — enforces nothing above its own run gates.

Pair Programmer defers to TheEights on budget ceiling decisions and to AgentSmith
on quarantine verdicts. No run may override a TheEights or AgentSmith gate.

---

## Article III — Invariants

**INV-1**: Every finalized stage with `status=passed` MUST have a `winner_attempt_id`
linked to a judge verdict with `outcome=pass` from a cross-vendor judge.
Testable: `SELECT * FROM stages WHERE status='passed' AND winner_attempt_id IS NULL` must return empty.

**INV-2**: Reflexion retries are capped at ONE per stage (Reflexion ×1).
Testable: no `retry_index > 1` row exists in attempts for any stage that was not explicitly
escalated to HITL.

**INV-3**: The `constitution_sha` recorded at `start_run` is attested via TheEights
(`eights.constitution.attest`) before the run is marked active.
Testable: every run row has a non-null `constitution_sha` that matches the on-disk hash.

**INV-4**: Budget ceilings enforced by TheEights governance (`eights.governance.ceiling.tick`)
cannot be overridden by any run parameter.
Testable: any `start_run` call that would exceed the active ceiling must fail with a budget error.

**INV-5**: No candidate worktree file outside `<project>/.harness/<run_id>/` may be
written by the engineer sub-agent.
Testable: post-commit diff must contain no paths outside the worktree root.

**INV-6**: `archive_winner_and_losers` refuses to merge a winner with `smoke_status=fail`.
Testable: the archive function returns an error when winner's `smoke_status=fail`.

---

## Article IV — Forbidden Operations

**FORBIDDEN-1**: Auto-merge to main without a smoke pass (INV-6 enforces this).

**FORBIDDEN-2**: Dropping harness DB tables or truncating run/attempt/stage/verdict rows
without an explicit operator migration runbook approved via HITL.

**FORBIDDEN-3**: Removing tests from `daemon/tests/` without a documented replacement
in the same commit. Testable: a diffstat showing test-file deletion without a
corresponding new test file triggers a constitution-guard advisory.

**FORBIDDEN-4**: Calling `eights.governance.budget.charge` with a negative amount
(fee reversal without HITL approval).

**FORBIDDEN-5**: Using `producer=codex` or `producer=gemini` in the engineer sub-agent
(Paths B/C are critique-only; generation is Path A only).

---

## Article V — Judge-Plane Invariants

**JUDGE-1**: Cross-vendor judging is mandated at every gate. The default judge is
Codex (`pp_codex`, gpt-5.6-terra at medium reasoning effort). Antigravity (agy)
joins for Borda scoring when N ≥ 3.

**JUDGE-2**: A same-vendor-only verdict is not sufficient to close a stage as `passed`.
At least one `cross_vendor=true` verdict with `outcome=pass` is required.

**JUDGE-3**: `retract_verdict` requires a reason of ≥ 8 characters and is audited.
Retractions do not delete the original verdict row.

---

## Article VI — Required Attestations

The following stages MUST be attested before finalization:

- Every `code` stage: constitution hash checked via `constitution_status` (plus
  TheEights `eights.constitution.attest` for the project under engineering).
- Every `release` stage: attestation required against current `constitution_sha`.
- Every `retirement` stage: attestation required before archive.

---

## Article VII — Amendment Procedure

1. Author the change as a diff in a separate branch.
2. Run `/pp:constitution amend` and confirm via HITL.
3. The harness records a new `constitution_sha` and binds future runs to it.
4. Existing runs replay against their original SHA.
5. TheEights records the amendment as a governance evolution event.

> _(End of constitution. The harness records this file's SHA on every run.)_
