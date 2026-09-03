# AGENTS.md — pair-programmer Cross-Tool Behavioral Contract

This file is the single source of truth for any AI agent (Claude Code, Codex, Antigravity (agy), Copilot, etc.) working inside the pair-programmer repo. Tool-specific shims (`CLAUDE.md`, etc.) import from this file.

## What pair-programmer Is

A TypeScript daemon + MCP server that wraps a **taxonomy-aware, best-of-N, cross-vendor-judged code-generation lifecycle** around every engineering task.

- **Standalone**: invoked via `/pp:run`, `/pp:best-of`, `/pp:team`, and 16 other slash commands in Claude Code; or via the GitHub Copilot CLI plugin.
- **As Hydra's engineering squad**: Hydra dispatches `DevTask` envelopes to the daemon over MCP; results return as `DecisionRecord` envelopes to TheEights.
- **Core lifecycle**: triage → profile detect → taxonomy map → stage loop (generate → judge → Reflexion ×1 on fail) → 56 missability checks → `PROJECT_MASTER.md` patch → finalize.
- **Model tiers** (source: `daemon/src/config.ts:CLAUDE_TIER_MODELS`): `haiku`, `sonnet`, `opus`, and `fable` (capability-gated, off the auto-escalation ladder — never reached by `shiftTier`; see Hard Rules).
- **Cross-vendor judge**: default pin is Codex `gpt-5.6-terra` at medium reasoning effort (`JUDGE-1` in `CONSTITUTION.md`; `DEFAULT_MODELS.codex_critique` in `daemon/src/config.ts`). Escalated judging uses `gpt-5.6-sol` (opt-in, major-scope / last-resort only; `DEFAULT_MODELS.codex_critique_escalated`). A second judge (agy) for Borda scoring at N≥3 is driver-selected and optional, not automatic (best-of.md:41).
- **agy kill-switch**: `PP_DISABLE_AGY=1` globally disables all agy interactions (judge + generation) without removing code or config (default OFF — agy enabled; see Hard Rule 10). When set, the default cross-vendor pair is Codex (openai) + Claude (anthropic).
- **Teams**: 25 team pipelines under `.claude/teams/`, including `deep-reasoning-team` (Fable-5 capability-gated).
- **State**: `~/.pair-programmer/state.db` (SQLite WAL). Artifacts: `<project>/.harness/<run_id>/`.

See `README.md` for the full capability table and quick-start.

## Hard Rules

1. **Never edit `CONSTITUTION.md`.** It is the immortal head. `start_run` records the constitution SHA and marks the run `running` immediately (runs.ts:157–195); attestation to TheEights fires asynchronously after completed release (section 4.11) or retirement (section 4.16) runs only (runs.ts:2327–2364). The `/pp:run` driver surfaces SHA drift to the operator; `finalize_run` hard-blocks on required artifacts (PP-VG-2, runs.ts:1666), master-plan coverage (PP-VG-1, runs.ts:2012), and required missability checks (PP-VG-4, runs.ts:2031) — constitution-attestation is not in those required sets by default. Amendments are HITL-only via `/pp:constitution amend`.

2. **JUDGE-1 pin is inviolable.** The default cross-vendor judge is Codex `gpt-5.6-terra` at medium reasoning effort (`DEFAULT_MODELS.codex_critique`), pinned by `CONSTITUTION.md` Article V as amended 2026-09-03 (SHA `5df284cb`, superseding `13b4fa18` and `2f40cda6`). The same article pins the default agy judge `gemini-3.8-flash-medium` and the escalated lanes `gpt-5.6-sol` / `gemini-3.1-pro-high`. Do not change the defaults; JUDGE-1a permits only an explicit, allow-listed, ledger-recorded operator override (source + reason on the verdict, never inferred from prose, never downgrading a cross-vendor gate). Further amendments are HITL-only via `/pp:constitution amend`.

3. **Gate judge policy is enforced by the driver and judge-router, not the daemon.** `startStage` and `finalizeStage` do not check vendor readiness or gate type (runs.ts:309). The cross-vendor requirement at `spec`/`design`/`security`/`contract` gates is enforced by the `/pp:run` driver calling `gate_eligible_judges` → choosing the judge per `.claude/skills/judge-policy.md` → routing to `judge-cross-vendor` or `judge-same-vendor`. The daemon **records** verdicts (computing the `cross_vendor` flag from the two producers) and blocks on: (a) same producer + same model_id for non-agy (runs.ts:857), (b) TDD/artifact-validator/findings-closure readiness at `finalize_stage(passed)` (runs.ts:1022, 1399). It does NOT refuse a stage for an incomplete vendor matrix or wrong gate-tier — that refusal lives in the driver (run.md failure-handling section).

