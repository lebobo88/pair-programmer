# Judge-Route Model Parity — Verification Report

**Date:** 2026-09-03
**Branch:** `feat/judge-model-parity` (base `fable-audit-2`, merge base `4adf25d`)
**Milestone:** `judge-model-parity` (issues #25–#37)
**Issue:** #37 (J13) — unit test suite for judge parity
**Constitution:** Article V as amended, SHA `5df284cb` (supersedes `13b4fa18`), HITL-confirmed 2026-09-03

This report records the full verification sweep that gates the branch: a clean
build, every `*.unit.mjs` in `daemon/test`, the self-hosted smoke suite, a
registration audit of `daemon/package.json`, and a live read-only `doctor` run.

---

## 1. Build

```
cd daemon && npm run build      # tsc, no emit errors
```

| Step | Result |
| --- | --- |
| `npm run build` (tsc) | clean, exit 0 |

---

## 2. Unit sweep

Every file was run individually so the table reports true per-file counts:

```
cd daemon
for f in test/*.unit.mjs; do node --test --test-timeout=300000 "$f"; done
```

Files that report `pass 1` are plain assertion scripts: under `node --test` the
whole file counts as a single top-level test. Files that report a larger number
use `node:test` subtests.

| File | pass | fail |
| --- | ---: | ---: |
| ack-run.unit.mjs | 1 | 0 |
| agents-md.unit.mjs | 1 | 0 |
| agy-disable.unit.mjs | 11 | 0 |
| agy-escalation.unit.mjs | 1 | 0 |
| agy-model-id-classification.unit.mjs | 13 | 0 |
| agy-model-resolve.unit.mjs | 1 | 0 |
| agy-pin.unit.mjs | 15 | 0 |
| artifact-validators.unit.mjs | 1 | 0 |
| cli-stdout-classification.unit.mjs | 24 | 0 |
| codex-escalation.unit.mjs | 1 | 0 |
| codex-preamble-extraction.unit.mjs | 13 | 0 |
| codex-worktree.unit.mjs | 1 | 0 |
| copilot-fallback-runtime.unit.mjs | 2 | 0 |
| doctor-pin-freshness.unit.mjs | 11 | 0 |
| ecosystem.unit.mjs | 1 | 0 |
| fable-tier.unit.mjs | 1 | 0 |
| finalize-gates-a.unit.mjs | 1 | 0 |
| finalize-gates-b.unit.mjs | 28 | 0 |
| finalize-gates-c.unit.mjs | 27 | 0 |
| findings-provenance.unit.mjs | 1 | 0 |
| force-unlock-staleness.unit.mjs | 6 | 0 |
| gate-every-cross-vendor.unit.mjs | 30 | 0 |
| hydra-context-block.unit.mjs | 3 | 0 |
| janitor-attended-skip.unit.mjs | 1 | 0 |
| janitor-scoped-prune-gitdir.unit.mjs | 2 | 0 |
| janitor-scoped-prune.unit.mjs | 1 | 0 |
| judge-capabilities.unit.mjs | 9 | 0 |
| judge-model-allowlist.unit.mjs | 1 | 0 |
| judge-provenance-replay.unit.mjs | 1 | 0 |
| missability-evidence-ref.unit.mjs | 1 | 0 |
| missability.unit.mjs | 1 | 0 |
| producer-validation.unit.mjs | 15 | 0 |
| rejudge-gate.unit.mjs | 1 | 0 |
| retract-verdict.unit.mjs | 1 | 0 |
| retry-and-idempotency.unit.mjs | 1 | 0 |
| run-cli-flags.unit.mjs | 1 | 0 |
| sandbox-gate.unit.mjs | 1 | 0 |
| schema-v10.unit.mjs | 1 | 0 |
| shutdown.unit.mjs | 1 | 0 |
| sync-comment-injection.unit.mjs | 9 | 0 |
| sync-copilot-comments.unit.mjs | 5 | 0 |
| tail-fix-select.unit.mjs | 1 | 0 |
| tdd-gate-node-test-parser.unit.mjs | 9 | 0 |
| tdd-parser.unit.mjs | 1 | 0 |
| team-bon-policy.unit.mjs | 4 | 0 |
| team-judge-overrides.unit.mjs | 13 | 0 |
| ws7-tracked-git.unit.mjs | 58 | 0 |
| zero-verdict-gate.unit.mjs | 10 | 0 |
| **48 files** | **all green** | **0** |

### One regression found and fixed

`team-bon-policy.unit.mjs` failed on the first sweep. Cause is on this branch:
commit `7168c8e` (#32, J8) made team-yaml validation **refuse to fall through**
to another resolution scope on a malformed project-scope override — it now
throws instead of returning `null`. The test still asserted the old silent
fallthrough. Reproduction proved the direction:

| Revision | team-bon-policy.unit.mjs |
| --- | --- |
| merge base `4adf25d` | pass |
| branch HEAD before fix | fail |
| branch HEAD after fix | pass |

The assertion now uses `assert.throws` and requires the refusal to name both
the offending value and the no-fallthrough guarantee. That is the behavior #32
introduced, so the test is stricter than before, not weaker.

---

## 3. Smoke suite

```
cd daemon && node test/smoke.mjs
```

| Suite | Result | Note |
| --- | --- | --- |
| `smoke.mjs` | pass, exit 0, 58 assertions | spawns its own daemon on a temp DB |
| `eights-integration.smoke.mjs` | skipped: needs TheEights peer | asserts peer reachability; no external daemon running |
| `artifact-validators.smoke.mjs` | **fail, pre-existing** | reproduced identically at merge base |

### Pre-existing stale count literals in `smoke.mjs`

`smoke.mjs` carried four hardcoded totals that had drifted behind the
registries. All four fail identically at the merge base, so none is caused by
this branch. They blocked the suite from running to completion, so they were
corrected in this commit:

| Assertion | Literal was | Actual | Registry |
| --- | ---: | ---: | --- |
| missability check library size | 56 | 57 | `CHECK_DEFINITIONS`, 57 unique ids |
| `run_missability_checks` result rows | 56 | 57 | same |
| rubric count | 27 | 29 | `src/rubrics/registry.ts` |
| feature-team stage count | 7 | 8 | `.claude/teams/feature-team.yaml` |

`missability.ts`, `rubrics/registry.ts` and `.claude/teams/` are byte-identical
between `4adf25d` and HEAD, confirming the drift predates the branch. The 57th
missability check is `constitution-attestation`; the count grew 54 → 56 → 57
across earlier commits while the smoke literals lagged.

### Pre-existing failure left open

`artifact-validators.smoke.mjs` fails at `finalize_stage(passed) refused when
validator never called: expected rejection, got success`. The same failure
reproduces at merge base `4adf25d` in a clean scratch worktree, so it is not a
regression from this branch. `get_stage_finalize_readiness` correctly reports
`can_pass=false` with `next_action=run_artifact_validate`, but `finalize_stage`
accepts `passed` anyway — readiness and the finalize guard disagree when the
validator row is missing entirely. `artifact-validators.unit.mjs` passes. This
needs its own issue and is **not** fixed here.

---

## 4. Test registration audit

All ten unit files added on this branch are registered in the `test` script of
`daemon/package.json`:

| File | Registered |
| --- | --- |
| agy-model-resolve.unit.mjs | yes |
| agy-escalation.unit.mjs | yes |
| judge-model-allowlist.unit.mjs | yes |
| judge-provenance-replay.unit.mjs | yes |
| schema-v10.unit.mjs | yes |
| team-judge-overrides.unit.mjs | yes |
| run-cli-flags.unit.mjs | yes |
| doctor-pin-freshness.unit.mjs | yes |
| gate-every-cross-vendor.unit.mjs | yes |
| judge-capabilities.unit.mjs | yes |

Added in this commit: `team-bon-policy.unit.mjs` (unregistered, which is why
the #32 regression went unnoticed) and `copilot-fallback-runtime.unit.mjs`
(explicitly updated by #37 but never registered).

`copilot-fallback-removed.unit.mjs` is deleted (commit `3fc80c0`) and no test
file references it any more. Its judge-pin assertions are replaced by
`agy-pin.unit.mjs` and `agy-escalation.unit.mjs`, satisfying CONSTITUTION.md
FORBIDDEN-3 / AGENTS.md Hard Rule 8. The stale prose reference in the
`copilot-fallback-runtime.unit.mjs` header was updated to name the deletion and
its replacements.

Seventeen further pre-existing unit files remain unregistered in the `test`
script (`ack-run`, `agy-disable`, `agy-model-id-classification`,
`cli-stdout-classification`, `codex-preamble-extraction`, `codex-worktree`,
`janitor-attended-skip`, `janitor-scoped-prune-gitdir`, `janitor-scoped-prune`,
`missability-evidence-ref`, `producer-validation`, `rejudge-gate`,
`retract-verdict`, `sync-comment-injection`, `sync-copilot-comments`,
`tail-fix-select`, `ws7-tracked-git`). All pass. Registering them is left as a
follow-up rather than reshaping the script beyond this milestone's scope.

---

## 5. Live doctor check

```
cd daemon && node dist/index.js doctor
```

Read-only, no `--smoke`, so neither critique smoke test ran.

| Field | Value |
| --- | --- |
| `agy_pin_served` | `true` |
| `per_pin.critique_default` | `true` (`gemini-3.8-flash-medium`) |
| `per_pin.critique_escalated` | `true` (`gemini-3.1-pro-high`) |
| `per_pin.generate` | `true` (`gemini-3.8-flash-medium`) |
| `agy_pin_check.unserved_allowlist` | `[]` |
| `codex_pin_served` | `null` (expected: needs the critique smoke test) |
| `codex_pin_check.pinned_model` | `gpt-5.6-terra` |
| `unpriced_models` | `[]` |
| `judge_capabilities.codex.default_critique_model` | `gpt-5.6-terra` |
| `judge_capabilities.codex.escalated_critique_model` | `gpt-5.6-sol` |
| `judge_capabilities.agy.default_critique_model` | `gemini-3.8-flash-medium` |
| `judge_capabilities.agy.escalated_critique_model` | `gemini-3.1-pro-high` |
| `cross_vendor_ready` | `true` |
| `agy_disabled` | `false` |
| `vendors_configured` | openai `true`, google `true`, anthropic `true` |
| `vendor_degraded` | all `false` |

Both vendors expose `same_vendor_mode: conditional_cross_vendor`. Codex reports
`unavailable_when_generator_model_is: ["gpt-5.6-terra"]`; agy serves eight
critique-eligible ids so same-vendor agy judging is non-degenerate.

CLI versions observed: codex-cli 0.151.0, agy 1.1.25, Claude Code 2.1.259,
git 2.55.0.windows.3, node v22.20.0.

---

## 6. Open follow-ups

Not done here; each needs its own issue or an operator-driven session.

1. **#38 — dangling ExecutiveSuite symlinks.** Open.
2. **Doctor check that diffs rendered hook matchers against `settings.template.json`.** Noted on #25, not implemented.
3. **Article VII step 5: TheEights evolution event for the constitution amendment.** Noted on #33, not emitted.
4. **`artifact-validators.smoke.mjs` finalize-guard gap** (section 3). Pre-existing at merge base; needs a new issue.
5. **Seventeen unregistered unit files** (section 4).
6. **End-to-end flag exercise on a scratch project.** Requires an operator-driven Claude Code session and is **not** covered by this report. It must exercise: `/pp:doctor`; `--judge-effort=high --judge-reason=...`; `--judge-escalate`; `--judge-vendor=agy`; `--judge-vendor=agy --judge-escalate`; the negative paths (missing reason, non-allow-listed model, `--judge-escalate` combined with an explicit model); `/pp:team deep-reasoning-team` sourcing `team_yaml`; best-of N=3 with a second judge; the `/pp:budget` agy cost row; and `/pp:replay` carrying the new provenance fields.

The live `settings.json` renders at project and user scope were repaired
locally during this milestone. Both are gitignored, so the repair is not part of
this branch's diff.
