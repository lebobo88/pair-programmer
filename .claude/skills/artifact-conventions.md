---
name: artifact-conventions
description: File layout under `<project>/.harness/<run_id>/` and the kinds of artifacts produced by each stage. Loaded on demand by the `pair-programmer` skill. Every file written under .harness/ MUST go through `mcp__pp_harness__archive_artifact` UNLESS it lives inside an active best-of-N candidate worktree (those files are tracked via git inside the worktree, not via the artifacts table).
---

# Artifact conventions

Every run owns a directory at `<project>/.harness/<run_id>/`. The driver does not create files in this directory directly — every file is written via `mcp__pp_harness__archive_artifact`, which:

1. Scans the bytes for secrets (regex over common API-key patterns) and refuses on match.
2. **Refuses paths that resolve inside an active best-of-N candidate worktree** (post-2026-05-05 data-loss safeguard). Those files belong to the candidate's git branch, not the artifacts table — they reach the project tree via `git merge` in `archive_winner_and_losers`, not via `archive_artifact`.
3. Computes the sha256, registers it in the `artifacts` table.
4. Refuses to overwrite a file that has been manually edited since the last archive (returns `manual_edit_detected` unless `force_overwrite=true` is passed).

## Standard layout

```
<run_id>/
  request.md                    # the user's request, written by start_run
  taxonomy_mapping.json         # the mapping from record_taxonomy_mapping
  profile_snapshot.yaml         # the active profile (or "none" if generic)
  spec/                         # PRD, acceptance criteria, NFRs (4.3)
  architecture/                 # ADRs, C4 sketches (4.6)
  contracts/                    # OpenAPI / AsyncAPI / SDK ergonomics (4.7)
  ux/                           # IA, flows, screen-state matrix, content guide, a11y plan (4.4)
  design-system/                # tokens, component specs, component-preview screenshots (4.4)
  visual-regression/            # before/after PNGs and diff report (web-ui profile)
  data/                         # ERD, lineage, retention, migration (4.5)
  security/                     # threat model, control mapping (4.9)
  code/                         # unified diffs / self-contained new files (single-mode);
                                # winner.diff + losers/ (best-of-N);
                                # candidate-{1..N}/ (best-of-N, ephemeral worktrees — NOT archived);
                                # preserved/candidate-N/ (best-of-N, populated by teardown when artifacts were registered inside a worktree)
  tests/                        # test plan + contract tests (4.10)
  docs/                         # changelog, release notes, runbook (4.13)
  release-plan/                 # rollout, rollback, comms (4.11)
  ops/                          # SLOs, runbooks, alerts, telemetry (4.12)
  governance/                   # RACI, decision log, review forums (4.14)
  ai-controls/                  # AI system spec, evals, tool perms, HITL (4.15)
  retirement/                   # EOL plan, sunset comms (4.16)
  losers/                       # alias used in run summaries; canonical location is code/losers/candidate-N/
  review-<forum>/               # /pp:review writes its outputs here (e.g. review-threat/)
  missability_checks.json       # results of run_missability_checks
  master_plan_patches.json      # patches written into PROJECT_MASTER.md by run-finalizer
  run.summary.md                # one-paragraph summary written by run-finalizer
  run.json                      # machine-readable summary (run + stages + artifacts)
```

## Filename conventions

Inside each stage directory:
- First attempt: `attempt-1.<ext>` (e.g. `attempt-1.md`, `attempt-1.diff`).
- Reflexion retry: `attempt-2.<ext>`.
- Best-of-N candidate worktrees: `candidate-{1..N}/` — these are GIT WORKTREES, not archived files. The engineer commits inside them; the daemon merges the winner back to the project root via `archive_winner_and_losers`. Do NOT archive paths inside these directories.
- Winner archive (best-of-N): `winner.diff` plus `winner.tree/` if the project is non-git.
- Loser archive (best-of-N): `losers/candidate-N/<full tree copy>`.
- Preserved files (best-of-N teardown safeguard): `preserved/candidate-N/<rest>` — populated when an engineer mistakenly registered an artifact inside a candidate worktree; teardown copies it here BEFORE removing the worktree.

## What to pass `archive_artifact`

```jsonc
{
  "run_id":           "run_xxx",
  "stage_id":         "stage_yyy",
  "taxonomy_section": "4.3",            // critical for master-plan routing
  "kind":             "prd",            // canonical artifact kind from the table in taxonomy-adherence.md
  "relative_path":    "spec/attempt-1.md",
  "bytes":            "<utf-8 text>"
}
```

The response contains `artifact_id`, `absolute_path`, and `sha256`. If the response is `{ status: "manual_edit_detected", stored_sha, current_sha, path }`, the user has edited the file since the last archive — surface the conflict and ask whether to merge or `force_overwrite`.

If the response is an `ArchiveArtifactPathError`, you tried to archive into a candidate worktree. Re-read this skill's "what to pass" section: candidate worktree contents are delivered via git merge, not via `archive_artifact`.

### Legal vs rejected paths during a best-of-N stage

| relative_path | Legal? |
|---|---|
| `run.summary.md` | yes |
| `INDEX.md` | yes |
| `code/winner.diff` | yes (written by archive_winner_and_losers) |
| `code/losers/candidate-2/foo.json` | yes (written by archive_winner_and_losers) |
| `code/preserved/candidate-1/lib/x.ts` | yes (written by teardown safeguard) |
| `spec/attempt-1.md` | yes |
| `code/candidate-3/package.json` | **NO — rejected** while the stage is open. The engineer must commit this file inside the candidate-3 worktree; the merge will deliver it to the project root. |
| `code/candidate-1/src/foo.ts` | **NO — rejected** while the stage is open. |

## Reading existing artifacts

For a Reflexion retry or a follow-up stage, the agent reads previously-archived artifacts directly from disk (relative path is in the `artifacts` table). It does NOT re-archive on read.

## Trivial-task minimum

Trivial scope = changelog only. The agent writes `docs/CHANGELOG.md` (append-mode if present) and skips the rest. Missability is still run but most checks return `n/a`.
