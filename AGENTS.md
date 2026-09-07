# AGENTS.md — pair-programmer Cross-Tool Behavioral Contract

This file is the single source of truth for any AI agent (Claude Code, Codex, Antigravity (agy), Copilot, etc.) working inside the pair-programmer repo. Tool-specific shims (`CLAUDE.md`, etc.) import from this file.

## What pair-programmer Is

A TypeScript daemon + MCP server that wraps a **taxonomy-aware, best-of-N, cross-vendor-judged code-generation lifecycle** around every engineering task.

- **Standalone**: invoked via `/pp:run`, `/pp:best-of`, `/pp:team`, and 16 other slash commands in Claude Code; or via the GitHub Copilot CLI plugin.
- **As Hydra's engineering squad**: Hydra dispatches `DevTask` envelopes to the daemon over MCP; results return as `DecisionRecord` envelopes to TheEights.
- **Core lifecycle**: triage → profile detect → taxonomy map → stage loop (generate → judge → Reflexion ×1 on fail) → 56 missability checks → `PROJECT_MASTER.md` patch → finalize.
- **Model tiers** (source: `daemon/src/config.ts:CLAUDE_TIER_MODELS`): `haiku`, `sonnet`, `opus`, and `fable` (capability-gated, off the auto-escalation ladder — never reached by `shiftTier`; see Hard Rules).
- **Cross-vendor judge**: cross-vendor judging is mandated at **every** gate (`JUDGE-1`). Per-vendor lanes come from `JUDGE_MODEL_POLICY` in `daemon/src/config.ts` (the single source of truth; `DEFAULT_MODELS` is derived from it) — Codex default `gpt-5.6-terra` at medium reasoning effort, escalated `gpt-5.6-sol`; agy default `gemini-3.8-flash-medium`, escalated `gemini-3.1-pro-high`. The escalated lanes are opt-in (`escalate: true`, major-scope / last-resort only). agy joins as the **second Borda judge at N ≥ 3 whenever agy is enabled** — it is mandatory, not driver-optional; when `PP_DISABLE_AGY=1` the second judge is the other eligible cross-vendor lane and the run summary MUST state the substitution. Operator overrides of vendor / model / effort are permitted only under `JUDGE-1a` (allow-listed, source + reason recorded on the verdict, never inferred from prose).
- **agy kill-switch**: `PP_DISABLE_AGY=1` globally disables all agy interactions (judge + generation) without removing code or config (default OFF — agy enabled; see Hard Rule 10). When set, the default cross-vendor pair is Codex (openai) + Claude (anthropic).
- **Teams**: 25 team pipelines under `.claude/teams/`, including `deep-reasoning-team` (Fable-5 capability-gated).
- **State**: `~/.pair-programmer/state.db` (SQLite WAL, schema v10 — verdicts carry `judge_reasoning_effort` / `judge_model_source` / `judge_override_reason`). Artifacts: `<project>/.harness/<run_id>/`.

See `README.md` for the full capability table and quick-start.

## Hard Rules

1. **Never edit `CONSTITUTION.md`.** It is the immortal head. `start_run` records the constitution SHA and marks the run `running` immediately (runs.ts:157–195); attestation to TheEights fires asynchronously after completed release (section 4.11) or retirement (section 4.16) runs only (runs.ts:2327–2364). The `/pp:run` driver surfaces SHA drift to the operator; `finalize_run` hard-blocks on required artifacts (PP-VG-2, runs.ts:1666), master-plan coverage (PP-VG-1, runs.ts:2012), and required missability checks (PP-VG-4, runs.ts:2031) — constitution-attestation is not in those required sets by default. Amendments are HITL-only via `/pp:constitution amend`.