4. **Cross-vendor for Fable is team-config policy, not daemon-enforced.** `deep-reasoning-team.yaml` explicitly pins `judge.tier: cross_vendor` with `model_pref: codex` or `agy` — that is a policy choice in the team config. The daemon's only runtime block is the same-producer + same-model-id guard at runs.ts:857 (prevents identical-model self-judging for non-agy producers). Teams.ts:98 validates tier names only; a different Claude model judging a Fable-generated attempt is accepted by the daemon.

5. **Never write source files without an active run.** The `enforce-active-run` pre-tool hook (dispatcher.ts:268) requires an active run for Edit/Write/MultiEdit/NotebookEdit. It PERMITS: `.harness/` edits, `.claude/` edits, and any edit when `PP_ALLOW_AD_HOC=1`. It does not require an active stage or specific worktree path.

6. **`archive_winner_and_losers` refuses a smoke-failed winner** unless `PP_ALLOW_SMOKE_FAILED_WINNER=1` is set (best-of-n.ts:413). Returns `merge_status="smoke_failed"` when refused.

7. **No auto-escalation to Fable.** `fable` (`claude-fable-5`) is off the `TIER_ORDER` ladder; `shiftTier("opus", +1)` clamps at `opus` (config.ts:81). Fable is reached only via explicit operator config: (a) `/pp:team deep-reasoning-team`, (b) `generator.model_tier: fable` in a team yaml stage, or (c) a profile's `model_tier_policy.per_stage_override[<stage>]: fable`. There is no `--tier fable` CLI flag.

8. **Test deletion requires documented replacement in the same commit** (CONSTITUTION.md FORBIDDEN-3). Note: CONSTITUTION.md references `daemon/tests/` but the actual directory is `daemon/test/`. No automated guard enforces this — it is a human/review obligation.

9. **Governance precedence**: TheEights → AgentSmith → Hydra → pair-programmer. No run may override a TheEights or AgentSmith gate (CONSTITUTION.md Article II).

10. **agy is opt-out-able via `PP_DISABLE_AGY=1` (default OFF — agy enabled).** The flag is read by `agyEnabled()` (config.ts) and gated at two chokepoints: `doctor()`'s `vendors_configured.google` (runs.ts — cascades to the enforce-vendor-matrix hook, best-of-N preconditions, and `cross_vendor_ready`) and `listAllowedJudges()`'s producer pool (gates.ts — so `gate_eligible_judges` never hints at agy). All agy code, the `pp_agy` MCP registration, the judge agents, and team `model_pref: agy` hints stay intact — `gate_eligible_judges`' filtered `preferred_producers` is authoritative over `model_pref`. JUDGE-1 (Codex `gpt-5.6-terra`) is unaffected; Codex + Claude remains a valid cross-vendor pair. Unlike the legacy Gemini kill-switch (which carried a disabled default after the Gemini CLI subscription-login breakage), `PP_DISABLE_AGY` defaults OFF because agy authenticates via interactive Google Sign-In (system keyring) or a `GEMINI_API_KEY` / `GOOGLE_API_KEY` / `ANTIGRAVITY_API_KEY` headless env var, rather than depending on the API-key-only subscription login that broke the legacy Gemini CLI. Set it in `.claude/settings.local.json` to disable; unset (the default) to keep agy enabled.

## Engineering Standards

- **Language**: TypeScript (strict mode), Node 20+. Daemon in `daemon/src/`.
- **Build**: `cd daemon && npm run build` (runs `tsc`). Typecheck only: `npm run typecheck`.
- **Runtime**: Node built-in test runner (`node --test`). Key scripts in `daemon/package.json`:
  - `npm run build` — compile
  - `npm run typecheck` — type-check without emit
  - `npm test` — build + full suite (includes smoke tests; see Anti-Stall Test Rule)
- **Test layout**: `daemon/test/`
  - `*.unit.mjs` — self-contained unit tests: temp SQLite, direct imports from `dist/`, no live daemon or MCP peer
  - `*.smoke.mjs` — integration tests that spawn their own daemon; `eights-integration.smoke.mjs` additionally requires an external TheEights peer and skips cleanly when absent

