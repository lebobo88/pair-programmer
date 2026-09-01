# Project Master Plan — pair-programmer

_Auto-scaffolded by pair-programmer harness on 2026-06-07. Each `/pp:run` will append/patch the relevant section. The taxonomy_blueprint.md is the canonical reference for the 16 SDLC sections._

## 1. Executive summary

_To be populated by harness runs._

## 2. Business and portfolio context

_To be populated by harness runs._

## 3. Stakeholders and users

_To be populated by harness runs._

## 4. Current-state workflow and pain

_To be populated by harness runs._

## 5. Scope and roadmap

_To be populated by harness runs._

## 6. Functional requirements


### Run run_jc1UxeCMvyZR — 2026-08-22

**Request:** Document three critical defects in sub-CLI bridge (agy model pins, vendor fallthrough, provenance omission)

**Artifacts:**
- `acceptance_criteria`: `.harness/run_jc1UxeCMvyZR/repro.md` (22 criteria, RFC 2119)

**Summary:** This run documented three defects reproduced against live CLIs: AGY-MODEL-ID-STALE (pins stale: gemini-3.1-pro-preview vs gemini-3.1-pro-high), AGY-SILENT-VENDOR-FALLTHROUGH (copilot fallback returned output under wrong vendor envelope, falsely satisfying cross-vendor gates), and CODEX-BRIDGE-OMITS-PROVENANCE (findings_provenance stripped from critiques, blocking hallucination gates). Scope covers `daemon/src/`, `daemon/test/`, `daemon/prices.json`, `daemon/README.md`, and agent frontmatter.

**Key architectural constraints established:**
- Removed copilot fallback entirely; no secondary-vendor fallback allowed. A correctly-attributed failure is preferred over a silently mis-attributed success that could satisfy a constitutional gate fraudulently.
- agy model ids are effort-suffixed (gemini-3.1-pro-high / -low); the installed CLI validates `--model <id>` and exits non-zero on unrecognized id. Run `agy models` to verify whenever the pin changes.
- findings_provenance is now a first-class optional field on critique output schema and CritiqueVerdict, so judge citations survive the bridge instead of being stripped.
- TDD gate now supports `node-test` runner and `mixed` expected_pre_outcome, enabling bug-fix-team red phase verification in this repo.


## 7. Acceptance criteria

_To be populated by harness runs._

## 8. Non-functional requirements

_To be populated by harness runs._

## 9. UX/UI/content design

_To be populated by harness runs._

## 10. Domain and data model

_To be populated by harness runs._

## 11. Architecture and technical strategy

_To be populated by harness runs._

## 12. Interfaces and contracts

_To be populated by harness runs._

## 13. Engineering standards and delivery model




### Run run_jc1UxeCMvyZR — 2026-08-22

**Request:** Fix four daemon defects and establish no-secondary-vendor architectural constraint

**Artifacts:**
- `diff`: `.harness/run_jc1UxeCMvyZR/diff.patch` (commit d8e8302)
- `changelog`: `.harness/run_jc1UxeCMvyZR/changelog.md` (fixed/changed/removed summary)

**Summary:** Four defects fixed in commit d8e8302: (1) agy model pins repinned from `gemini-3.1-pro-preview` to `gemini-3.1-pro-high`; (2) agy rejection pattern (`is not recognized as a known model`) added to PERSISTENT_STDERR_PATTERNS so deterministic failures are classified persistent, not transient; (3) `findings_provenance` made optional in critique schema instead of forbidden; (4) TDD gate extended with `parseNodeTest()` runner. Deleted `daemon/src/mcp/copilot-runner.ts` and `attemptCopilotFallback`—this is a standing architectural constraint: vendor attribution is non-negotiable.

**Key decisions and constraints:**
- No secondary-vendor fallback: when agy or codex CLI fails, return the failing result unchanged (hard stage failure, operator manual action required).
- Vendor attribution is inviolable: envelope producer labels must match the subprocess that actually produced the output. Any future component wrapping a vendor CLI and returning output under a different label reintroduces the AGY-SILENT-VENDOR-FALLTHROUGH vulnerability class.
- Model pricing table (`daemon/prices.json`) retains stale keys to preserve historical cost rows; new `gemini-3.1-pro-high` entry added alongside `gemini-3.1-pro-preview`.
- TDD `mixed` outcome support required adding `parseNodeTest()` parser for `node --test` runner (handles spec reporter `ℹ` and TAP reporter `#` prefixes).
- All unit tests pass; `npm run build` clean.

