# Pair Programmer Harness — Implementation Plan

## Context

You want a multi-agent coding harness in which **Claude Code drives**, **Codex CLI (GPT)** and **Gemini CLI** are callable as sub-agents, and **every artifact a user asks for is validated by a different model**. You want on-demand **best-of-N** and pre-composed **specialized teams**, plus **taxonomy adherence on every task** referencing the 16-section blueprint at `<repo-root>\taxonomy_blueprint.md`. After review, the plan also covers all 16 taxonomy sections (not just code-shaped ones), supports the 10 project-type deviations from Section 7, ships standard-aligned judge rubrics (WCAG/ASVS/C4/OpenAPI/SLSA/NIST AI RMF), maintains a per-project master plan that runs patch over time, exposes the 10 governance review forums as commands, and uses Claude Code hooks systematically — not as nudges — to keep agents aligned.

This plan turns that request into a concrete build: a Claude Code plugin (the user-facing driver), a local TypeScript daemon (durable orchestration state), and two thin MCP wrappers (Codex + Gemini), with verification gates at every stage and Reflexion-style retry once before surfacing.

**Key research findings that shaped the design:**
- Both Codex CLI and Gemini CLI run natively on Windows 11, support headless JSON output, and act as MCP server + client. (Confirmed: `developers.openai.com/codex/cli`, `geminicli.com/docs`.)
- MetaGPT-style role pipelines (PM → Architect → Engineer → QA) outperform flat agent teams on coding (85.9% Pass@1, ICLR 2024). Single-judge LLM-as-Judge is well-known to suffer **position bias**, **verbosity bias**, and **self-bias**; cross-vendor judges reduce error correlation but introduce position bias unless candidate order is randomized.
- Reflexion (arXiv 2303.11366) gains 10–20 pts on coding tasks; gains plateau by retry 2 and self-reflection without an external loop *entrenches* errors.
- Anthropic's "agent teams" + MCP-server pattern is the canonical way to orchestrate from Claude Code.

## Locked decisions (from the Q&A)

| Decision | Choice |
|---|---|
| Form factor | **Hybrid**: Claude Code plugin + local TypeScript daemon |
| Validator policy | **Tiered**: cross-vendor for spec/design/security/contract gates; same-vendor-different-model OK for code-style/docs/lint |
| Activation model | **User-explicit slash commands** (`/pp:run`, `/pp:best-of N`, `/pp:team <name>`); default = single-agent + validator |
| Taxonomy enforcement | **Every task** maps to ≥1 of the 16 blueprint sections; every task produces or updates a corresponding artifact (smallest unit = changelog entry) |
| Retry policy | **Reflexion ×1** then surface all attempts + verdicts |
| Cost posture | **Track but don't enforce** dollars/tokens; **anti-runaway loop ceiling DOES enforce** (different concern) |
| State storage | **Daemon-managed SQLite** at `~/.pair-programmer/state.db`; per-project artifacts at `<project>/.harness/<run_id>/` |

## Architecture at a glance

```
USER
  │  /pp:run … /pp:best-of N … /pp:team feature-team … /pp:review <forum> …
  ▼
Claude Code (driver)        ── .claude/skills, agents, commands, hooks, teams, profiles, rubrics
  │  MCP stdio
  ▼
pp-daemon (Node)            ── ~/.pair-programmer/state.db, logs, sandboxes, worktree manager
  ├── pp.harness.*  (orchestration: runs, stages, attempts, verdicts, gates, budgets, teams, profiles, master plan)
  ├── pp.codex.*    (wraps `codex exec --json --output-schema …`)
  └── pp.gemini.*   (wraps Gemini CLI headless JSON mode)

per-project:
  <project>/.claude/                  (plugin)
  <project>/.harness/<run_id>/        (per-run artifacts)
  <project>/.harness/profile.yaml     (project-type profile)
  <project>/PROJECT_MASTER.md         (Section 9 master plan, patched by runs)
```

Three MCP servers, all spawned by the same `pp-daemon` binary (different entrypoints), registered in `.claude/.mcp.json`. Tool names are **namespaced** (`pp.codex.generate`, `pp.gemini.critique`) to prevent vendor-tool collision in Claude Code's tool registry.

## Daemon design

**Language**: TypeScript on Node 20+. Rationale: Claude Code is itself Node, the official MCP SDK is most mature in TS, `better-sqlite3` gives synchronous SQLite (no FFI), and `execa` handles Windows child-process quirks cleanly.

**Process model**: stdio MCP server spawned per Claude Code session; an optional read-only HTTP control plane on `127.0.0.1:7878` for cross-session `/pp:status` queries (lazily started, 10-min idle shutdown). No Windows service — keep install friction low.

**Key dependencies**: `@modelcontextprotocol/sdk`, `better-sqlite3` (with **WAL mode**), `zod`, `pino`, `execa`, `nanoid`, `yaml`, `@playwright/test` (for visual regression on the design-system gates).

