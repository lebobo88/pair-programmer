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

### Run run_z6a4iH0m0V2G — 2026-09-06

- Request: Phase D hook-file hardening (GitHub #46) — rationalize hook wiring, explicit timeouts, and operator-facing messaging
- Artifacts:
  - spec: `.harness/run_z6a4iH0m0V2G/spec.md`
  - diff: `.harness/run_z6a4iH0m0V2G/diff.patch`
  - changelog: `.harness/run_z6a4iH0m0V2G/docs/changelog.md`
- Summary: All 29 hook handlers are now wired in both `.claude/settings.template.json` and `hooks.json`, each with an explicit timeout classified by consequence-of-kill (30s for BLOCKING and RECOVERY handlers, 20s for INFORMATIONAL). The three `eights-recall-*` handlers (eights-recall-project, eights-recall-stage, eights-recall-request) were already implemented in `dispatcher.ts` but referenced by no settings file; they are now wired with advisory-only fail-soft semantics. The `enforce-no-secrets` deny reason was strengthened to name the remedy and state that there is no bypass. Hook counts were corrected across five documentation sites.
- Key decisions:
  - Timeout classes are derived from `reply(false)` site analysis (consequence-of-kill), not hook latency — the classification required multiline regex awareness to correctly identify 14 sites across 10 handlers, six of which span line breaks.
  - INFORMATIONAL timeout is 20s (not the spec's derived 15s) to add headroom for Windows Node cold-start above the 14 000 ms daemon-side eights-recall bound (ECOSYSTEM_PROBE_TIMEOUT_MS ×2 + ECOSYSTEM_CALL_TIMEOUT_MS, raised by cross-vendor judge as LOW-5).
  - `if:` predicates on hook matchers were abstained entirely — handler regexes are case-insensitive but permission globs would be lowercase, so predicates would silently lose blocks; the only detector was unexecutable under ANTI-STALL TEST RULE; the trade did not meet the 25% suppression threshold (R2.8).
  - `statusMessage` is added to template only; Copilot CLI support is unverified (Q8) and the guard now asserts absence rather than omitting the check.
  - `daemon-up` fail-open residual is documented as accepted (FU-1) — a timeout kill converts its fail-closed liveness guard into fail-open in precisely the case it was written to detect, per Claude Code hook docs.

### Run run_2IkydL62USI3 — 2026-09-06

- Request: Phase E of cc-standards-alignment campaign (#38, #42) — remove 50 dangling pointer stubs and close S2 silent-data-loss exposure.
- Artifacts:
  - spec: `.harness/run_2IkydL62USI3/spec.md` (6a56c8b7)
  - test_plan: `.harness/run_2IkydL62USI3/tests/test_plan.md` (9fce2b14)
  - diff: `.harness/run_2IkydL62USI3/diff.patch` (03c1a2df)
  - changelog: `.harness/run_2IkydL62USI3/docs/changelog.md` (a7d52e1f)
- Summary: Deleted 50 dangling pointer stubs (33 agent shims + 17 extensionless skill stubs) that pointed to absent sibling repos (ExecutiveSuite, AgentSmith). These posed an S2 exposure: the documented maintenance operation `node scripts/sync-copilot-assets.mjs` treated stubs as readable files and overwrote mirrors holding real content, visible only in `git diff`. Rewrote `.claude/commands/forge/council.md` from a C-suite panel (cto/ciso/cdo, deleted) to an engineering council (architect, security-reviewer, data-modeler, strategy-author — all real). Fixed tool descriptions and comments in `daemon/src/` that promised a local `boardroom` fallback agent now deleted. Added `daemon/test/no-dangling-pointers.unit.mjs` (45 assertions, 10 suites) to prevent pointer stubs from reappearing.
- Key decisions:
  - Guard classifies pointer files by content (CRLF/BOM/trim → one line, no frontmatter, absolute path shape), not extension — catches the 17 extensionless skill stubs.
  - Forbidden literals (vendor-root + sibling-repo names) assembled at runtime from fragments; guard self-checks that its own source contains no contiguous literal (AC-E28/E29).
  - Guard asserts non-emptiness of every count before comparing (visitedCount > 0, agent/skill/mirror sets > 0) so zero-match regexes cannot pass vacuously (R11, AC-E30/E53).
  - No transcribed counts in guard (no hardcoded 42/11/33/75); all counts derived from filesystem and compared relationally (R12).
  - Test script replaced hand-maintained filelist with glob (`node --test --test-timeout=180000 test/*.unit.mjs`), which exposed that `npm test` was not running 20 of 52 unit suites, including guards from Phases A/B/D. Node 20 lacks glob expansion in `node --test` arguments on Windows, so engines.node raised to >=22.0.0.

### Run run_CZvEeGpuKzLt — 2026-09-07

**Phase F: cc-standards-alignment campaign (#47, epic #42) — skill discovery migration**

**Request:** Migrate `.claude/skills/` from flat `.md` files to bundle layout (`<name>/SKILL.md`); repair generator to carry declared hook timeouts and detect pointer files; add `user-invocable` policy and `skills:` preload wiring.

**Artifacts:**
- spec: `.harness/run_CZvEeGpuKzLt/spec.md` (phases F-0 through F-19, NFR1-NFR8)
- diff (3 commits): 
  - `0a925bb` — generator rewrite (R3, R5, R6)
  - `6ec13d8` — layout migration + frontmatter wiring (R2, R4, R7, R8)
  - `11f6e57` (aebaddc) — guard test + mirror regen (R10, R11, R12, R15)
- changelog: `.harness/run_CZvEeGpuKzLt/docs/changelog.md` (judge findings + residuals)
- test_plan: `.harness/run_CZvEeGpuKzLt/tests/test_plan.md` (skill-discovery guard surface)

**Summary:** Three-commit migration established ordered prerequisites: commit 1 rewrites the generator while sources remain flat (proving idempotency); commit 2 moves the 11 skill files and adds frontmatter; commit 3 adds the guard test and regenerates mirrors. Generator (`scripts/sync-copilot-assets.mjs`) now enumerates directories under `.claude/skills/` and reads `<dir>/SKILL.md` as the source. Fixed defect A (R5): `normalizeHooks` now propagates each declared `timeout` to `timeoutSec` instead of hardcoding 30, restoring Phase D's 16 INFORMATIONAL hook timeouts (20s) that would have been flattened. Fixed defect B (R6): pointer-file detection (content-based, not extension-based) genuinely skips files, shrink-refusal refuses mirrors shrinking below 50% without `--allow-shrink`, count summaries report skips, and exit non-zero on any skip. Skills layout: 11 files moved from `.claude/skills/<name>.md` to `.claude/skills/<name>/SKILL.md`; directory contains only bundles at root. Six harness-internal skills marked `user-invocable: false` (judge-policy, rubric-application, taxonomy-adherence, artifact-conventions, master-plan-patching, profile-aware-gating); five user-facing skills carry no such key (pair-programmer, game-design, design-discovery, design-polish-review, design-token-extract). Seven agents carry `skills:` preload frontmatter (judge-cross-vendor, judge-same-vendor, judge-router, master-plan-patcher, taxonomy-mapper, designer, design-system-curator). Flat-path read-by-filesystem instructions removed from two sites (pair-programmer-orchestrator.md); all other agent references were already by name. Repo-wide search of `.claude/agents/` found only one file with filesystem-path instructions (correction to campaign plan). Skill descriptions capped at 350-byte budget per-skill, with aggregate non-increase enforced; discriminating-ness (each skill has unique 4+ char token) validated. Generator idempotent: two consecutive `node scripts/sync-copilot-assets.mjs` runs produce byte-identical output.

**Key decisions and constraints:**
- **Ordering is checkable from git history** — three commits in strict order, commit 1 touches no `.claude/skills/` path, commit 1's idempotency evidence recorded at time of production (cannot be reconstructed).
- **`skills:` not mirrored to Copilot** — `renderAgent` (scripts/sync-copilot-assets.mjs:229) rebuilds mirror frontmatter from a whitelist with no unknown-key passthrough. Extending the whitelist meant touching the generator, forbidden by ordering constraint in commit 2; Copilot skill preloading is unverified behaviour. Decision recorded in a comment beside the whitelist so the gap is visible where a maintainer reads.
- **Description trimming forced real reduction** — 350-byte cap is below current maximum (~500 chars), above current minimum (~230), leaves room for purpose sentence plus routing hint. Budget is self-imposed, not platform-enforced.
- **No `disable-model-invocation` permitted** — that key blocks preloading, which is the purpose of R7; future simplification cannot collapse the two concepts.

**Test execution and residuals:**
- Cross-vendor judge (Codex `gpt-5.6-terra`) found seven classes of defect the driver did not (advisory ordering requirement, whitelist passthrough, double-count skip, description scope trimmed, guard green while real defect live, fake mutation controls, pointer-skip test omitted data-loss vector). All closed by retry.
- All 11 skills now appear in the session's skill listing. Before migration, none did (runtime observation, not inferred).
- Mirrors regenerated: 13 real content changes (1 agent mirror for path cleanup + 1 hooks mirror for timeout fix + 11 skill mirrors for bundle sources and R8/R12 edits). No net deletions.
- `daemon/package.json` test script and `engines.node` were already corrected in Phase E. Phase F added three authorised generator exports (`syncMirrorEntry`, `pruneStaleMirrorFiles`, whitelist comment).


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

### Run run_z6a4iH0m0V2G — 2026-09-06

- Request: Phase D test-guard clearing (GitHub #46) — retire self-expiring allowances and replace with stronger positive invariants
- Artifacts:
  - test_plan: `.harness/run_z6a4iH0m0V2G/tests/test_plan.md`
  - changelog: `.harness/run_z6a4iH0m0V2G/docs/changelog.md`
- Summary: `daemon/test/hook-inventory.unit.mjs` cleared both PENDING_WIRING and PENDING_TIMEOUT_EXEMPT_FILES allowances on schedule when Phase D wired all three recall handlers and added timeouts to the template. Replacement coverage is strictly stronger: unwiring any handler is now a plain failure (no allowance to excuse it), invalid-timeout checks now reach the template (previously exempt), and five new positive-invariant families cover timeout presence, cross-file parity, per-class values, statusMessage correctness on the two write-guards, and whole-file `if:` absence. Test count grew from 25 subtests to 40; full suite passes 387/387 across 52 test files.
- Key decisions:
  - One-for-one replacement strategy ensures no prior coverage is lost — each deleted allowance-mutation check is replaced by an equivalent-or-stronger positive-invariant test (R7.7).
  - Mutation-check strategy: every positive invariant includes both a real-tree assertion and an injected-defect proof that the invariant is falsifiable (contract testing).
  - arity assertion on `buildFileReport` (`buildFileReport.length === 4`) prevents silent re-introduction of an exemption parameter, since any future exemption-add must fail loudly.
  - TIMEOUT_CLASS map is hand-written classification; coverage is derived and asserted set-equal to `implementedPairKeys` so a handler reclassified in `dispatcher.ts` leaves the map stale (MED-1, raised for future auto-derivation).
  - Textual self-checks (AC-D21, AC-D21b) use substring-absence searches to prevent stale references in comments and docstring prose, not just in live constants.

### Run run_2IkydL62USI3 — 2026-09-06

- Request: Phase E quality assurance — add comprehensive guard test to prevent dangling-pointer regressions.
- Artifacts:
  - test_plan: `.harness/run_2IkydL62USI3/tests/test_plan.md` (9fce2b14)
  - spec (R10–R13, NFR1–NFR6): `.harness/run_2IkydL62USI3/spec.md` (lines 234–475)
  - new test: `daemon/test/no-dangling-pointers.unit.mjs` (sha in diff)
- Summary: Added `daemon/test/no-dangling-pointers.unit.mjs`, a self-contained unit test (45 assertions, 10 suites, ~100 ms per run) that fails immediately if any pointer file or dangling `C:/AiAppDeployments` reference reappears under `.claude/` or `.github/`. Classification is content-based (one-line absolute path with no YAML frontmatter), not extension-based, catching the 17 extensionless skill stubs. Guard includes link-integrity checks: every agent/skill dispatched or applied in `.claude/commands/` must exist in the filesystem. Full test suite now 432 tests / 62 suites (was 387 / 52); suite timeout raised in `AGENTS.md` from 120 s to 180 s due to added load. Guard latency is p95 < 1 s, p100 < 5 s. Discovered and fixed via mutation control: non-emptiness assertions could pass vacuously (fixed to assert both visitedCount and post-filter collections); skill-half could iterate empty set (now asserts count > 0); skip-list was untested (now builds temp tree with `node_modules` to verify skip).
- Key decisions:
  - Guard built for Windows + POSIX: normalizes CRLF to LF, path separators, and uses stable sorting; fixture-tested on both drive-letter and POSIX absolute-path shapes.
  - Forbidden literals (vendor-root `AiAppDeployments` + sibling names `ExecutiveSuite`, `AgentSmith`) assembled at runtime from three fragments each, with explicit self-check: reading `import.meta.url`'s own file and asserting no contiguous forbidden literal exists there (R11, AC-E28/E29).
  - All expected counts derived from filesystem (readdirSync.length, not hardcoded): agent/skill/mirror sets compared via relational setDiff, no transcribed 42/11/33/75 literals anywhere (R12, AC-E32).
  - Scope limited to `.claude/` and `.github/` to avoid false-positives: legitimate references live in `daemon/src/`, `specs/`, root governance docs, and prose descriptions; guard only scans under those two roots and skips `node_modules`, `.git`, `.harness`, symlinks, `.env*`, `settings.local.json`, binary files >1 MiB.

### Run run_CZvEeGpuKzLt — 2026-09-07

**Phase F: Quality assurance for skill discovery and bundle-layout validation**

**Request:** Add comprehensive guard test preventing skill-layout regressions; validate bundle frontmatter, `user-invocable` policy, and description-length budget; cover cross-vendor judge findings.

**Artifacts:**
- test_plan: `.harness/run_CZvEeGpuKzLt/tests/test_plan.md` (89 tests / 17 suites, AC-to-assertion map)
- new_test: `daemon/test/skill-discovery.unit.mjs` (self-contained, no daemon/MCP/network)
- changelog: `.harness/run_CZvEeGpuKzLt/docs/changelog.md` (judge findings and defect classes closed)

**Summary:** New guard `daemon/test/skill-discovery.unit.mjs` (89 tests / 17 suites, ~330-420ms deterministic runtime) validates the bundle layout, frontmatter structure, `user-invocable` policy, agent `skills:` preload map, and description-length budget. Each of 10 invariants (R10.2–R10.11) includes a positive assertion against the real tree and a mutation/falsifiability control using `mkdtempSync` fixtures (never the tracked tree). Drives five real `scripts/sync-copilot-assets.mjs` exported functions: `enumerateSkillSources`, `normalizeHooks`, `writeMirrorSafely`, plus `MIRROR_SHRINK_THRESHOLD` and `ALLOW_SHRINK_FLAG` constants, and `isDirectInvocation`. Tests propagated hook timeouts (fixture with distinct 20/45s values; missing timeout throws naming the pair), pointer-skip leaves mirrors byte-identical and warns both paths, shrink refusal at boundary, and shared pointer-file predicate with 12-case fixture table (CRLF/LF/BOM/whitespace/POSIX/Windows absolute/frontmatter/multi-line/relative/prose-containing-path/empty/whitespace-only). Validates R4.1 `user-invocable` set exactly (six names), absence of `disable-model-invocation`, R7.1 agent→skills mapping, resolution of every `skills:` member, and `docs/USER_GUIDE.md` relative skill links. Description budget: per-skill cap 350 chars, aggregate non-increase (measured via `git show` pre-migration), discriminating-ness (each skill has ≥1 unique ≥4-char lowercase token vs others). Prose skill references in `.claude/commands/**/*.md` extracted and resolved (carried-forward HIGH-1 remediation); fixture with in-memory mutated council.md proves detection goes red when referenced name doesn't exist.

**Non-vacuity controls enforced (R11):**
- Forbidden literals (`disable-model-invocation`, `timeoutSec: 30`) assembled at runtime from fragments; guard self-checks that its own source (`__filename`) contains no contiguous literal (AC-F44), with mutation control proving the check rejects synthetic source containing one.
- Every `describe` block iterating a collection asserts that collection's non-emptiness before iterating (AC-F45). Counter: 10 invariants with mutation controls.
- No transcribed counts of skills/agents/mirrors/hooks/commands (R11.4, AC-F46). All counts derived from filesystem (readdirSync, git show for pre-migration baseline).
- Every falsifiability proof uses `mkdtempSync` with `finally` cleanup, never tracks real files (R11.6, AC-F48). Verified by grep showing all write targets traceable to `tmp` variable.

**Cross-vendor judge findings closed:**
1. **Ordering was advisory** — spec's acceptance criteria unevaluable after file move. Closed by R18 (commit sequence checkable from git history, commit 1 touches no `.claude/skills/`, idempotency proof at production time).
2. **Whitelist passthrough would drop `skills:` from mirrors** — `renderAgent` rebuilds from fixed whitelist. Recorded decision not to mirror (documented in comment).
3. **Double-count skip** — `syncMirrorEntry` and `rewriteGeneratedCopilotMirrors` both incremented on same pointer. Fixed by exporting and testing real `syncMirrorEntry`.
4. **Description trimming cut scope** — "Every file MUST go through archive_artifact" became "every file MUST". Restored full clause and assertion.
5. **Guard green while defect live** — seven command files referenced deleted `pair-programmer.md` file. Broadened pattern, proved red against unfixed tree, fixed files, proved green.
6. **Fake mutation controls** — two assertions only checked fixture names never existed; three tautologies. Replaced with real function exports and falsifiability fixtures.
7. **Pointer-skip test omitted vector** — `keepSet.add` and `pointerSkipSet.add` stop `pruneStaleMirrorFiles` delete. Test now drives real prune with nested fixture proving nested mirror survives.

**Test metrics:**
- **NFR1 (single-file latency):** ~330-420ms, well under 10s ceiling (R13.1).
- **NFR2 (full-suite latency):** `node --test --test-timeout=180000 daemon/test/*.unit.mjs` passes 521 / 0 failed / 80 suites (delta +73 tests / +15 suites from this file; NFR2 ceiling remains 180s).
- **NFR3 (test-script coverage):** automatic via glob `test/*.unit.mjs` in `daemon/package.json`; no explicit filename list reintroduced (forbidden per AGENTS.md).
- **Build and typecheck:** clean; no new diagnostics.

**Residuals and open items:**
- **AC-F55/AC-F57 (operator-only steps):** `/context` capture and fresh-session per-skill observation explicitly out of scope for automated tests per R14.3.
- **AC-F65 (rollback on scratch worktree):** not this commit's obligation (commit 1/2 scoped to R16.1/R16.2).
- **`frontend-design` reference:** still open; R17 forbids touching until settled. Guard does not mention it (scoped to command tree only, where it doesn't appear).
- **One unidentified full-suite failure:** appeared once, did not reproduce across four subsequent runs. Disclosed with signatures distinguishing GitHub #57 from phase-specific fixture issue.


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

### Run run_z6a4iH0m0V2G — 2026-09-06

- Request: Phase D operational-ownership missability response (GitHub #46)
- Artifacts:
  - ownership: `.harness/run_z6a4iH0m0V2G/ops/ownership.md`
  - changelog: `.harness/run_z6a4iH0m0V2G/docs/changelog.md`
- Summary: Phase D adds only advisory, fail-soft mechanisms (episodic recall handlers, status messages, per-class timeouts); pair-programmer is single-operator local harness with no on-call obligation or paging. The phase identified and disclosed one real operational gap: `.claude/settings.json` is git-ignored and rendered from `.claude/settings.template.json` by the installer, so divergence between repo state and running state is silent — nothing in the tree detects it. Between a `git pull` and the next installer run, hooks stay on implicit defaults while every checked-in file claims explicit wiring and timeouts.
- Key decisions:
  - All ecosystem wrappers short-circuit to null when the external TheEights peer is unreachable — an absent or hung peer degrades behavior to silence, never to blocking.
  - Timeout kills are documented per consequence-of-class in the template's `_comment`, so operators understand the fail-open risk and can factor it into assessment.
  - Hook inventory drift is owned by `daemon/test/hook-inventory.unit.mjs` (test failure); timeout-class drift is owned by the same guard's TIMEOUT_CLASS map (hand-written, with coverage assertion); installed-vs-repo divergence is owned by the operator running `scripts/install-user.ps1` (unautomated, undiscovered).
  - `daemon-up` fail-open residual (FU-1) is accepted and cites platform documentation verbatim — operator's own `doctor` call is the compensating control (per AGENTS.md Hard Rule 1).


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

### Run run_z6a4iH0m0V2G — 2026-09-06

- Request: Phase D documentation and enablement (GitHub #46) — correct counts, document timeout rationale, and disclose operator actions
- Artifacts:
  - spec: `.harness/run_z6a4iH0m0V2G/spec.md`
  - changelog: `.harness/run_z6a4iH0m0V2G/docs/changelog.md`
- Summary: Updated `.claude/settings.template.json` top-level `_comment` to document all 29 handlers (up from 26), per-class timeout values with rationale, and the daemon-up fail-open residual (FU-1). Corrected hook counts in five user-facing documents where they had drifted (README.md two sites, docs/INSTALL.md, docs/USER_GUIDE.md subsection headings, scripts/install-user.ps1). Added official changelog under "Unreleased" and documented operator action required: re-running the installer to propagate the wiring and timeouts into `.claude/settings.json` (git-ignored, rendered from template).
- Key decisions:
  - Timeout class rationale is recorded inline in the template's `_comment` rather than in separate docs, tying specification to source.
  - Documentation counts are derived from `listHookHandlers()` or asserted as immutable fixtures in the test suite, never transcribed — no second place they can drift.
  - PLAN.md is left untouched as a dated artifact (§8); only live user-facing docs are corrected (§7.2).
  - Subsection heading counts in USER_GUIDE.md are re-derived from the handler inventory and mechanically verified (R5.7, AC-D19a).
  - Changelog captures both the fixes and the known residuals (daemon-up fail-open, if: abstention, installer-propagation gap, TIMEOUT_CLASS drift) so readers understand what is and is not settled.

### Run run_2IkydL62USI3 — 2026-09-06

- Request: Phase E documentation updates — correct agent/skill roster counts and delete false claims about executive overlay.
- Artifacts:
  - changelog: `.harness/run_2IkydL62USI3/docs/changelog.md` (lines 5–60, known residuals)
  - spec (R5, R6, R8): `.harness/run_2IkydL62USI3/spec.md` (lines 159–220)
- Summary: Corrected documentation counts drifted by the 50-stub deletions and one pre-existing error. `.claude/agents/` now 42 real agents (was 75 including stubs); `.claude/skills/` now 11 real skills (was 8, already wrong). Updated `README.md` sections 147, 154, 230, 235 and `docs/USER_GUIDE.md` sections 29, 87, 1119, 1121, 1265, 1267, 1782 to reflect actual roster. Deleted now-false claims that pp's sub-agents include "executive-suite personas, governance authors, and AgentSmith watchers" (§17 in USER_GUIDE). Deliberately kept MCP-tool count 75 untouched across all references (README.md:18, :146, :219, USER_GUIDE.md:1267) — these count tools, not agents; R7 forbade substitution.
- Key decisions:
  - Skills count correction from 8 to 11 included replacing nonexistent `frontend-design` (Claude Code built-in) with real skill `design-discovery`.
  - Anchor change `#17-sub-agents-75` → `#17-sub-agents-42` required re-scanning repo for back-references; only `.claude/` TOC link found and fixed.
  - Sub-agent subsection subtotals (41 initially) corrected by adding `agents-md-author` to Lifecycle subsection (now 6 agents, sum 42).
  - R7's strict distinction between MCP-tool counts (75, preserved) and sub-agent counts (42, corrected) caught by spec's adjacent-line warning: README.md:146 and :147 carry different 75s.

### Run run_CZvEeGpuKzLt — 2026-09-07 — Phase F documentation and observation

**Phase F: cc-standards-alignment campaign (#47, epic #42) — skill discovery and bundle layout**

**Artifacts:**
- changelog: `.harness/run_CZvEeGpuKzLt/docs/changelog.md` (three-commit narrative with judge findings and residuals)
- spec: `.harness/run_CZvEeGpuKzLt/spec.md` (R0–R19, acceptance criteria, NFRs)
- test_plan: `.harness/run_CZvEeGpuKzLt/tests/test_plan.md` (guard surface and Reflexion retry details)
- browser_validation: `.harness/run_CZvEeGpuKzLt/browser-validation/report.md` (not_applicable — no web UI touched)

**The migration demonstrably works — observed, not inferred:**

After commit `6ec13d8` (the layout migration), **all 11 skills appear in the session's own skill listing. Before the migration, none did.** The spec explicitly stated that a `*.unit.mjs` test can assert the on-disk layout but cannot observe what actually loaded—that is the runtime half, and it arrived for free. This is the substance of the phase: the skills bundle shape is now real, active, and discoverable.

**Three-commit ordering is load-bearing and now checkable from git history:**

| Commit | Purpose |
|---|---|
| `0a925bb` | Generator rewrite (R3, R5, R6), exercised while skill sources were **still flat**. `normalizeHooks` now carries declared `timeout` instead of hardcoding `timeoutSec: 30`. Pointer-file detection that genuinely skips. Shrink refusal behind an explicit flag. Count summary with non-zero exit on any skip. Idempotency proven at production time. |
| `6ec13d8` | The migration: 11 skills from `.claude/skills/<name>.md` to `.claude/skills/<name>/SKILL.md`. `user-invocable: false` on six harness-internal ones. `skills:` preload on seven consuming agents. Every path reference updated. Descriptions capped at 350 bytes. |
| `11f6e57` (aebaddc) | The `skill-discovery` guard (91 tests / 18 suites after Reflexion retry), `.github/` mirror regeneration (13 files, all insertions >= deletions), and carried-forward judge findings. |

`.github/skills/<name>/SKILL.md` is **generated from** the `.claude/skills` sources, so it is the shape target, not a migration source—moving the files first would have broken the generator's input. The spec's ordering requirement was found to be advisory (no acceptance criterion would have failed if an implementer moved first), and was replaced by one that makes git history the evidence.

**Mirror regeneration: 13 real content changes**

`git diff --ignore-all-space --stat` against HEAD shows real content changes in exactly 13 files:
- 1 agent mirror: `.github/agents/pair-programmer-orchestrator.agent.md` (R8 path-reference cleanup)
- 1 hooks mirror: `.github/hooks/pair-programmer.json` (R5 `timeoutSec` fix + Phase D eights-recall handlers)
- 11 skill mirrors: all `.github/skills/*/SKILL.md` bundles (banner now names bundle source path + R8/R12 body edits)

Root `hooks.json` shows zero real diff (already current from earlier verification). All 13 rows have insertions ≥ deletions; **none is a net deletion** (R15.2 — no shrink-refusal case triggered). ~62 other files `git status` initially flagged `M` are pure CRLF/LF checkout-normalisation noise; after `git add`, they collapse back to no-op in `git diff --cached --stat`.

**Generator idempotency proven:**

Two consecutive `node scripts/sync-copilot-assets.mjs` runs from the repo root by its real path. Both runs reported: `agents synced: 42, commands synced: 19, skills synced: 11, mirrors rewritten: 19, entries skipped: 0, rewrite skips honoured: 0`, exit 0. MD5sums of every file under `.github/` and `hooks.json` after run 2 and run 3 are byte-identical.

**What the cross-vendor judges caught that the driver and its agents did not:**

Seven classes of defect, each previously shipped in this campaign:

1. **Advisory ordering requirement became checkable.** Spec's order was advisory; no criterion would fail if implementer moved first. Closed by R18: three commits in order, commit 1 touches no `.claude/skills/` path, commit 1's idempotency proof recorded at production time (cannot be reconstructed).
2. **`normalizeAgent` whitelist would silently drop `skills:` key.** `renderAgent` rebuilds mirror frontmatter from fixed whitelist with no passthrough. Extending meant touching generator (forbidden by ordering). Copilot skill preloading is unverified. Recorded decision in comment beside whitelist.
3. **Single skip counted twice.** `syncMirrorEntry` and `rewriteGeneratedCopilotMirrors` both incremented on pointer skip. Fixed by exporting real `syncMirrorEntry` and testing both paths.
4. **Trimming description to byte cap cut scope.** "Every file written under `.harness/` MUST go through `archive_artifact`" became "every file MUST go through …" (universal rule). Restored full clause.
5. **Guard was green while real defect was live.** Seven command files referenced `` `pair-programmer.md` `` (file commit 2 deleted). First pattern matched only the two phrasings already present. Broadened, proved red against unfixed tree, files repaired, proved green.
6. **Two "mutation controls" controlled nothing; four assertions were tautologies.** One could never fail. One hand-transcribed a count while header claimed count discipline. One "Self-check:" block contained no code. All deleted or replaced with real function exports and falsifiability fixtures.
7. **Pointer-skip test omitted the actual data-loss vector.** `keepSet.add` and `pointerSkipSet.add` are what stop `pruneStaleMirrorFiles`' `rmSync` from deleting the mirror a skip preserves. Test's local glue omitted both and asserted byte-identity inside an `if/else` that guaranteed it. Fixed by exporting real `syncMirrorEntry` and nested fixture proving nested mirror survives.

**Residuals that MUST survive into the master plan:**

1. **`skills:` is not carried into the Copilot mirrors, by decision.** `renderAgent` rebuilds mirror frontmatter from a `name`/`model`/`description`/`target`/`tools` whitelist with no unknown-key passthrough. Extending it was forbidden by the ordering constraint at the time, and Copilot-side skill preloading is unverified either way; a comment now sits beside the whitelist so the gap is visible where a maintainer looks.
2. **Whether `frontend-design` is a Claude Code built-in or a dangling reference is still open.** Spec R17 forbids touching any of those references until it is settled. The driver will not delegate the question after an agy critique in this campaign fabricated two of three platform-documentation quotes at confidence 1.0.
3. **`AC-F-A2` is a defect in the spec, not in the work** — ruled so by the judge. A line-level grep cannot distinguish a `frontend-design` reference from a comment *about* one.
4. **Nothing asserts the prune/rewrite interaction across a future source change**, so today's mirror correctness is not protected tomorrow.
5. **One unidentified full-suite failure** appeared once and did not reproduce across four subsequent runs. Disclosed with the two signatures that distinguish GitHub #57 from a fixture of this phase's own; the judge would have blocked on it and the driver did not.
6. **Two spec acceptance criteria are operator-only and not automatable** (AC-F55, AC-F57), and AC-F65's rollback demonstration was out of this commit's scope.