### Run `run_4LEN6bjb5gEL` — Repo-wide model-id refresh, following the HITL constitution amendment (CONSTITUT

- Date: 2026-08-23
- Mode: single
- Status: complete
- Artifacts:
  - `.harness/run_4LEN6bjb5gEL/diff.stat.md` (diff)

### Run `run_tYE0v6WrwFWs` — Harness hardening — clear the open follow-ups accumulated across run_jc1UxeCMvyZ

- Date: 2026-08-23
- Mode: single
- Status: complete
- Artifacts:
  - `.harness/run_tYE0v6WrwFWs/diffstat.md` (diff)


## 14. Security, privacy, and compliance


### Run run_jc1UxeCMvyZR — 2026-08-22

**Request:** Document all controls defending cross-vendor judge integrity; identify residual gaps

**Artifacts:**
- `control_matrix`: `.harness/run_jc1UxeCMvyZR/control_matrix.md` (8 controls, 2 cross-cutting gaps)

**Summary:** Established control matrix documenting eight security controls (C1–C8) that defend against judge-producer mislabelling and same-vendor fraud. C1: same-producer + same-model guard at `runs.ts:857` (not :640 as AGENTS.md incorrectly cites in three places). C8: no silent vendor substitution via deletion of `copilot-runner.ts`. Residual Gap 1: producer labels are trusted without cryptographic attestation; any component wrapping a vendor CLI and returning output under a different label reintroduces the vulnerability. Gap 2: provenance verification is position-blind (whole-file substring test, line numbers not validated).

**Security control constraints established:**
- C1 guard (same-producer + same-model) enforced by daemon at runs.ts:857; prevents a model from judging its own output.
- C2–C4 gate routing and judge selection enforced by driver (`/pp:run`), not daemon.
- C5 hallucination gate (PP-VG-6) refuses `finalize_stage(passed)` while any verdict carries `hallucination_suspected=1`.
- C6 citation verifier (`validateFindingsProvenance`) rejects missing/short/malformed provenance; whole-file includes test, not line-anchored.
- C7 schema enforcement: `findings_provenance` now optional (not forbidden); malformed entries dropped without rejecting verdict.
- C8 absence enforced by code deletion: no `copilot-runner` exists, no fallback path can execute.

**Outstanding defects (not fixed by this run):**
- ~~AGENTS.md cited `runs.ts:640` for the C1 guard in three places~~ — RESOLVED in run_4LEN6bjb5gEL: all three sites now cite `runs.ts:857`, as do .claude/skills/judge-policy.md and .claude/teams/deep-reasoning-team.yaml.
- Provenance verification remains position-blind (Gap 2); line numbers are captured but not validated (runs.ts:718 is substring-only).
- Shadowing `vendorFor()` in `gates.ts:314-319` returns "unknown" for copilot; `config.ts:164-171` returns "openai" (two functions, same name, divergent answers).
- findings_provenance fix is unit-tested but NOT proven in live bridge round-trip (MCP server was pre-fix during run).


## 15. Test and verification strategy


### Run run_jc1UxeCMvyZR — 2026-08-22

**Request:** Deliver unit test coverage for three critical defects and TDD gate structural fix