## Working Agreements

### no-premature-done
Do not declare a task done until the **relevant** test suite passes AND `npm run build` exits clean. A single new test passing is not done — run the broader set of unit tests whose modules could be affected. A frozen contract in another module can break silently if only the new test is checked.

### ANTI-STALL TEST RULE (critical)
Write **self-contained unit tests** (`daemon/test/<name>.unit.mjs`): temp SQLite, direct imports from `dist/`, no live daemon, no MCP peer. They are fast and deterministic. Run them with:
```
node --test --test-timeout=60000 daemon/test/<name>.unit.mjs
```
**Prefer `*.unit.mjs` over `npm test` or `*.smoke.mjs` in automated agent contexts.** The `npm test` script includes `eights-integration.smoke.mjs` (needs an external TheEights peer) and `smoke.mjs` (spawns a daemon) — making the full suite slower and flakier for automated agents. Confirmed against `daemon/package.json` (the `test` script) and `daemon/test/eights-integration.smoke.mjs` (header: "spawns C:\AiAppDeployments\TheEights\daemon\dist\index.js").

### git-plumbing
In-flight git ops use `trackedExeca` (abortable on shutdown). Teardown-path git ops use `trackedExecaNoRefuse` (registered, not refused after seal). Destructive FS ops are guarded by `isShuttingDown()` — a shutdown-killed op must never trigger a destructive fallback. See `daemon/test/ws7-tracked-git.unit.mjs` for the test surface.

### parallel-default-sequential-fallback
Parallel Task dispatch is the default for best-of-N — `/pp:best-of` mandates parallel fan-out (best-of.md:20). On Windows/PowerShell, parallel spawn can be unreliable due to process-group limits and pipe contention; fall back to sequential dispatch if parallel hangs or produces incomplete results (run.md:170). Sequential is the fallback, not the default.

### correct-module-before-edit
Before editing a module, verify it is the one that actually implements the behavior — not a stale copy, compiled output, or similarly-named file. Editing the wrong module is a silent no-op.

### browser-verify
When a change affects the user's live project web UI, validate in a real browser via the browser-validator path before declaring done. Note: `127.0.0.1:7878` is a read-only JSON GET API for cross-session queries — it is not a browser UI (server.ts:2–8).

### concise-output
Large outputs should be written to a file with a short inline summary. Do not inline multi-thousand-line outputs — output-token truncation silently drops content.

## Security

- **Secret scanning**: the `enforce-no-secrets` pre-tool hook (dispatcher.ts:383) scans Edit/Write/MultiEdit/`archive_artifact` content before write. `archiveArtifact` also scans at the daemon level (runs.ts:2612). Credentials must be env vars — not hardcoded.
- **Constitution pin**: `start_run` records `CONSTITUTION.md` SHA on every run (runs.ts:160, 194). Replay and release/retirement attestation bind to this SHA.
- **MCP namespacing**: tool access is governed by separate MCP server namespaces (`pp_harness`, `pp_codex`, `pp_agy`) and client-side permission hooks in `.claude/settings.json`. The daemon does not enforce per-call RBAC internally.
- **Cross-vendor enforcement**: the daemon's runtime block is narrow — same producer + same model_id on a verdict is rejected for non-agy producers (runs.ts:857). The broader cross-vendor gate requirement (refusing to run when the vendor matrix is incomplete) is enforced by the driver via the `enforce-vendor-matrix` hook and run.md failure-handling, not by the daemon.

## Where To Read More

- `CONSTITUTION.md` — the immortal head. Governance precedence, invariants, forbidden ops.
- `README.md` — capabilities, quick-start, project layout, all commands.
- `taxonomy_blueprint.md` — the 16-section software development taxonomy.
- `.claude/commands/pp/` — the 19 slash commands (`run.md`, `team.md`, `best-of.md`, etc.).
- `.claude/skills/judge-policy.md` — tiered cross-vendor vs same-vendor judge policy (gate-type table, keyword upgrades, profile upgrades, Fable tier, escalated judging).
- `daemon/src/config.ts` — model tiers, judge defaults (`DEFAULT_MODELS`), `TIER_ORDER`, status constants.
- `daemon/src/mcp/harness-server.ts` — MCP tool surface (`start_run`, `start_stage`, `record_attempt`, `record_verdict`, `finalize_stage`, `finalize_run`, `archive_artifact`, `start_best_of_stage`, `archive_winner_and_losers`, etc.).