**Concurrency safety**:
- SQLite in WAL mode + `BEGIN IMMEDIATE` around `start_run`
- Per-project advisory file lock at `<project>/.harness/.lock`
- Each run row tagged with a `session_id` (derived from Claude Code's transcript path)
- Startup janitor marks `running` rows older than the configured stale threshold as `crashed`, sweeps orphaned worktrees, surfaces them on next `/pp:status`

**MCP tool surface** (all `pp.harness.*`):

| Tool | Purpose |
|---|---|
| `start_run` | Allocate `run_id`, artifact dir, taxonomy mapping slot. Inputs: `request_text`, `mode` (`single`\|`best_of`\|`team`\|`review`), `n`, `team`, `forum`. |
| `get_profile` | Read `<project>/.harness/profile.yaml`; returns project type + active gate overrides. |
| `record_taxonomy_mapping` | Persist mapping output (which sections 4.x apply + required artifact stubs + missability checks owed). |
| `start_stage` | Open a stage row (`spec`, `design`, `architecture`, `contracts`, `code`, `security`, `tests`, `docs`, `release`, `ops`, `data`, `ux`, `design_system`, `release_plan`, `retirement`, `taxonomy_close`). |
| `gate_eligible_judges` | **Critical**: given `gate_type` + prompt-content keywords + active profile, returns `{required_cross_vendor: bool, allowed_judges: […], rubric_id: …}`. Driver MUST call before any judge. |
| `get_rubric` | Returns the rubric markdown + scoring schema for a given `rubric_id` (e.g., `wcag-2.2-aa`, `owasp-asvs-l1`, `c4-system-context`, `openapi-3.1-stability`, `slsa-l2`, `nist-ai-rmf-govern`, `rfc-2119-normative`). |
| `record_attempt` | Log generator output ref, tokens, cost, wall_ms, retry_index. |
| `record_verdict` | Log judge output, rubric ref, outcome, critique, score breakdown, `cross_vendor` flag. |
| `retry_with_critique` | Bundle critique + original prompt for the Reflexion ×1 retry. Daemon enforces ×1 invariant (third call rejected). |
| `finalize_stage` | Close a stage with winner attempt_id (or status=`surfaced`). |
| `run_missability_checks` | Runs Section 6's 20-item check library against the run's artifacts before `finalize_run`. Returns gaps. |
| `finalize_run` | Close run, write summary artifact, **patch `PROJECT_MASTER.md`** with the run's contributions. |
| `master_plan_status` | Returns coverage of the 20-section master plan template + Section 10 completion checklist results. |
| `list_runs` / `get_run` | Read state. |
| `budget_status` | Returns rolling tokens & dollars per scope. Never blocks. |
| `loop_ceiling_status` | Returns validator-call count for the run; enforces the anti-runaway ceiling. |
| `team_get` / `team_list` | Resolve team yaml: project → user → built-in. |
| `archive_artifact` | Write bytes, register hash + path. Compares on-disk hash vs stored hash on rewrite (manual-edit detection). |
| `doctor` | Health check: API keys present, sub-CLIs installed and version-pinned, vendor matrix sufficient for cross-vendor gates, profile valid, master plan reachable. |

**SQLite schema (key tables)**:
```
runs(id, session_id, project_path, request_text, team, mode, forum, n, status,
     profile_snapshot_json, taxonomy_mapping_json, head_sha, tree_dirty_hash,
     cli_versions_json, started_at, finished_at)
stages(id, run_id, kind, gate_type, status, winner_attempt_id, started_at, finished_at)
attempts(id, stage_id, producer, model_id, prompt_hash, artifact_path,
         tokens_in, tokens_out, cost_usd, wall_ms, retry_index, parent_attempt_id, status, created_at)
verdicts(id, attempt_id, judge_producer, judge_model_id, rubric_id, outcome,
         critique_md, score_json, cross_vendor, created_at)
artifacts(id, run_id, stage_id, taxonomy_section, kind, path, sha256, bytes, created_at)
missability_checks(id, run_id, check_id, status, evidence_path, created_at)
master_plan_patches(id, run_id, section, kind, prev_sha, new_sha, applied_at)
budgets(scope PRIMARY KEY, tokens_in, tokens_out, cost_usd, updated_at)
teams(name PRIMARY KEY, origin, yaml_text, loaded_at)
sub_cli_sessions(project_path, agent, session_id, last_used_at)
rubrics(id PRIMARY KEY, kind, version, markdown, schema_json, source_url)
```

`runs` captures HEAD SHA, dirty-tree hash, profile snapshot, and CLI versions so a run can be **replayed** later.

## External CLI MCP wrappers

Both shipped inside `pp-daemon` as alternate entrypoints (`pp-daemon mcp-codex`, `pp-daemon mcp-gemini`).

**Workspace isolation per attempt**: each generator call gets its own ephemeral **git worktree** at `<project>/.harness/<run_id>/<stage>/<candidate>/` (created via `git worktree add`). On Windows, falls back to a copy-based workspace if worktrees fail. Sub-CLI runs with `--cd` pointed at the worktree. **Only the winner's worktree is merged back** to the main tree; losers are archived under `losers/`. This eliminates the file-system race when best-of-N runs concurrent edits.

**Sub-CLI session continuity**: daemon tracks `(project_path, agent) → session_id` in `sub_cli_sessions` and passes the resume flag (Codex `--resume`, Gemini session UUID) on follow-up turns. If session is missing or version-mismatched, daemon synthesizes a "context recap" prompt rather than starting fresh silently.

**Codex MCP tools** (`pp.codex.*`): `generate`, `critique`. Wrap `codex exec --json --output-schema <file> --model <id> --sandbox <policy> --cd <worktree>`. Cost from `task_complete` event × `~/.pair-programmer/prices.json`.

**Gemini MCP tools** (`pp.gemini.*`): `generate`, `critique`. Wrap `gemini --model <id> --prompt-file <path> --output-format json`. Cost from `usageMetadata`.

**Version pinning**: daemon reads `gemini --version` and `codex --version` at session start; gates on a known-good range; falls back to text-mode + zod parse if newer than tested range.

**Network egress posture**: sub-CLI sandboxes default to **read-only filesystem + no network egress**. Promote to `workspace-write` only after the driver explicitly requests it for an editing stage. This is a hardening default against prompt-injection-driven exfiltration.

**Prompt-injection envelope**: any file content the driver passes through to a sub-CLI is wrapped in an `<untrusted-content>` XML envelope by the daemon, with explicit instructions to the sub-CLI to treat it as data, not instructions. Secret-scan (regex over common API-key patterns) runs on every artifact before it's written to `.harness/`.

## Project profiles (Section 7 deviations)

Per-project `<project>/.harness/profile.yaml` declares the project type, which loads gate overrides:

| Profile | Gate adjustments |
|---|---|
| `web-ui` | UX-team gates required; WCAG 2.2 AA rubric on UI artifacts; screen-state matrix (8 states) required; visual regression gate on UI changes; localization plan required if shipped to >1 locale |
| `api-platform` | Contract gates required (OpenAPI/AsyncAPI rubric); versioning/compatibility ADR required; SDK ergonomics if SDKs ship |
| `internal-tool` | Workflow-fit + admin-UX gates; audit-log spec required; lighter UX rubric |
| `enterprise` | SBOM + supply-chain (SLSA) gate required; PIA/DPIA on data-touching changes; control-matrix on every security gate |
| `ai-agentic` | NIST AI RMF rubric; eval-suite gate required; tool-permission matrix; HITL workflow doc; data-egress review |
| `mobile` | Offline-state matrix required; permission UX; crash-reporting plan; store-rollout plan |
| `sdk` | SemVer policy required; deprecation policy required; sample-app artifact required |
| `data-product` | Metric dictionary + lineage map required; freshness SLAs; reconciliation plan |
| `embedded` | Device lifecycle + fleet-update plan; failure-safe policy; edge-observability spec |
| `non-ui-cli` | Operator-experience gate; runbook + retry/backoff doc required |

Profile is read at run start and embedded into `runs.profile_snapshot_json` for replay. Absence of profile.yaml = generic mode (current locked decisions only).

## Standard-aligned rubrics

Shipped at `.claude/rubrics/<id>.md` and registered in the daemon's `rubrics` table. Each is a structured markdown rubric with a JSON scoring schema. Used by `gate_eligible_judges` to pick the right one per stage.

| Rubric id | Source | Used at gate |
|---|---|---|
| `wcag-2.2-aa` | W3C WCAG 2.2 AA | UX / design-system stages on `web-ui` profile |
| `owasp-asvs-l1` | OWASP ASVS L1 | security stages |
| `owasp-asvs-l2` | OWASP ASVS L2 | security stages on `enterprise` |
| `c4-system-context` | C4 model | architecture stages |
| `openapi-3.1-stability` | OpenAPI 3.2 + compat policy | contracts stages on `api-platform` / `sdk` |
| `asyncapi-3.1-stability` | AsyncAPI 3.1 | event-contract stages |
| `slsa-l2` | SLSA L2 | supply-chain gate on `enterprise` |
| `slsa-l3` | SLSA L3 | supply-chain gate on regulated contexts |
| `sbom-cyclonedx` | CycloneDX | supply-chain gate |
| `nist-ai-rmf-govern` | NIST AI RMF Govern function | ai-controls-team govern stage |
| `nist-ai-rmf-measure` | NIST AI RMF Measure | ai-controls-team eval-suite stage |
| `rfc-2119-normative` | IETF RFC 2119 | spec-author outputs (MUST/SHOULD/MAY consistency) |
| `metric-dictionary` | DAMA-DMBOK + practice | `data-product` data-stages |

Rubrics are versioned; `rubric_id` is recorded on every verdict so a run is reproducible against the rubric version it was judged with.

## Missability gate library (Section 6)

Before `finalize_run`, the daemon runs the 20-item check library against the run's artifacts. Each check is a small agent-driven inspector that emits `{check_id, status: pass|fail|n/a, evidence_path}`. Persisted in `missability_checks`.

```
1.  nfrs-declared              latency/throughput/availability/recovery/cost ceilings present
2.  authz-model                actor → object → condition rules written
3.  ui-error-empty-loading     UI changes carry the 8-state matrix
4.  workflow-exceptions        manual override paths + approval flows mapped
5.  retention-deletion         data classification + retention rule per new field
6.  schema-evolution           migration + backfill + rollback compatibility documented
7.  analytics-semantics        new events have name + business definition + lineage
8.  operational-ownership      who owns dashboards/alerts/escalation post-launch
9.  feature-flag-lifecycle     flags have created/observe/retire metadata
10. rollout-reversibility      rollout strategy + kill switch + comms
11. test-data-management       fixture provisioning + masking + refresh + version
12. third-party-failure        outage / quota / rate-limit / contract-change / bad-data plays
13. doc-ownership              runbook/api/migration/release-notes assigned to owner
14. supportability             correlation IDs + admin tools + diagnostic states
15. accessibility-localization a11y + i18n acknowledged for UI changes
16. security-review-timing     threat model produced before code, not after
17. supply-chain-integrity     SBOM updated + provenance retained (`enterprise`+)
18. deprecation-sunset         exit path declared at launch, not "future work"
19. decision-logging           ADR/decision-log entry for non-trivial choices
20. ai-evals-hitl              eval suite + HITL escalation rule (`ai-agentic`)
```

A failed check downgrades `finalize_run` to `surfaced` with the evidence path; user sees exactly which item is missing.

## Master plan integration (Section 9)

A per-project `<project>/PROJECT_MASTER.md` follows the Section 9 20-section template (Executive summary → Deprecation & retirement plan + Appendices). On `finalize_run`, the run-finalizer agent:

1. Reads `PROJECT_MASTER.md`.
2. For each artifact produced this run, identifies the master-plan section it belongs in.
3. Writes a patch (sha-tracked in `master_plan_patches`) with cross-references to the run's artifacts under `.harness/<run_id>/`.
4. If the document doesn't exist yet, scaffolds it from the template on first run.

`/pp:checklist` runs Section 10's 15-item completion checklist against the current master plan and reports gaps. `/pp:taxonomy` shows section coverage. The master plan is the durable cross-run memory of the project.

## Review-mode commands (Section 8 governance forums)

`/pp:review <forum> [--scope <files|stage|run>]` runs a focused multi-agent sweep with the right rubric. Each forum maps to a fixed pipeline:

| `<forum>` | What it produces |
|---|---|
| `framing` | Problem statement, evidence, success metrics; gate: rfc-2119-normative |
| `scope` | PRD + acceptance criteria + NFRs; gate: rfc-2119-normative + missability(1,2) |
| `design` | Flows, states, components, a11y; gate: wcag-2.2-aa + missability(3,15) |
| `architecture` | C4 + ADRs + topology; gate: c4-system-context + missability(6) |
| `contract` | OpenAPI/AsyncAPI + versioning rule; gate: openapi/asyncapi-stability + missability(12) |
| `threat` | Threat model + control mapping; gate: owasp-asvs + missability(16,17) |
| `test-readiness` | Test strategy + coverage + envs; gate: missability(11,20) |
| `release-readiness` | Rollout + rollback + comms; gate: missability(8,9,10,13) |
| `incident` | Postmortem + corrective actions; gate: rfc-2119-normative on actions |
| `service` | SLO + incidents + usage + cost; gate: missability(8,12,14) |

Each review writes its outputs to `<project>/.harness/<run_id>/review-<forum>/` and patches `PROJECT_MASTER.md`.

## Claude Code plugin layout

```
<project>/.claude/
  .mcp.json                         # registers harness, codex, gemini stdio MCP servers
  skills/
    pair-programmer.md              # master skill: lifecycle, taxonomy adherence, Reflexion ×1, judge tiers
    taxonomy-adherence.md           # reusable policy text injected into every stage
    judge-policy.md                 # tiered cross-vendor vs same-vendor rules verbatim
    artifact-conventions.md         # file layout under .harness/<run_id>/
    rubric-application.md           # how to invoke a rubric and emit structured scores
    profile-aware-gating.md         # how profile.yaml modifies gates
    master-plan-patching.md         # run → master plan patch protocol
  agents/
    triage.md                       # cheap classifier: trivial | standard | major (sets gate strictness)
    taxonomy-mapper.md              # request → sections 4.1..4.16 + artifact stubs + missability owed
    profile-loader.md               # loads <project>/.harness/profile.yaml + applies overrides
    spec-author.md                  # PRD / feature-spec (4.3) with RFC 2119 enforcement
    architect.md                    # ADRs, C4 sketches (4.6)
    api-designer.md                 # OpenAPI / AsyncAPI contracts (4.7)
    engineer.md                     # code patches; primary=codex, fallback=claude
    test-strategist.md              # test plan, contract tests (4.10)
    security-reviewer.md            # threat model, OWASP ASVS gate (4.9)
    docs-author.md                  # changelog, runbooks, release notes (4.13)
    designer.md                     # UX (uses frontend-design skill); IA, flows, screen-state matrix, content guide
    design-system-curator.md        # tokens, component specs, component preview
    visual-regression-runner.md     # Playwright before/after screenshots + diff
    data-modeler.md                 # entities/ERD/lineage/retention/migration (4.5)
    release-planner.md              # rollout/rollback/migration/comms (4.11)
    ops-author.md                   # SLOs, runbooks, alerts, telemetry (4.12)
    governance-author.md            # RACI, decision logs, review forums (4.14)
    ai-controls-author.md           # AI system spec, evals, tool perms, HITL (4.15)
    retirement-planner.md           # EOL plan, sunset comms, archive policy (4.16)
    strategy-author.md              # vision brief, business case, OKRs, kill-criteria (4.1)
    discovery-researcher.md         # research brief, journeys, glossary, workflows (4.2)
    judge-router.md                 # calls pp.harness.gate_eligible_judges; picks judge agent + rubric
    judge-cross-vendor.md           # MUST use vendor different from generator
    judge-same-vendor.md            # different model, same vendor
    reflexion-coach.md              # bundles critique + original prompt for the single retry
    missability-inspector.md        # runs the 20-item Section-6 check library
    master-plan-patcher.md          # writes the run's contributions into PROJECT_MASTER.md
    run-finalizer.md                # writes summary, archives losers, calls finalize_run
  commands/
    pp:run.md                       # /pp:run <request>           default single-agent + validator
    pp:best-of.md                   # /pp:best-of <N> <request>   N parallel generators + judge
    pp:team.md                      # /pp:team <name> <request>   uses team yaml
    pp:review.md                    # /pp:review <forum> [scope]  governance review pipeline
    pp:checklist.md                 # /pp:checklist               Section 10 completion check
    pp:taxonomy.md                  # /pp:taxonomy [run_id]       coverage view
    pp:status.md                    # /pp:status [run_id]
    pp:retry.md                     # /pp:retry <run_id> <stage>
    pp:gate.md                      # /pp:gate <run_id> <stage>
    pp:budget.md                    # /pp:budget [scope]
    pp:teams.md                     # /pp:teams                   list available teams
    pp:profile.md                   # /pp:profile                 show / edit project profile
    pp:rubrics.md                   # /pp:rubrics                 list rubrics + show one
    pp:master.md                    # /pp:master                  open / scaffold PROJECT_MASTER.md
    pp:doctor.md                    # /pp:doctor                  first-run health check
    pp:replay.md                    # /pp:replay <run_id>         reconstruct prompts + versions
  hooks: wired in `.claude/settings.json` (canonical). All 24 hook handlers
         live in `daemon/src/hooks/dispatcher.ts`; see the *Hook catalog (full)*
         section below for behavior. Settings.json is the single source of
         truth — no per-hook .json files.
  rubrics/
    wcag-2.2-aa.md
    owasp-asvs-l1.md
    owasp-asvs-l2.md
    c4-system-context.md
    openapi-3.1-stability.md
    asyncapi-3.1-stability.md
    slsa-l2.md
    slsa-l3.md
    sbom-cyclonedx.md
    nist-ai-rmf-govern.md
    nist-ai-rmf-measure.md
    rfc-2119-normative.md
    metric-dictionary.md
  teams/
    feature-team.yaml               bug-fix-team.yaml             refactor-team.yaml
    security-review-team.yaml       ai-controls-team.yaml         docs-team.yaml
    strategy-team.yaml              discovery-team.yaml           ux-team.yaml
    design-system-team.yaml         data-team.yaml                release-team.yaml
    ops-team.yaml                   governance-team.yaml          retirement-team.yaml
  profiles/                         # built-in profile templates the user can copy into <project>/.harness/profile.yaml
    web-ui.yaml                     api-platform.yaml             internal-tool.yaml
    enterprise.yaml                 ai-agentic.yaml               mobile.yaml
    sdk.yaml                        data-product.yaml             embedded.yaml
    non-ui-cli.yaml
```

Per-run artifacts at `<project>/.harness/<run_id>/`:
```
request.md                taxonomy_mapping.json     profile_snapshot.yaml
spec/                     architecture/             contracts/
ux/                       design-system/            visual-regression/
data/                     security/                 code/
tests/                    docs/                     release-plan/
ops/                      governance/               ai-controls/
retirement/               losers/                   review-<forum>/
missability_checks.json   master_plan_patches.json  run.summary.md   run.json
```

## Hook catalog (full)

Hooks are the teeth that make taxonomy "every task" actually enforced — not nudges. All hooks call back into `pp.harness.*` MCP tools.

| Event | Name | Behavior |
|---|---|---|
| SessionStart | `daemon-up` | Spawn / health-check daemon. Block session start if daemon unreachable. |
| SessionStart | `vendor-matrix` | Run `pp.harness.doctor`; error loudly if cross-vendor configs missing. |
| SessionStart | `cli-version-pin` | Read `codex --version`, `gemini --version`; warn if outside tested range. |
| SessionStart | `master-plan-load` | If `PROJECT_MASTER.md` exists, summarize its 20-section status into context. |
| SessionStart | `surfaced-runs` | List any runs in `surfaced` state needing attention. |
| PreToolUse | `enforce-active-run` | Edit/Write to source code (outside `.harness/`) blocked unless an active run owns the stage. |
| PreToolUse | `enforce-vendor-matrix` | `pp.codex.*`/`pp.gemini.*` blocked when a cross-vendor gate is active and the matched vendor is missing. |
| PreToolUse | `enforce-sandbox-policy` | `pp.codex/gemini.generate` blocked unless `--sandbox` is appropriate for the active stage. |
| PreToolUse | `enforce-no-secrets` | Pre-write scan of artifact content (API key/.env regex set); block on match. |
| PreToolUse | `enforce-validator-gate` | Code-modifying tools blocked until prior stage's verdict = `pass`. |
| PreToolUse | `enforce-rfc2119-language` | Spec-stage outputs scanned for normative-language compliance; block on violation. |
| PostToolUse | `cost-tally` | After every `pp.codex/gemini.*`, append tokens + cost via `record_attempt`. |
| PostToolUse | `record-attempt` | Backstop for any direct CLI invocation; ensures DB completeness. |
| PostToolUse | `taxonomy-coverage-update` | After artifact write, update which 4.x sections are covered. |
| PostToolUse | `hash-artifact` | Store sha256 on write; mismatch on rewrite triggers manual-edit detection. |
| PostToolUse | `loop-ceiling-tally` | Count validator calls; warn at 80%, block at ceiling. |
| PostToolUse | `verdict-rubric-coverage` | Verify all rubric dimensions were scored on the latest verdict. |
| PostToolUse | `update-master-plan` | After `finalize_run`, patch `PROJECT_MASTER.md` and record the patch sha. |
| UserPromptSubmit | `taxonomy-nudge` | Coding-shaped prompt without `/pp:` prefix → suggest `/pp:run`. |
| UserPromptSubmit | `team-suggester` | Prompt pattern → suggest `/pp:team <name>`. |
| UserPromptSubmit | `risk-flag` | Security/concurrency/data-integrity keywords → pre-elevate to cross-vendor. |
| UserPromptSubmit | `surfaced-run-reminder` | Pending surfaced run? Remind user before starting fresh. |
| UserPromptSubmit | `profile-aware-nudge` | Profile = `enterprise` → remind about SBOM/audit; `ai-agentic` → remind about evals/HITL; etc. |
| Stop | `decision-log-required` | If turn made an architectural choice within an active run, must update decision log. |
| Stop | `summary-format-check` | End-of-turn summary follows expected pattern (what changed + what's next). |

## Specialized teams catalog (15 starter teams)

Teams live at `.claude/teams/<name>.yaml`. Resolution: project → user → built-in. Each team declares `stages` (kind, gate_type, generator binding, judge tier preference, rubric binding) and `taxonomy_required` (which 4.x sections must be covered) and `profiles_compatible` (which project profiles it's tuned for).

| Team | Pipeline | Taxonomy required |
|---|---|---|
| `strategy-team` | vision → business-case → okrs → kill-criteria → risk-register | 4.1 |
| `discovery-team` | research-brief → personas → journey-maps → workflow-maps → glossary | 4.2 |
| `feature-team` | spec → architecture → contracts → code → tests → docs | 4.3, 4.6, 4.7, 4.10, 4.13 |
| `bug-fix-team` | repro → code → tests → docs | 4.3, 4.10, 4.13 |
| `refactor-team` | invariants → code → tests | 4.3, 4.8, 4.10 |
| `ux-team` | ia-map → user-flows → screen-state-matrix → wireframes → content-guide → a11y-plan | 4.4 |
| `design-system-team` | tokens → component-specs → component-preview → contract-tests-vs-tokens | 4.4, 4.7 |
| `data-team` | entities-erd → lineage → retention-deletion → migration-plan → analytics-events | 4.5 |
| `security-review-team` | threat-model → control-mapping → docs | 4.9, 4.13 |
| `release-team` | rollout-plan → rollback-plan → migration-runbook → comms | 4.11, 4.13 |
| `ops-team` | slo-doc → telemetry-taxonomy → dashboards → alerts → runbooks | 4.12, 4.13 |
| `docs-team` | outline → draft → lint | 4.13 |
| `governance-team` | raci → decision-log → review-forums → cadence | 4.14 |
| `ai-controls-team` | ai-system-spec → eval-suite → tool-permissions → hitl-workflow → docs | 4.3, 4.9, 4.10, 4.13, 4.15 |
| `retirement-team` | eol-plan → migration-guide → archive-retention → sunset-comms → shutdown-checklist | 4.16 |

YAML sketch (representative — `ux-team`):
```yaml
name: ux-team
description: Information architecture, flows, screen states, content, accessibility.
profiles_compatible: [web-ui, mobile, internal-tool]
stages:
  - kind: ia-map
    gate_type: design
    generator: { agent: designer, primary: claude }       # uses frontend-design skill
    judge:     { tier: cross_vendor, rubric: c4-system-context }   # IA is structural
  - kind: user-flows
    gate_type: design
    generator: { agent: designer, primary: claude }
    judge:     { tier: cross_vendor, rubric: rfc-2119-normative }
  - kind: screen-state-matrix
    gate_type: design
    generator: { agent: designer, primary: claude }
    judge:     { tier: cross_vendor, rubric: wcag-2.2-aa }    # state coverage + a11y
  - kind: wireframes
    gate_type: design
    generator: { agent: designer, primary: claude }
    judge:     { tier: same_vendor, rubric: wcag-2.2-aa }
  - kind: content-guide
    gate_type: docs_polish
    generator: { agent: docs-author, primary: claude }
    judge:     { tier: same_vendor }
  - kind: a11y-plan
    gate_type: design
    generator: { agent: designer, primary: claude }
    judge:     { tier: cross_vendor, rubric: wcag-2.2-aa }
taxonomy_required: ["4.4"]
missability_required: [3, 15]
```

## Design system support (Bucket B)

Concrete additions for UI work:

- **`designer` sub-agent** invokes the `frontend-design` skill that's already on the host machine to produce distinctive, non-generic UIs. Output: artifact files under `<run_id>/ux/` and `<run_id>/design-system/`.
- **Screen-state matrix** (mandatory artifact for UI changes): table covering all 8 states (default / hover / focus / active / loading / empty / error / disabled) per component touched. Judge on the WCAG rubric.
- **Design tokens + component specs** (`design-system-team`): tokens at `.harness/<run_id>/design-system/tokens.json`; component specs include props, states, a11y attributes, content slots; **component preview** built (Storybook or framework-equivalent) and screenshot included.
- **Visual regression gate**: `visual-regression-runner` agent uses Playwright headless to capture before/after screenshots of touched routes/components. Diff and screenshots become a verdict input. Failing diffs require explicit acknowledgement in the verdict.
- **Permission-aware UX**: required artifact when changes touch role/permission interaction — table of `(role × action × resource × condition × visible-affordance)`.
- **Localization plan + responsive matrix**: required on `web-ui` and `mobile` profiles. Localization plan = string-ID inventory + locale list + RTL handling note. Responsive matrix = breakpoints × layouts × tested states.
- **`ux-team` runs in `--scope=ui` mode** by default (only walks UI-shaped requests); `feature-team` invokes ux-team automatically for stages that touch UI on `web-ui`/`mobile` profiles.

## Request lifecycle (with all enhancements)

```
USER  ──/pp:run "Add OAuth login to the admin dashboard"──▶  Claude Code (driver)
                                                               │
 SessionStart hooks fire (daemon, vendor-matrix, cli-pin, master-plan-load, surfaced-runs)
                                                               │
 ▶ Task → triage  → trivial | standard | major
 ▶ pp.harness.start_run(profile_snapshot=…)
 ▶ Task → taxonomy-mapper → sections + artifact stubs + missability owed
 ▶ pp.harness.record_taxonomy_mapping
                                                               │
 ┌─ FOR EACH stage in dependency order ────────────────────────┤
 │ ▶ pp.harness.start_stage(kind, gate_type)                   │
 │ ▶ pp.harness.gate_eligible_judges(gate_type, prompt_keywords, profile)
 │       → {required_cross_vendor, allowed_judges, rubric_id}  │
 │ ▶ Task → generator agent (codex/gemini/claude per binding)  │
 │   PreToolUse hooks gate this (active-run, vendor-matrix,    │
 │     sandbox-policy, no-secrets, validator-gate, rfc2119)    │
 │ ▶ pp.harness.record_attempt                                 │
 │   PostToolUse: cost-tally, hash-artifact, taxonomy-coverage │
 │ ▶ Task → judge-router → judge agent (with rubric) → verdict │
 │ ▶ pp.harness.record_verdict                                 │
 │   PostToolUse: verdict-rubric-coverage, loop-ceiling-tally  │
 │                                                             │
 │   pass → finalize_stage(winner) → next stage                │
 │   fail → reflexion-coach → retry once → judge → verdict     │
 │           pass: finalize / fail: finalize(surfaced) BREAK   │
 └─────────────────────────────────────────────────────────────┘
                                                               │
 ▶ Task → missability-inspector → runs the 20 checks           │
 ▶ pp.harness.run_missability_checks → if any fail, BREAK to surfaced
                                                               │
 ▶ Task → master-plan-patcher → patches PROJECT_MASTER.md      │
 ▶ Task → run-finalizer → run.summary.md, archive losers       │
 ▶ pp.harness.finalize_run                                     │
 ▶ Show user: artifacts + taxonomy coverage + missability status + budget
```

`/pp:review <forum>` and `/pp:team <name>` use the same skeleton with different stage sets.

## Validator policy: tiered + content-aware (recap)

- Base tier: `spec`, `design`, `security`, `contract` → cross-vendor required; `code_style`, `docs_polish`, `lint_class` → same-vendor different-model OK.
- **Content-aware upgrade**: keyword regex set forces cross-vendor on concurrency/security/data-integrity/auth/migration prompts, regardless of base tier.
- **Profile-aware upgrade**: `enterprise` profile forces cross-vendor on every gate; `ai-agentic` forces cross-vendor on any gate touching evals or tool permissions.
- **Judge de-biasing**: candidate order randomized; structured rubric scored first then pick; **Borda count** for N≥3.
- **Vendor matrix check**: `doctor` errors loudly if fewer than two vendors are configured; harness refuses to silently downgrade a security/spec/design/contract gate to same-vendor.

## Best-of-N orchestration (recap)

1. `start_run({mode: best_of, n})` → daemon allocates N attempt slots.
2. Driver opens N git worktrees under `<run_id>/<stage>/candidate-{1..N}/`.
3. Driver fans out via the **Task tool** in a single message — N parallel sub-agents pinned to different models.
4. Each sub-agent calls `record_attempt` with its slot; daemon writes outputs under per-candidate worktree.
5. **Inter-candidate diff entropy**: if candidates >90% identical, emit "low-diversity warning"; doesn't block.
6. Single judge Task with rubric scoring + Borda (N≥3) → winner.
7. `record_verdict` ×N, `finalize_stage(winner)`, daemon merges winner's worktree.
8. **Reflexion ×1 applies only to winner**; losers archived.

## Failure-mode mitigations folded in

| Risk | Mitigation |
|---|---|
| Concurrent Claude Code sessions corrupt SQLite | WAL mode, `BEGIN IMMEDIATE`, `runs.session_id`, startup janitor, per-project file lock |
| FS race when N candidates edit same workspace | Per-candidate git worktrees; winner-merges-back, losers archived |
| Reflexion runaway despite "tracked-not-enforced" | Anti-runaway loop ceiling on validator calls (default 6) — distinct from cost; user can override |
| Prompt injection via repo files | `<untrusted-content>` envelope; sandboxes default read-only + no-egress; secrets scan on artifact write |
| Taxonomy ceremony on typos | Triage classifier upgrades/downgrades artifact requirement; trivial = changelog only |
| Judge verbosity / position / sycophancy bias | Randomized order; structured rubric first then pick; Borda count for N≥3 |
| Same-vendor judge shares blindspots on concurrency/security | Content-aware tier upgrade in `gate_eligible_judges` |
| All-N agree on bad answer | Diff-entropy check; low-diversity warning; optional devil's-advocate slot |
| Sub-CLI context drift across turns | `sub_cli_sessions` table; resume flags; recap prompt on miss |
| Daemon dies mid-run; orphaned worktrees | PID file; orphan sweep on startup; `crashed` status; `/pp:doctor` |
| MCP tool-name collision | All tools namespaced `pp.harness.*` / `pp.codex.*` / `pp.gemini.*` |
| Cross-vendor required but only one vendor configured | `doctor` errors loudly at session start; hooks block at PreToolUse |
| Windows path length / cmd shim exit codes | Document `LongPathsEnabled`; capture `$LASTEXITCODE` after npm shims |
| Audit replay gap | `runs` row captures HEAD SHA + dirty-tree hash + profile + CLI versions |
| Manual artifact edits clobbered | Hash-on-write; mismatch prompts merge or confirm |
| Team catalog drift | Layered config (project → user → built-in); team yaml versioned |
| First-run cold start | `/pp:doctor` lists missing prereqs with copy-paste fixes; daemon auto-starts on first MCP call |
| Stages skipped without taxonomy update | Missability gate library blocks `finalize_run` |
| Master plan staleness | `update-master-plan` PostToolUse hook patches on every `finalize_run` |
| Hooks interfering with quick read-only questions | All blocking hooks scoped to active runs only; advisory hooks stay nudges |

## Critical files (paths to be created)

- `<repo-root>\daemon\package.json`
- `<repo-root>\daemon\src\index.ts`
- `<repo-root>\daemon\src\mcp\harness-server.ts`
- `<repo-root>\daemon\src\mcp\codex-server.ts`
- `<repo-root>\daemon\src\mcp\gemini-server.ts`
- `<repo-root>\daemon\src\db\schema.sql`
- `<repo-root>\daemon\src\orchestrator\loop-ceiling.ts`
- `<repo-root>\daemon\src\orchestrator\worktree.ts`
- `<repo-root>\daemon\src\orchestrator\missability.ts`
- `<repo-root>\daemon\src\orchestrator\master-plan.ts`
- `<repo-root>\daemon\src\security\untrusted-envelope.ts`
- `<repo-root>\daemon\src\security\secret-scan.ts`
- `<repo-root>\daemon\src\rubrics\loader.ts`
- `<repo-root>\.claude\.mcp.json`
- `<repo-root>\.claude\skills\pair-programmer.md`
- `<repo-root>\.claude\agents\judge-router.md`
- `<repo-root>\.claude\agents\taxonomy-mapper.md`
- `<repo-root>\.claude\agents\designer.md`
- `<repo-root>\.claude\agents\missability-inspector.md`
- `<repo-root>\.claude\commands\pp\run.md`
- `<repo-root>\.claude\commands\pp\review.md`
- `<repo-root>\.claude\commands\pp\checklist.md`
- `<repo-root>\.claude\rubrics\wcag-2.2-aa.md`
- `<repo-root>\.claude\rubrics\owasp-asvs-l1.md`
- `<repo-root>\.claude\rubrics\c4-system-context.md`
- `<repo-root>\.claude\rubrics\openapi-3.1-stability.md`
- `<repo-root>\.claude\rubrics\nist-ai-rmf-govern.md`
- `<repo-root>\.claude\rubrics\rfc-2119-normative.md`
- `<repo-root>\.claude\teams\feature-team.yaml` (and 14 more team yamls)
- `<repo-root>\.claude\profiles\web-ui.yaml` (and 9 more profile yamls)
- `<repo-root>\.claude\settings.json` (canonical hook wiring; 24 handlers in `daemon/src/hooks/dispatcher.ts`)
- `<repo-root>\taxonomy_blueprint.md` — already exists; canonical reference
- `<repo-root>\PROJECT_MASTER.md` — auto-scaffolded on first run

## Phased implementation

Each phase is end-to-end usable, not a half-built lower layer.

### Phase 1 — Walking skeleton (single-agent, single-validator, no teams)

Daemon: `pp-daemon` binary, SQLite + WAL schema, core MCP tools (`start_run`/`record_attempt`/`record_verdict`/`finalize_run`). Codex MCP wrapper with worktree isolation + untrusted envelope + secrets scan. `.mcp.json`, `pair-programmer` skill, `engineer` + `judge-same-vendor` agents, `/pp:run`. `PostToolUse.cost-tally` + `pp:budget`. `/pp:doctor`.

### Phase 2 — Cross-vendor + tiered policy

Gemini MCP wrapper. Real `gate_eligible_judges` (tier table + content-keyword upgrade). `judge-cross-vendor` + `judge-router`. Vendor matrix check in `doctor` and `SessionStart.vendor-matrix` hook.

### Phase 3 — Taxonomy adherence + master plan

`triage` + `taxonomy-mapper` agents. `record_taxonomy_mapping` + per-run `taxonomy_mapping.json`. Trivial-task minimum artifact rule. `/pp:taxonomy`, `/pp:master`. `taxonomy-adherence` skill text. Master-plan scaffolder + `master-plan-patcher` agent + `update-master-plan` hook. `PROJECT_MASTER.md` auto-created on first run.

### Phase 4 — Reflexion + surfacing + missability

`reflexion-coach`. `retry_with_critique` + ×1 invariant. Anti-runaway loop ceiling. Surfaced-run UX. `/pp:retry`, `/pp:gate`. **Missability library**: `missability-inspector` agent + `run_missability_checks` daemon tool + 20-item check implementations.

### Phase 5 — Best-of-N

Driver fan-out via Task tool + per-candidate worktrees. Borda for N≥3. Diff-entropy / low-diversity warning. Winner-only Reflexion. `/pp:best-of`.

### Phase 6 — Project profiles + standard-aligned rubrics

Profile loader + 10 profile templates. `gate_eligible_judges` reads profile + content keywords. `rubrics/` directory + 13 rubrics shipped. `get_rubric` daemon tool. `/pp:profile`, `/pp:rubrics`. Rubric registry seeded into daemon DB.

### Phase 7 — Specialized teams (all 15)

Team yaml loader (project → user → built-in). Six original teams (feature, bug-fix, refactor, security-review, ai-controls, docs) + nine new (strategy, discovery, ux, design-system, data, release, ops, governance, retirement). `/pp:team`, `/pp:teams`. Each team binds rubrics from Phase 6.

### Phase 8 — Design system support

`designer` agent integrated with `frontend-design` skill. `design-system-curator`, `visual-regression-runner` agents. Playwright dependency + screenshot capture. Screen-state matrix artifact spec. Permission-aware UX, localization plan, responsive matrix artifacts. WCAG rubric used by ux/design-system gates. `ux-team` and `design-system-team` teams operational.

### Phase 9 — Review-mode commands + completion checklist

`/pp:review <forum>` for all 10 governance forums. `/pp:checklist` running Section 10's 15 items against `PROJECT_MASTER.md`. Each forum's pipeline + rubric binding.

### Phase 10 — Full hook catalog

All 22 hooks configured in `.claude/hooks/*.json`. PreToolUse blockers (active-run, vendor-matrix, sandbox-policy, no-secrets, validator-gate, rfc-2119). PostToolUse recorders (cost-tally already, plus record-attempt, taxonomy-coverage-update, hash-artifact, loop-ceiling-tally, verdict-rubric-coverage, update-master-plan). UserPromptSubmit nudges (taxonomy-nudge, team-suggester, risk-flag, surfaced-run-reminder, profile-aware-nudge). SessionStart preflight + Stop guards.

### Phase 11 — Operations & polish

Concurrency hardening (`BEGIN IMMEDIATE`, file lock, janitor, orphan sweep). Sub-CLI session continuity (`sub_cli_sessions`). Manual-edit detection on artifact rewrite. Audit replay (`/pp:replay`). HTTP control plane (read-only) + cross-session `/pp:status`. Documentation: install guide, team-authoring guide, profile-authoring guide, validator-policy reference, rubric-authoring guide, troubleshooting (Windows long paths, cmd shim).

## Verification (how we'll know each phase works)

- **Phase 1**: `/pp:run "add a docstring to file X"` → real artifact + verdict + run summary on disk; DB has 1 run/stage/attempt/verdict.
- **Phase 2**: `/pp:run "harden auth middleware"` → cross-vendor judge fires (security keyword); verdict has `cross_vendor=1`; vendor-matrix doctor fails closed when Gemini key removed.
- **Phase 3**: Trivial task → changelog-only artifact + master plan patch. Standard task → full mapping with required 4.x sections covered. `PROJECT_MASTER.md` reflects the run.
- **Phase 4**: Inject a known-bad generator → validator rejects → reflexion retries → if still bad, surfaced with both attempts. Third generator call rejected. Missability inspector blocks finalize when, e.g., schema-evolution check fails.
- **Phase 5**: `/pp:best-of 3` → 3 worktrees, 3 parallel models, Borda picks winner, only winner merged. Diff-entropy fires on a request like "write a function to add two numbers."
- **Phase 6**: `/pp:run` on a `web-ui` profile project automatically triggers WCAG rubric on UI gates and OWASP ASVS on security gates. `enterprise` profile forces cross-vendor everywhere.
- **Phase 7**: `/pp:team feature-team "add OAuth"` runs the 6-stage pipeline. `/pp:team ux-team "redesign settings page"` runs the 6-UX-stage pipeline. Custom user-level team override at `~/.claude/teams/feature-team.yaml` takes precedence.
- **Phase 8**: UI-touching change auto-produces screen-state matrix + Playwright before/after screenshots. WCAG rubric scores all 8 states. `frontend-design` skill output appears in `<run_id>/ux/`.
- **Phase 9**: `/pp:review threat` produces a threat model + control mapping verified by ASVS rubric. `/pp:checklist` lists which of Section 10's 15 items are open in `PROJECT_MASTER.md`.
- **Phase 10**: `Edit` to source code outside an active run is blocked by `enforce-active-run`. `pp.codex.generate` with wrong sandbox flag is blocked. Spec-stage outputs lacking MUST/SHOULD/MAY are blocked. End-of-turn summary missing the expected pattern triggers a Stop hook nudge.
- **Phase 11**: Two concurrent `/pp:run`s queue cleanly. `pp:doctor` after killing the daemon reports orphans + offers cleanup. `pp:replay <run_id>` reconstructs prompt set and CLI versions. End-to-end works on a fresh Win11 machine after `npm i -g @openai/codex @google/gemini-cli` + setting two API keys + scaffolding `.claude/`.

## Defaults the plan picks (note now, override on request)

1. Daemon language: **TypeScript**.
2. Best-of-N candidate isolation: **git worktrees** (copy-based fallback on Windows).
3. Judging mode for N≥3: **pairwise + Borda count**.
4. Anti-runaway loop ceiling: **6 validator calls per run** before circuit-breaker (overridable).
5. Trivial-task minimum artifact: **changelog entry**.
6. Sub-CLI sandbox default: **read-only filesystem + no network egress**.
7. HTTP control plane scope: **read-only at v1**.
8. Teams location: `.claude/teams/` (versioned with the plugin); resolution `project → user → built-in`.
9. Generator binding: **soft preference**; `binding_strict: true` on security stages.
10. Hooks: **PreToolUse blockers active when a run is open**, advisory otherwise — keeps Claude Code usable for quick read-only questions.
11. Visual regression: **Playwright** as the screenshot engine.
12. Master plan: **auto-scaffolded** on first `finalize_run`; existing files honored if present.
13. Rubric versioning: **rubric_id includes version**; verdicts pin rubric version for replay.
14. Profile absence = **generic mode** (current locked decisions only); no implicit profile inference.