**Artifacts:**
- `test_plan`: `.harness/run_jc1UxeCMvyZR/test_plan.md` (22 criteria coverage matrix)
- `tdd_manifest`: `.harness/run_jc1UxeCMvyZR/tdd_manifest.json` (red/green thresholds)
- `test_logs`: `.harness/run_jc1UxeCMvyZR/tdd_checks/` (gate evidence: pre #1, pre #2, post)

**Summary:** Delivered five new unit test suites (agy-model-id-classification, findings-provenance extended, copilot-fallback-removed, copilot-fallback-runtime, tdd-gate-node-test-parser) covering all 22 acceptance criteria. All suites are self-contained per ANTI-STALL TEST RULE (temp SQLite, direct imports from `dist/`, no live daemon or MCP peer). TDD gate validated red→green with `node-test` runner: pre-check mixed (18 pass / 10 fail), post-Reflexion mixed (22 pass / 14 fail), final all_pass (36 pass / 0 fail).

**Test strategy decisions:**
- Unit-only (no `npm test` or `smoke.mjs`) to avoid dependency on external TheEights peer or daemon subprocess. Faster and deterministic in automated agent contexts.
- TDD gate now parses `node --test` runner output (spec reporter `ℹ` and TAP reporter `#` prefixes via `parseNodeTest()`); `mixed` is now a valid `expected_pre_outcome`.
- Pre-check `expected_pre_outcome: mixed` (bug-fix-team red phase); `expected_post_outcome: all_pass` (strict, deliberately not widened).
- Four pre-existing failing unit suites documented as out-of-scope: agents-md, fable-tier, finalize-gates-a, shutdown (proven pre-existing at HEAD~1).
- All new unit tests pass; `npm run build` clean.


## 16. Operations and support model






### Run run_jc1UxeCMvyZR — 2026-08-22

**Request:** Establish runbook for sub-CLI bridge operations and removal of copilot fallback

**Artifacts:**
- `runbook`: `.harness/run_jc1UxeCMvyZR/runbook.md` (3-part operator guide)
- `retry_strategy`: `.harness/run_jc1UxeCMvyZR/retry_backoff_doc.md` (retry classification rules)

**Summary:** Established three-part operational runbook for sub-CLI bridge. Section 1: identifying failing lane (agy, codex) via `failure_archive_path` and `attempts[]` array; classify each attempt as transient, persistent, or ok. Section 2: operator playbook when vendor lane is down—no automatic copilot fallback exists; options are re-dispatch when outage clears, fix root cause and rebuild daemon, or disable agy via `PP_DISABLE_AGY=1` to route to Codex+Claude pair. Section 3: verifying model pin is still served (`agy models` command and probe invocation). Removed `PP_COPILOT_FALLBACK` and `COPILOT_FALLBACK_ENABLED` environment variables; setting them has no effect.

**Operational constraints:**
- Hard failure on primary vendor unavailability is the intended outcome. Stages that previously completed through vendor outage will now fail.
- Operators must manually re-dispatch when a vendor outage clears, or proactively switch to an available vendor pair.
- When agy is down, do NOT assume silent fallback; inspect failure archive for root cause (auth, network, model pin drift, service outage).
- `agy models` and probe invocation documented as mandatory verification steps before assuming daemon config or pricing table drift.
- This is a **breaking change**: availability must not be purchased with provenance. Operator action required for stages previously resilient to vendor outage.

### Run `run_4LEN6bjb5gEL` — Repo-wide model-id refresh, following the HITL constitution amendment (CONSTITUT

- Date: 2026-08-23
- Mode: single
- Status: complete
- Artifacts:
  - `.harness/run_4LEN6bjb5gEL/runbook.md` (runbook)
  - `.harness/run_4LEN6bjb5gEL/retry_backoff_doc.md` (retry_backoff_doc)
  - `.harness/run_4LEN6bjb5gEL/diagnostics.md` (runbook)

### Run `run_WuP005xQIXS4` — HOTFIX — the codex judge plane is DOWN. Regression introduced by fix 3 of run_jc

- Date: 2026-08-23
- Mode: single
- Status: complete
- Artifacts:
  - `.harness/run_WuP005xQIXS4/runbook.md` (runbook)
  - `.harness/run_WuP005xQIXS4/retry_backoff_doc.md` (retry_backoff_doc)
  - `.harness/run_WuP005xQIXS4/diagnostics.md` (runbook)

### Run `run_tYE0v6WrwFWs` — Harness hardening — clear the open follow-ups accumulated across run_jc1UxeCMvyZ

- Date: 2026-08-23
- Mode: single
- Status: complete
- Artifacts:
  - `.harness/run_tYE0v6WrwFWs/runbook.md` (runbook)
  - `.harness/run_tYE0v6WrwFWs/retry_backoff_doc.md` (retry_backoff_doc)
  - `.harness/run_tYE0v6WrwFWs/diagnostics.md` (runbook)

### Run `run_kUPtCqHotdYn` — Fix the pair-programmer document-stage delivery stall: (1) make the daemon's dis

- Date: 2026-08-24
- Mode: single
- Status: complete
- Artifacts:
  - `.harness/run_kUPtCqHotdYn/runbook.md` (runbook)
  - `.harness/run_kUPtCqHotdYn/retry_backoff_doc.md` (retry_backoff_doc)
  - `.harness/run_kUPtCqHotdYn/decision_record.md` (decision_record)


## 17. Team operating model and governance



### Run run_jc1UxeCMvyZR — 2026-08-22

**Request:** Document team and tier decisions for bug-fix-team profile (non-ui-cli)

**Artifacts:**
- `tier_decisions`: `.harness/run_jc1UxeCMvyZR/tier_decisions.json` (profile policy and per-stage resolver trace)

**Summary:** Tier decisions show all stages under `non-ui-cli` profile with no per-stage `model_tier_policy` overrides. Spec stage (repro) uses opus (claude-opus-4-7 from spec-author frontmatter default). Code and docs stages default to codex per `DEFAULT_MODELS` and agent frontmatter. Best-of-N not applied (standard triage scope; applies only at scope='major'). All decisions documented with full resolver trace showing absent overrides from team yaml, profile scope_adjust, and CLI flags.

**Governance decisions:**
- non-ui-cli profile carries no `model_tier_policy`; agent frontmatter defaults are authoritative for every stage.
- Spec stage is a cross-vendor gate; generator uses opus (Claude default), judge uses codex (JUDGE-1).
- Best-of-N disabled for standard triage scope; would apply only at scope='major'.
- No tier caps or floors applied via CLI (`--tier-cap`, `--tier-floor`) or team config.
- Team policy is `bug-fix-team`; triage scope is `standard`.

### Run `run_kUPtCqHotdYn` — Fix the pair-programmer document-stage delivery stall: (1) make the daemon's dis

- Date: 2026-08-24
- Mode: single
- Status: complete
- Artifacts:
  - `.harness/run_kUPtCqHotdYn/postmortem.md` (postmortem)


## 18. Risks, assumptions, and open questions

_To be populated by harness runs._

## 19. Launch, migration, and rollback plan

_To be populated by harness runs._

## 20. Deprecation and retirement plan

_To be populated by harness runs._

## Appendices



### Run run_jc1UxeCMvyZR — 2026-08-22 — Changelog and known issues

**Artifacts:**
- `changelog`: `.harness/run_jc1UxeCMvyZR/changelog.md` (unreleased, commit d8e8302)

**Fixed:**
- AGY-MODEL-ID-STALE: model pins repinned to `gemini-3.1-pro-high`; stale pin was `gemini-3.1-pro-preview`.
- AGY-MODEL-ID-STALE (retry classifier): agy rejection pattern added to PERSISTENT_STDERR_PATTERNS so `isPersistentStderr()` returns `true` for "is not recognized as a known model" wording.
- CODEX-BRIDGE-OMITS-PROVENANCE: `findings_provenance` made optional in critique schema (no longer forbidden); preserved in normalize passthrough.
- TDD-GATE-NO-NODE-TEST-PARSER: added `parseNodeTest()` runner and `mixed` as valid `expected_pre_outcome`.
- PRICES.JSON resolution path off by one level in `BUNDLED_PATH` (`daemon/src/util/prices.ts`).

**Changed:**
- `daemon/prices.json` gains `gemini-3.1-pro-high` entry under `google` (interim price copied from preview entry); `gemini-3.1-pro-preview` retained.
- `daemon/src/config.ts` comment corrected: agy **does** validate `--model <id>` and exits non-zero on unrecognized id (was falsely claiming silent fallback).

**Removed (BREAKING):**
- `daemon/src/mcp/copilot-runner.ts` and `attemptCopilotFallback()` deleted entirely. `PP_COPILOT_FALLBACK` and `COPILOT_FALLBACK_ENABLED` env vars no longer exist. When agy or codex CLI fails, the bridge returns the failing result unchanged (hard stage failure).

**Pre-existing failures (not fixed by this run):**
- `daemon/test/agents-md.unit.mjs`, `fable-tier.unit.mjs`, `finalize-gates-a.unit.mjs`, `shutdown.unit.mjs` — all four proven failing at HEAD~1 before any changes from this run.

**Known documentation defect (not fixed by this run):**
- ~~AGENTS.md cited `runs.ts:640` for the same-producer + same-model guard in three places (Hard Rule 3, Hard Rule 4, Security).~~ RESOLVED in run_4LEN6bjb5gEL: corrected to `runs.ts:857` at all three sites, plus two further copies in .claude/skills/judge-policy.md and .claude/teams/deep-reasoning-team.yaml that the original follow-up had missed.

### Run `run_4LEN6bjb5gEL` — Repo-wide model-id refresh, following the HITL constitution amendment (CONSTITUT

- Date: 2026-08-23
- Mode: single
- Status: complete
- Artifacts:
  - `.harness/run_4LEN6bjb5gEL/summary.md` (run_summary)