2. **JUDGE-1 pin is inviolable.** The default cross-vendor judge is Codex `gpt-5.6-terra` at medium reasoning effort (`DEFAULT_MODELS.codex_critique`), pinned by `CONSTITUTION.md` Article V as amended 2026-09-03 (SHA `5df284cb`, superseding `13b4fa18` and `2f40cda6`). The same article pins the default agy judge `gemini-3.8-flash-medium` and the escalated lanes `gpt-5.6-sol` / `gemini-3.1-pro-high`. Do not change the defaults; JUDGE-1a permits only an explicit, allow-listed, ledger-recorded operator override (source + reason on the verdict, never inferred from prose, never downgrading a cross-vendor gate). Further amendments are HITL-only via `/pp:constitution amend`.

3. **Gate judge policy is enforced by the driver and judge-router, not the daemon.** `startStage` and `finalizeStage` do not check vendor readiness or gate type (runs.ts:309). The cross-vendor requirement at **every** gate type (JUDGE-1, `CONSTITUTION.md` Article V as amended 2026-09-03) is enforced by the `/pp:run` driver calling `gate_eligible_judges` → choosing the judge per `.claude/skills/judge-policy/SKILL.md` → routing the **closing** verdict to `judge-cross-vendor`. `judge-same-vendor` remains available as a supplementary extra opinion, but a same-vendor-only verdict can never close a stage (JUDGE-2). The daemon **records** verdicts (computing the `cross_vendor` flag from the two producers) and blocks on: (a) same producer + same model_id for **every** producer, agy included (`recordVerdict`, runs.ts:1057), (b) TDD/artifact-validator/findings-closure readiness at `finalize_stage(passed)` (runs.ts:1022, 1399). It does NOT refuse a stage for an incomplete vendor matrix or wrong gate-tier — that refusal lives in the driver (run.md failure-handling section).

