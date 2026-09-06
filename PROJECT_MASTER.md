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


### Run run_7tbXaLHTJU1x — 2026-09-05

**Phase A: cc-standards-alignment campaign (#42, #43)**

- Request: Establish ground truth for telemetry field derivations; inventory hook dispatcher handlers and identify inert subsystems.
- Artifacts:
  - code: `.harness/run_7tbXaLHTJU1x/daemon/src/mcp/antigravity-server.ts` — single-source-of-truth fix for `resumed` telemetry field (line 228)
  - code: `.harness/run_7tbXaLHTJU1x/daemon/src/mcp/codex-server.ts` — argv-derivation hardening for codex lane (line 446)
- Summary: Corrected telemetry reporting in the agy critique bridge. The `resumed` field was reporting whether a prior session *row existed*, not whether the conversation was *resumed*; a fresh_session guard prevented resumed conversations in critique but the telemetry was inverted. Now `didResume` is the single source of truth for both the `--continue` argv push and the reported flag. The codex lane's telemetry derivation is hardened to read from argv rather than rely on sub-cli-sessions invariants, though values remain accurate at runtime.
- Key decisions:
  - **Latent defect, not runtime defect**: codex telemetry was accurate by accident of invariants in `sub-cli-sessions.ts`; hardening its derivation is guard-strengthening, not a bug fix.
  - **agy lane was broken**: every agy critique reported `resumed: true` while being correctly stateless due to the fresh_session guard—a silent data integrity defect in the ledger.


## 11. Architecture and technical strategy

_To be populated by harness runs._

## 12. Interfaces and contracts


### Run run_z4V5xI8SlOIp — 2026-09-06
- Request: Phase B of cc-standards-alignment (GitHub #44, epic #42) — MCP published-contract surface and result-size metadata.
- Artifacts:
  - code: `.harness/run_z4V5xI8SlOIp/daemon/src/mcp/harness-server.ts` 
  - code: `.harness/run_z4V5xI8SlOIp/daemon/src/mcp/codex-server.ts`
  - code: `.harness/run_z4V5xI8SlOIp/daemon/src/mcp/agy-server.ts`
- Summary: All three MCP servers now pass a server-level `instructions` string — pp_harness 1225 bytes, pp_codex 782, pp_agy 780, under a self-imposed 2048-byte budget. Result-size annotation added: `_meta["anthropic/maxResultSizeChars"]` on `get_run` at 300,000 chars to surface large payloads (largest measured 137,255 chars, exceeding default 25,000-token cap). `replay` deliberately not annotated (largest 23,588 chars, subset of get_run; would be dead configuration).
- Key decisions:
  - Governance identifiers in MCP instructions are validated by regex extraction from the strings themselves rather than SHA binding — catches identifier disappearance but not semantic drift.
  - pp_codex deliberately omits any claim about session semantics, avoiding the need to document the current resume behavior as contract (a documented defect).
  - `hook_` prefix reserved for Phase L (#53) to avoid future contract edits for that scope.


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

### Run run_7tbXaLHTJU1x — 2026-09-05

**Phase A: cc-standards-alignment campaign (#42, #43)**

- Request: Establish ground truth for telemetry field derivations; inventory hook dispatcher handlers and identify inert subsystems.
- Artifacts:
  - code: `.harness/run_7tbXaLHTJU1x/daemon/src/mcp/antigravity-server.ts` — telemetry correctness (resumed field, line 228)
  - code: `.harness/run_7tbXaLHTJU1x/daemon/src/mcp/codex-server.ts` — derivation hardening (line 446)
  - code: `.harness/run_7tbXaLHTJU1x/daemon/src/hooks/dispatcher.ts` — hook inventory export (line 815)
  - code: `.harness/run_7tbXaLHTJU1x/daemon/test/resumed-argv-truth.unit.mjs` — regression suite: 2x2 truth table for resumed semantics
- Summary: Hardened telemetry derivations in both sub-CLI bridges (agy and codex) so that each provenance field reads from its canonical source. Added `listHookHandlers()` export from dispatcher to enable observability-layer audits. Regression test validates the resumed flag's truth table for both agy (fresh vs continued) and codex (explicit --resume flag states).
- Key decisions:
  - **agy resumed was a silent defect** that the fresh_session guard masked; now `didResume` controls both argv and reporting.
  - **Codex lane is being hardened**, not fixed—at runtime it was correct due to sub-cli-sessions invariants, but the derivation now stands on its own.
  - **listHookHandlers() enables auditability**: dispatcher now exposes the handler registry so operational hooks can be verified against config.

### Run run_z4V5xI8SlOIp — 2026-09-06
- Request: MCP contract surface and metadata support for operational visibility.
- Artifacts:
  - diff: `.harness/run_z4V5xI8SlOIp/daemon/src/mcp/` (ToolDef, tools/list handler)
- Summary: ToolDef type gained an optional `metadata` field to support result-size annotation. The `tools/list` MCP handler was updated to project this field on each tool definition. Implementation required two edits; either alone would have shipped silently (contract surface and metadata plumbing are independent, but both are required for the capability to be discoverable).
- Key decisions:
  - Metadata is ToolDef-scoped, not MCP-service-scoped, to allow per-tool overrides and future extensibility (e.g., rate-limit metadata per endpoint).


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

### Run run_7tbXaLHTJU1x — 2026-09-05

**Phase A: cc-standards-alignment campaign (#42, #43)**

- Request: Establish ground truth for telemetry field derivations; inventory hook dispatcher handlers and identify inert subsystems.
- Artifacts:
  - test: `.harness/run_7tbXaLHTJU1x/daemon/test/hook-inventory.unit.mjs` — dispatcher handler inventory validation against `.claude/settings.template.json` and root `hooks.json`; timeout coverage
  - test: `.harness/run_7tbXaLHTJU1x/daemon/test/resumed-argv-truth.unit.mjs` — regression suite: 2x2 truth table for agy+codex resumed states
- Summary: New guard test validates that dispatcher handlers, template settings, and root hooks.json are synchronized; asserts all handlers are wired and named correctly. Regression test covers the resumed flag's truth table across all bridge states. Two allowances issued: `PENDING_WIRING` (TheEights episodic recall) and `PENDING_TIMEOUT_EXEMPT_FILES` (template timeout mismatch), both Phase D work.
- Key decisions:
  - **Hook inventory is now measurable**: 29 handler pairs exist in dispatcher, but only 26 are wired in the operational config (the delta is the three TheEights episodic-recall hooks).
  - **Test naming**: `resumed-argv-truth` follows the naming pattern established by `ws7-tracked-git` (module name in test file name).
  - **Both allowances are temporary and documented** in the test so Phase D can find them easily.

### Run run_z4V5xI8SlOIp — 2026-09-06
- Request: Verification of MCP instructions surface — deterministic fixture, governance-identifier extraction, and result-size enforcement.
- Artifacts:
  - test_strategy: `.harness/run_z4V5xI8SlOIp/daemon/test/mcp-instructions.unit.mjs` (45 subtests)
  - test_strategy: `.harness/run_z4V5xI8SlOIp/daemon/test/fixtures/run-fixture.mjs` (committed fixture builder)
- Summary: New unit test suite validates MCP `instructions` strings, governance-identifier regex extraction, and metadata projection. Committed a deterministic fixture builder (previously a throwaway measurement script) to support ongoing MCP contract validation. Test suite total: 343 → 387; reporting correction (conversion from hand-rolled assertions with process.exit to real subtests made the count honest; only 2 of 45 are genuinely new coverage).
- Key decisions:
  - Fixture builder committed to `daemon/test/fixtures/` because the equivalent measurement artifact from the prior phase was a throwaway; capturing it as reusable infrastructure prevents re-measurement per run.


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

### Run run_7tbXaLHTJU1x — 2026-09-05

**Phase A: cc-standards-alignment campaign (#42, #43)**

- Request: Establish ground truth for telemetry field derivations; inventory hook dispatcher handlers and identify inert subsystems.
- Artifacts:
  - observability: `.harness/run_7tbXaLHTJU1x/daemon/src/hooks/dispatcher.ts` — `listHookHandlers()` export for hook inventory audits (line 815)
  - doc: `.harness/run_7tbXaLHTJU1x/specs/cc-standards-alignment.html` — Phase A progress; Phase D lists known open items (#46)
- Summary: Made hook inventory observable so operators can audit handler registration against config. Dispatcher exports **29** handler pairs; `.claude/settings.template.json` and root `hooks.json` each wire **26**. The delta is exactly three: `SessionStart/eights-recall-project`, `PreToolUse/eights-recall-stage`, `UserPromptSubmit/eights-recall-request`—**TheEights episodic recall is currently inert despite being implemented**. Also identified: template sets zero hook timeouts while `hooks.json` sets 30s on all 26 (both are Phase D, fenced out).
- Key decisions:
  - **Hook timeout mismatch is documented and auditable now**: the three-hook gap makes the inert subsystem measurable; Phase D can close it with full visibility.
  - **Record this as known state, not a defect**: the hooks are correctly implemented; the wiring is a configuration decision, not code.
  - **Three open defects filed** (GitHub #55, #56, #57) covering judge resumption asymmetry, override_source provenance, and test timeout brittleness.

### Run run_z4V5xI8SlOIp — 2026-09-06
- Request: Operational visibility into MCP payload sizes for capacity planning and observability.
- Artifacts:
  - slo_doc: `.harness/run_z4V5xI8SlOIp/daemon/src/mcp/harness-server.ts` (get_run result-size metadata)
- Summary: `get_run` MCP tool annotated with `_meta["anthropic/maxResultSizeChars"]` at 300,000 chars. Largest measured payload: 137,255 chars (exceedance of default 25,000-token cap is now visible upstream for clients to configure buffer sizes and timeouts). `replay` not annotated — measured largest 23,588 chars (~5,897 tokens), ratio never exceeds 0.28 vs get_run; annotation would be dead configuration.
- Key decisions:
  - Annotation scope limited to `get_run` (the primary discovery/browsing endpoint) rather than all harness tools. Other large-payload endpoints (e.g., for artifact streaming) can be annotated incrementally as needed.


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

### Run `run_7tbXaLHTJU1x` — Fix the false `resumed` telemetry field in the agy bridge and add a hook-invento

- Date: 2026-09-06
- Mode: single
- Status: complete
- Artifacts:
  - `.harness/run_7tbXaLHTJU1x/profile_snapshot.yaml` (profile_snapshot)
  - `.harness/run_7tbXaLHTJU1x/tier_decisions.json` (tier_decisions)
  - `.harness/run_7tbXaLHTJU1x/judge_decisions.json` (judge_decisions)
  - `.harness/run_7tbXaLHTJU1x/judge_decisions.json` (judge_decisions)


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

### Judge-model parity and JUDGE-1a operator overrides — 2026-09-03

- Date: 2026-09-03
- Mode: milestone (`judge-model-parity`, issues #25–#37)
- Milestone: https://github.com/lebobo88/pair-programmer/milestone/1
- Status: complete

**Constitution amendment.** `CONSTITUTION.md` Article V was amended 2026-09-03 via the HITL
`/pp:constitution amend` path — new SHA `5df284cb`, superseding `13b4fa18` (and, before it,
`2f40cda6`). The amendment (a) restates **JUDGE-1** so cross-vendor judging is mandated at
*every* gate and names the agy default judge `gemini-3.8-flash-medium` alongside the Codex
default `gpt-5.6-terra` @ medium, with escalated lanes `gpt-5.6-sol` and `gemini-3.1-pro-high`;
(b) makes agy the mandatory second Borda judge at N ≥ 3 whenever agy is enabled, requiring the
run summary to state the substitution when `PP_DISABLE_AGY=1`; and (c) adds **JUDGE-1a**, which
permits an explicit operator override of judge vendor / model / reasoning effort only when the
selection is on the daemon's allow-list, the override source and a reason of ≥ 8 characters are
recorded on the verdict, the override never downgrades a cross-vendor gate, and the JUDGE-1
defaults apply absent an override. Overrides are never inferred from request prose.

**What landed.**

- `JUDGE_MODEL_POLICY` (`daemon/src/config.ts`) is now the single source of truth for judge
  models: per-vendor `default` / `escalated` lanes, `allowed_models` and `allowed_efforts`.
  `DEFAULT_MODELS` is derived from it. agy repinned to `gemini-3.8-flash-medium` (default) and
  `gemini-3.1-pro-high` (escalated); the 3.7-flash family remains allow-listed but is no longer
  a default.
- Both critique bridges share the override surface `model? / reasoning_effort? / escalate? /
  override_source? / override_reason?`; `escalate` and `model` are mutually exclusive and a
  non-allow-listed id throws instead of being silently replaced by the pin. The result envelope
  reports the *effective* model, effort, override source/reason and (Codex) `pin_mismatch`.
- agy effort is expressed by the model-id suffix; `resolveAgyInvocation` canonicalizes a bare
  family + effort onto the suffixed id, so pp never passes `--effort`.
- `record_verdict` stores `judge_reasoning_effort`, `judge_model_source`
  (`default|escalated|cli|team_yaml|hydra`) and `judge_override_reason` (≥ 8 chars for the last
  three); replay and the TheEights `DecisionRecord` carry them. The agy exemption on the
  same-producer + same-model guard was removed — identical generator/judge model ids are now
  rejected for every producer, with producers normalized on both sides.
- Driver flags `--judge-vendor`, `--judge-model`, `--judge-effort`, `--judge-escalate`,
  `--judge-reason` on `/pp:run`, `/pp:team`, `/pp:best-of`, `/pp:gate`, `/pp:retry`, `/pp:review`;
  precedence default < team yaml `judge.{model,reasoning_effort,escalate}` < CLI. Per-stage
  resolution is written to `judge_decisions.json` (taxonomy 4.14) and `cli_flags` is persisted on
  the run row. A rejected override aborts the run rather than falling back to the default judge.
- `doctor()` now reports `agy_pin_served` with a `per_pin` breakdown (`critique_default`,
  `critique_escalated`, `generate`), `codex_pin_served` (from the CLI-reported model under
  `--smoke`), `unpriced_models`, and `judge_capabilities[<vendor>]`. `gate_eligible_judges`
  accepts `requested_judge_model` / `requested_judge_effort` and returns `allowed_judges[]` with
  `preferred_models[]` and `closing`.

**Keep-up-to-date procedure.** Repin `JUDGE_MODEL_POLICY` only; then run `agy models` and
`/pp:doctor --smoke` (agy 1.1.24 rejects unknown AND retired ids — exit 1, "invalid model
selection" — there is no silent fallback), and update every mirror. The mirror checklist lives in
`.claude/skills/judge-policy.md` § "Keeping the pins current": AGENTS.md, ARCHITECTURE.md,
docs/USER_GUIDE.md, docs/validator-policy.md, judge-policy.md, pair-programmer.md,
profile-aware-gating.md, rubric-application.md, judge-cross-vendor.md, judge-same-vendor.md,
judge-router.md, README.md, PROJECT_MASTER.md, and the generated `.github/**` mirror via
`scripts/sync-copilot-assets.mjs`.

**agy authentication.** Antigravity's official docs document only `GEMINI_API_KEY` as the
headless credential, alongside `"modelProvider": "gemini"` in
`~/.gemini/antigravity-cli/settings.json`. `GOOGLE_API_KEY` and `ANTIGRAVITY_API_KEY` are
accepted by the daemon but are undocumented upstream and should be treated as compatibility
shims. Interactive Google Sign-In (system keyring) remains the default path, which is why
`PP_DISABLE_AGY` defaults OFF.

### Run run_7tbXaLHTJU1x — 2026-09-05

**Phase A: cc-standards-alignment campaign (#42, #43)** — Documentation & Defect Registry

- Request: Establish ground truth for telemetry field derivations; inventory hook dispatcher handlers and identify inert subsystems.
- Artifacts:
  - changelog: `.harness/run_7tbXaLHTJU1x/changelog.md` — summary of Phase A fixes, test additions, and open defects
  - runbook: `.harness/run_7tbXaLHTJU1x/runbook.md` — operator guide for hook inventory audits, defect escalation paths, and Phase D work
  - doc: `.harness/run_7tbXaLHTJU1x/retry_backoff_doc.md` — retry budget, 300 s-per-attempt ceiling, bridge error non-verdicts, `record_verdict` idempotency token
- Summary: Documented Phase A outcomes, operator runbooks, and the retry subsystem contract. Three defects filed (GitHub #55: codex judge resumption vs agy statelessness asymmetry; #56: override_source provenance erasure; #57: finalize-gates-a.unit.mjs timeout brittleness). The retry backoff doc formalizes the bridge-error semantics: a CLI failure is never a model verdict, and `record_verdict` is idempotent via token.
- Key decisions:
  - **Changelog captures Phase A progress and defects**, not phase-by-phase roadmap (that lives in `specs/cc-standards-alignment.html`).
  - **Runbook is operator-facing**, detailing hook audit procedures and escalation paths.
  - **Retry backoff doc unifies prior scattered notes** on the budget, timeout ceiling, and verdict token—formalizes the bridge/daemon contract.

### Run run_z4V5xI8SlOIp — 2026-09-06 — Phase B changelog (GitHub #44, epic #42)
- **MCP published-contract surface (4.7, 4.8).** All three MCP servers now pass server-level `instructions` strings under a self-imposed 2048-byte budget. Content is navigational only: lifecycle entrypoint order, gate-eligible-judges as routing entrypoint, cross-vendor requirement at every gate, judge-same-vendor as supplementary-only, JUDGE-1a override channels. Governance identifiers validated by regex extraction from the strings themselves. pp_codex deliberately says nothing about session semantics (cannot claim statelessness; must not enshrine defect as contract). hook_ prefix reserved for Phase L (#53).
- **Result-size annotation (4.7, 4.12).** `_meta["anthropic/maxResultSizeChars"]` on `get_run` at 300,000 chars. Required two edits: ToolDef metadata field + tools/list projection. Largest measured payload 137,255 chars, exceeding 25,000-token default cap. `replay` deliberately not annotated (largest 23,588 chars, subset; would be dead configuration).
- **Verification (4.10).** New daemon/test/mcp-instructions.unit.mjs (45 subtests) and committed fixture builder daemon/test/fixtures/run-fixture.mjs. Suite total 343 → 387 reported as corrections, not new coverage (2 of 45 subtests genuinely new; conversion from hand-rolled assertions to real subtests made the count honest).

#### Known state — governance findings

- **#59 (S2).** PP-VG-5 has two defects: bypassed when archive_artifact omits optional stage_id (how prior phase's code stage passed it), and unsatisfiable in mode="single" with stage_id (requires best-of-N candidate_index that single-mode never allocates). This run's code stage surfaced (not unverified — cross-vendor pass at all dims 0.95, green suite, 18-assertion runtime check executed).
- **resumed fix.** Correct in source and dist/; MCP server process predated build, so envelopes reported resumed: true throughout run. Verified by unit test.
- **Judge-reliability signal.** agy fabricated two of three platform-documentation quotes at confidence 1.0 earlier in campaign; returned zero-finding rubber stamp on this run's docs stage (cross-vendor pass) while an overclaim was present. Repo claims consistently accurate (refuted two wrong counts). Platform-doc questions should be verified first-hand, not delegated.
- **Incorrect counts (campaign tally).** Four counts produced and corrected: tools 76 (claimed ~76 then 78); missability checks 57 (AGENTS.md:11 says 56, spec said 58). AGENTS.md still stale and fenced for follow-up.