4. **Cross-vendor for Fable is team-config policy, not daemon-enforced.** `deep-reasoning-team.yaml` explicitly pins `judge.tier: cross_vendor` with `model_pref: codex` or `agy` — that is a policy choice in the team config. The daemon's runtime blocks in `recordVerdict` are narrow: (a) the judge model must be on the producer's `JUDGE_MODEL_POLICY.allowed_models` list (codex and agy only; the legacy `gemini` alias normalizes onto agy and is held to agy's list), (b) `judge_model_source` must justify the model — `default`/`escalated` must match the vendor pin, and `cli`/`team_yaml`/`hydra` require a `judge_override_reason` of ≥8 chars, and (c) the same-producer + same-model-id guard, which as of J4 applies to **every** producer including agy (the old `att.producer !== "agy"` exemption is gone — agy now has a distinct escalated id, so identical generator/judge ids are an unprovable self-judge there too). `teams.ts` no longer validates tier names only: `validateStageJudge` now also checks `judge.model` against the vendor's `JUDGE_MODEL_POLICY.allowed_models` (resolved from `model_pref`), rejects `judge.model` together with `judge.escalate: true` as mutually exclusive, requires `judge.escalate` to be a boolean, and rejects a `judge.model` pinned under `model_pref: claude` (Claude judges run through the Task() sub-agent path and carry no CLI model pin). A different Claude model judging a Fable-generated attempt is still accepted by the daemon.

5. **Never write source files without an active run.** The `enforce-active-run` pre-tool hook (dispatcher.ts:268) requires an active run for Edit/Write/MultiEdit/NotebookEdit. It PERMITS: `.harness/` edits, `.claude/` edits, and any edit when `PP_ALLOW_AD_HOC=1`. It does not require an active stage or specific worktree path.

6. **`archive_winner_and_losers` refuses a smoke-failed winner** unless `PP_ALLOW_SMOKE_FAILED_WINNER=1` is set (best-of-n.ts:413). Returns `merge_status="smoke_failed"` when refused.

7. **No auto-escalation to Fable.** `fable` (`claude-fable-5`) is off the `TIER_ORDER` ladder; `shiftTier("opus", +1)` clamps at `opus` (config.ts:81). Fable is reached only via explicit operator config: (a) `/pp:team deep-reasoning-team`, (b) `generator.model_tier: fable` in a team yaml stage, or (c) a profile's `model_tier_policy.per_stage_override[<stage>]: fable`. There is no `--tier fable` CLI flag.

8. **Test deletion requires documented replacement in the same commit** (CONSTITUTION.md FORBIDDEN-3). Note: CONSTITUTION.md references `daemon/tests/` but the actual directory is `daemon/test/`. No automated guard enforces this — it is a human/review obligation.

9. **Governance precedence**: TheEights → AgentSmith → Hydra → pair-programmer. No run may override a TheEights or AgentSmith gate (CONSTITUTION.md Article II).

10. **agy is opt-out-able via `PP_DISABLE_AGY=1` (default OFF — agy enabled).** The flag is read by `agyEnabled()` (config.ts) and gated at two chokepoints: `doctor()`'s `vendors_configured.google` (runs.ts — cascades to the enforce-vendor-matrix hook, best-of-N preconditions, and `cross_vendor_ready`) and `listAllowedJudges()`'s producer pool (gates.ts — so `gate_eligible_judges` never hints at agy). All agy code, the `pp_agy` MCP registration, the judge agents, and team `model_pref: agy` hints stay intact — `gate_eligible_judges`' filtered `preferred_producers` is authoritative over `model_pref`. JUDGE-1's Codex lane (`gpt-5.6-terra`) is unaffected; Codex + Claude remains a valid cross-vendor pair, and the second Borda judge at N ≥ 3 falls to that lane with the substitution stated in the run summary. Unlike the legacy Gemini kill-switch (which carried a disabled default after the Gemini CLI subscription-login breakage), `PP_DISABLE_AGY` defaults OFF because agy authenticates via interactive Google Sign-In (system keyring) or a headless API key, rather than depending on the API-key-only subscription login that broke the legacy Gemini CLI. **The only headless credential Antigravity's official docs document is `GEMINI_API_KEY`, alongside `"modelProvider": "gemini"` in `~/.gemini/antigravity-cli/settings.json`.** `GOOGLE_API_KEY` and `ANTIGRAVITY_API_KEY` are accepted by the daemon as fallbacks but are **not documented upstream** — prefer `GEMINI_API_KEY` and treat the other two as compatibility shims that may stop working without notice. Set it in `.claude/settings.local.json` to disable; unset (the default) to keep agy enabled.

## Engineering Standards

- **Language**: TypeScript (strict mode), **Node 22+**. Daemon in `daemon/src/`. The floor moved from 20 to 22 on
  2026-09-07: `npm test`'s unit portion is the glob `test/*.unit.mjs`, and glob expansion in `node --test`
  positional arguments is not available on Node 20 — npm runs scripts through `cmd.exe` on Windows, which does not
  expand it either, so on Node 20 the script would receive the pattern as a literal path and fail. Node 20 LTS is
  already past end-of-life, so this narrows nothing in practice.
- **Build**: `cd daemon && npm run build` (runs `tsc`). Typecheck only: `npm run typecheck`.
- **Runtime**: Node built-in test runner (`node --test`). Key scripts in `daemon/package.json`:
  - `npm run build` — compile
  - `npm run typecheck` — type-check without emit
  - `npm test` — build + full suite (includes smoke tests; see Anti-Stall Test Rule)
- **Test layout**: `daemon/test/`
  - `*.unit.mjs` — self-contained unit tests: temp SQLite, direct imports from `dist/`, no live daemon or MCP peer
  - `*.smoke.mjs` — integration tests that spawn their own daemon; `eights-integration.smoke.mjs` additionally requires an external TheEights peer and skips cleanly when absent

## Working Agreements

> **These are the canonical text.** Several of them are additionally **mirrored** into path-scoped Claude-only
> rules — `.claude/rules/daemon-tests.md` (scoped to `daemon/test/**`) and `.claude/rules/daemon-src.md`
> (scoped to `daemon/src/**`) — so Claude Code sees the file-specific detail again at the moment it is
> working in those directories. **Mirrored, never extracted:** Codex, Antigravity (agy) and Copilot read this
> file and do **not** read `.claude/rules/`, so moving a rule there instead of copying it would silently
> degrade three of the four tools. If a rule and its mirror ever disagree, **this file wins**, and
> `daemon/test/rules-mirror.unit.mjs` fails if a mirrored rule's substance disappears from here.
>
> One documented limitation, worth knowing before relying on the mirrors: **a path-scoped rule triggers when
> Claude *reads* a matching file, not on every tool use.** A session that only *writes* under
> `daemon/test/**` may never load the mirror at all. That is why the canonical text stays here, always
> loaded via `CLAUDE.md`'s `@AGENTS.md` import, rather than being moved.


### no-premature-done
Do not declare a task done until the **relevant** test suite passes AND `npm run build` exits clean. A single new test passing is not done — run the broader set of unit tests whose modules could be affected. A frozen contract in another module can break silently if only the new test is checked.

### ANTI-STALL TEST RULE (critical)
Write **self-contained unit tests** (`daemon/test/<name>.unit.mjs`): temp SQLite, direct imports from `dist/`, no live daemon, no MCP peer. They are fast and deterministic. Run them with:
```
node --test --test-timeout=60000 daemon/test/<name>.unit.mjs
```
**Never open or migrate the live `~/.pair-programmer/state.db` from a test.** Use a temp database. Phase H
of the cc-standards-alignment campaign lost its own v10 migration test subject because a background daemon
opened the live file first and migrated it in place.

**Running the FULL suite needs a larger timeout:** use `--test-timeout=180000` for `daemon/test/*.unit.mjs`. `node --test` runs files concurrently, and `finalize-gates-a.unit.mjs` takes ~26-33 s alone, so it intermittently exceeds the per-test ceiling under parallel load — verified 341/1 fail at 60 s, 342/0 pass at 120 s, and passing again at 60 s on a re-run (GitHub #57). **120 s stopped being enough on 2026-09-07**, when Phase E of cc-standards-alignment added 10 suites (`no-dangling-pointers.unit.mjs`): 429/1 fail at 120 s with the same bare `'test failed'`, then 430/0 pass at 180 s (432/0 after the guard was hardened), and `finalize-gates-a.unit.mjs` passing alone at 60 s in between. The ceiling is a function of total parallel load, not of any one file, so it will need raising again as suites are added. The failure surfaces as a bare `'test failed'` at `:1:1` with no assertion text, so an agent following the single-file command above cannot distinguish this flake from its own regression. 60 s remains correct for one file.

**Prefer `*.unit.mjs` over `npm test` or `*.smoke.mjs` in automated agent contexts.** The `npm test` script includes `eights-integration.smoke.mjs` (needs an external TheEights peer) and `smoke.mjs` (spawns a daemon) — making the full suite slower and flakier for automated agents. As of 2026-09-07 its unit portion is the glob `node --test --test-timeout=180000 test/*.unit.mjs`, so a new `*.unit.mjs` file is picked up automatically; before that it was a hand-maintained list of filenames that had silently drifted to 32 of 52 files, omitting three guards that were declared must-run-in-CI. Do not reintroduce an explicit list. Confirmed against `daemon/package.json` (the `test` script) and `daemon/test/eights-integration.smoke.mjs` (header: "spawns C:\AiAppDeployments\TheEights\daemon\dist\index.js").

### git-plumbing
In-flight git ops use `trackedExeca` (abortable on shutdown). Teardown-path git ops use `trackedExecaNoRefuse` (registered, not refused after seal). Destructive FS ops are guarded by `isShuttingDown()` — a shutdown-killed op must never trigger a destructive fallback. See `daemon/test/ws7-tracked-git.unit.mjs` for the test surface.

### parallel-default-sequential-fallback
Parallel Task dispatch is the default for best-of-N — `/pp:best-of` mandates parallel fan-out (best-of.md:20). On Windows/PowerShell, parallel spawn can be unreliable due to process-group limits and pipe contention; fall back to sequential dispatch if parallel hangs or produces incomplete results (run.md:271-277). Sequential is the fallback, not the default.

### correct-module-before-edit
Before editing a module, verify it is the one that actually implements the behavior — not a stale copy, compiled output, or similarly-named file. Editing the wrong module is a silent no-op.

### no-vacuous-assertions

Five vacuity classes have shipped in this repo and each was caught by a cross-vendor judge, not by review.
Every one of them passed a review first.

1. **An assertion whose own source satisfies the pattern it searches for.** Assemble forbidden literals at
   runtime from fragments and self-check the test file itself.
2. **A scan that visits zero files and passes.** Assert non-emptiness on **the collection actually
   iterated**, never on a correlate. One shipped assertion guarded a counter incremented *before* the
   filters while the assertions iterated the post-filter list.
3. **A fixture that exercises `node:assert` rather than the function under test.** `assert.ok(0 > 0)` on a
   hand-built empty `Set` shipped once. So did a whole falsification block that inlined a *copy* of each
   check's regex and asserted it against a string literal — passing by exercising V8's regex engine, so
   that deleting every real check would have left it green.
   **The structural remedy: make each check a named function, and have the real test and its falsification
   fixture both call that one function.** Then a red fixture is evidence about the check rather than about
   JavaScript. The test that a falsification block is real: break the check and confirm the fixture goes
   red, naming the defect.
4. **An absence assertion whose fixture cannot produce the condition denied.** A `node_modules` skip check
   scanned two roots that contain none.
5. **A filter or parser that silently discards exactly the inputs the assertion exists to find.** The worst
   of the five, because it satisfies all the others: a frontmatter parser dropped the malformed lines it
   existed to catch and reported zero violations. **If you filter or parse a population, assert on what you
   rejected too** — "nothing survived" and "nothing needed to" must be distinguishable outcomes, and a
   falsifiability fixture whose input the filter drops proves nothing.

**Derive every count from the filesystem or the database.** Six wrong hardcoded counts have shipped here.

**Every positive invariant needs a falsifiability proof** — a mutation that turns it red — via a
temp-directory or in-memory fixture. **Never mutate a real tracked file from inside the suite.** If you
mutate one out of band, verify it byte-identical afterward with a checksum, and do **not** use
`git checkout --` to revert it: that discards uncommitted work, which has already happened once.

### schema-change-is-two-objects

Adding a table or column is **two** edits plus a version bump, not one:

- add it to **`SCHEMA_SQL`** (`daemon/src/db/schema.ts`) so a **fresh** database has it;
- add it to the **migration** (`daemon/src/db/database.ts`) so an **existing** database gets it;
- bump **`SCHEMA_VERSION`** — earlier migrations shipped without bumping it and stayed at 7 until v10 had to
  reconcile the gap in one step;
- mirror it into **`daemon/src/db/schema.sql`**, the human-readable copy, which has drifted from
  `schema.ts` before and is guarded only by a narrow column check.

Migrations MUST be **additive, guarded** (`IF NOT EXISTS` / `PRAGMA table_info`), **idempotent**, and MUST
rewrite no existing row. Prove it against a fixture built from the *previous* schema, never against the live
database — and separately prove that a **fresh** database built from the declaration alone carries every
object, because that is the assertion which catches a migration-only column. A column present in the
migration but absent from the declaration means an upgraded install works and a new install throws; that
shipped once and was caught by a judge.

### never-manufacture-a-ledger-row

`attempts` records **generation**. `verdicts` record **judgement**. Neither is a place to record that
something merely happened — that is what `execution_events` is for, and it is deliberately a separate table
whose writer touches neither. **A failed vendor critique is not a generation attempt**; conflating them
makes the attempt count a lie.

The same discipline applies to provenance generally: where a true value is not recoverable, record that it
is **unknown** rather than guessing it. `janitor`'s `untyped_producer_attempts` report is the pattern — it
names rows whose producer cannot be recovered and mutates nothing.

### browser-verify
When a change affects the user's live project web UI, validate in a real browser via the browser-validator path before declaring done. Note: `127.0.0.1:7878` is a read-only JSON GET API for cross-session queries — it is not a browser UI (server.ts:2–8).

### concise-output
Large outputs should be written to a file with a short inline summary. Do not inline multi-thousand-line outputs — output-token truncation silently drops content.

## Security

- **Secret scanning**: the `enforce-no-secrets` pre-tool hook (dispatcher.ts:383) scans Edit/Write/MultiEdit/`archive_artifact` content before write. `archiveArtifact` also scans at the daemon level (runs.ts:2612). Credentials must be env vars — not hardcoded.
- **Constitution pin**: `start_run` records `CONSTITUTION.md` SHA on every run (runs.ts:160, 194). Replay and release/retirement attestation bind to this SHA.
- **MCP namespacing**: tool access is governed by separate MCP server namespaces (`pp_harness`, `pp_codex`, `pp_agy`) and client-side permission hooks in `.claude/settings.json`. The daemon does not enforce per-call RBAC internally.
- **Cross-vendor enforcement**: the daemon's runtime block is narrow — same producer + same model_id on a verdict is rejected for ALL producers (agy included since J4; `recordVerdict`, runs.ts:1057), with producers compared after `normalizeProducer` so the legacy `gemini` alias cannot evade it. `recordVerdict` additionally refuses a `judge_model_id` outside the producer's `JUDGE_MODEL_POLICY.allowed_models`, refuses a `judge_model_source` of `default`/`escalated` whose id does not match that vendor's pin, and requires a `judge_override_reason` of ≥ 8 characters for the `cli` / `team_yaml` / `hydra` override channels (JUDGE-1a). The broader cross-vendor gate requirement (refusing to run when the vendor matrix is incomplete) is enforced by the driver via the `enforce-vendor-matrix` hook and run.md failure-handling, not by the daemon.

## Where To Read More

- `CONSTITUTION.md` — the immortal head. Governance precedence, invariants, forbidden ops.
- `README.md` — capabilities, quick-start, project layout, all commands.
- `taxonomy_blueprint.md` — the 16-section software development taxonomy.
- `.claude/commands/pp/` — the 19 slash commands (`run.md`, `team.md`, `best-of.md`, etc.).
- `.claude/skills/judge-policy/SKILL.md` — tiered cross-vendor vs same-vendor judge policy (gate-type table, keyword upgrades, profile upgrades, Fable tier, escalated judging).
- `daemon/src/config.ts` — model tiers, judge defaults (`DEFAULT_MODELS`), `TIER_ORDER`, status constants.
- `daemon/src/mcp/harness-server.ts` — MCP tool surface (`start_run`, `start_stage`, `record_attempt`, `record_verdict`, `finalize_stage`, `finalize_run`, `archive_artifact`, `start_best_of_stage`, `archive_winner_and_losers`, etc.).

## Coding conventions

- **Reported values must derive from the decision source of truth, not a proxy.** When a reported field depends on a decision or state change (e.g., `resumed: true` from `--continue` argv, `override_source: "cli"` from an override decision), read from the decision source itself, not from a correlate (e.g., session-row existence). Proxy derivation masks state drifts and creates silent data integrity defects. See `antigravity-server.ts:228` (agy lane), `codex-server.ts:446` (codex lane), and GitHub #56 (`override_source`).

## Notes from the harness

- Run `run_7tbXaLHTJU1x` — appended to `docs/agents-md-history.md`.
