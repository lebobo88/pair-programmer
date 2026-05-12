# pair-programmer

Multi-agent coding harness. **Claude Code and GitHub Copilot CLI** are supported entrypoints; Codex CLI (GPT) and Gemini CLI act as sub-agents; every artifact is validated by a different model. On-demand best-of-N and specialized teams. Taxonomy adherence on every task referencing `taxonomy_blueprint.md` (16 sections).

**Current state**: **All 11 phases shipped.** Single-agent → cross-vendor judging → taxonomy mapping + master plan → Reflexion ×1 + missability gates → best-of-N with worktrees → project profiles + 13 standard rubrics → 15 specialized teams → design-system + visual regression → 10 governance forums → 25 alignment hooks → ops polish (janitor, replay, HTTP plane).

Plan: `PLAN.md` (and at `C:\Users\robob\.claude\plans\help-me-discover-plan-giggly-puddle.md`).

## What ships

- **42 MCP tools** on `pp_harness` (orchestration, taxonomy, master plan, missability, loop ceiling, gates, rubrics, profiles, teams, forums, best-of-N, replay, janitor) plus `pp_codex` and `pp_gemini` (generate, critique).
- **Dual entrypoints** — Claude assets stay in `.claude/`; generated Copilot assets live in `.github/`, generated Copilot hooks live in `hooks.json`, and the full Copilot entrypoint is packaged by `plugin.json`.
- **39 sub-agents** for every taxonomy domain: engineer, spec-author, architect, api-designer, test-strategist, security-reviewer, designer, design-system-curator, visual-regression-runner, browser-validator, data-modeler, release-planner, ops-author, governance-author, ai-controls-author, retirement-planner, strategy-author, discovery-researcher, docs-author, triage, profile-loader, taxonomy-mapper, master-plan-patcher, missability-inspector, reflexion-coach, judge-router, judge-cross-vendor, judge-same-vendor, run-finalizer, **+11 game-dev specialists**: narrative-designer, level-designer, encounter-designer, economy-designer, netcode-programmer, game-ai-programmer, tech-animator, technical-artist, game-security, live-ops-manager, game-accessibility-specialist.
- **16 slash commands**: `/pp:run`, `/pp:best-of`, `/pp:team`, `/pp:teams`, `/pp:review`, `/pp:retry`, `/pp:gate`, `/pp:status`, `/pp:budget`, `/pp:doctor`, `/pp:taxonomy`, `/pp:master`, `/pp:checklist`, `/pp:profile`, `/pp:rubrics`, `/pp:replay`.
- **22 specialized teams**: feature, bug-fix, refactor, security-review, ai-controls, docs, strategy, discovery, ux, design-system, data, release, ops, governance, retirement, **game-feature, game-bug-fix, game-refactor, game-cert, game-live-ops, game-accessibility, game-netcode**.
- **16 project profiles**: web-ui, api-platform, internal-tool, enterprise, ai-agentic, mobile, sdk, data-product, embedded, non-ui-cli, **game-dev, game-dev-unity, game-dev-unreal, game-dev-godot, game-dev-web, game-dev-custom**. Game-dev sub-modes auto-detected from engine manifests (Unity ProjectSettings, *.uproject, project.godot, Cargo.toml [bevy], package.json [babylonjs/three.js/playcanvas/phaser], *.yyp); console-cert / mobile-target / web-target / live-service / online / voice posture flags inferred from build configs + spec keywords + middleware presence.
- **23 standard-aligned rubrics**: WCAG 2.2 AA, OWASP ASVS L1/L2, C4, OpenAPI/AsyncAPI, SLSA L2/L3, SBOM CycloneDX, NIST AI RMF Govern/Measure, RFC 2119, metric dictionary, web-runtime-validation, **Game Accessibility Guidelines, Xbox Accessibility Guidelines, console cert checklist (TRC/XR/Lotcheck — non-authoritative), IARC age-rating questionnaire, COPPA 2.0 + GDPR-K, loot-box jurisdiction matrix, Steam AI disclosure, SAG-AFTRA AI rider, game perf-budget, IGDA-GASIG**.
- **26 hooks** across 5 events: SessionStart (5), PreToolUse (7 — including `block-destructive-shell` which prevents `rm -rf` / `Remove-Item -Recurse -Force` / `find . -delete` / `git clean -fdx` / `git push --force` to protected refs / `dd` / `mkfs` / `shutdown` / `reboot` / fork bombs from running outside an anchored project root), PostToolUse (7), UserPromptSubmit (5), Stop (2).
- **50-item missability check library** (Section 6 of taxonomy_blueprint.md): 20 generic + 30 game-dev (console TRC, online netcode, live-service legal, accessibility GAG/XAG, IP / asset / AI provenance).
- **`PROJECT_MASTER.md`** auto-scaffolded from Section 9's 20-section template; patched on every `finalize_run`.

## Layout

```
pair-programmer/
  taxonomy_blueprint.md           # 16-section blueprint
  PLAN.md                         # full implementation plan (mirrored at ~/.claude/plans/...)
  PROJECT_MASTER.md               # auto-scaffolded on first finalize_run
  daemon/                         # pp-daemon (TypeScript, MCP + SQLite + sandboxes + HTTP plane)
    src/
      mcp/                        # harness-server.ts, codex-server.ts, gemini-server.ts, helpers.ts
      orchestrator/               # runs, gates, taxonomy, master-plan, missability, loop-ceiling, best-of-n, profiles, teams, forums, design-templates, replay, worktree, janitor
      rubrics/registry.ts         # 13 standard rubrics
      hooks/dispatcher.ts         # 25 hook handlers
      security/                   # untrusted-envelope, secret-scan
      http/server.ts              # read-only control plane on 127.0.0.1:7878
      db/                         # schema.ts (inlined), database.ts (better-sqlite3 + WAL)
      util/                       # paths, logger, lock, prices
    test/smoke.mjs                # end-to-end MCP roundtrip smoke test (33 checks)
    package.json
    prices.json                   # per-1M-token USD prices (user-editable, copied to ~/.pair-programmer)
  .mcp.json                       # registers pp_harness + pp_codex + pp_gemini stdio servers
  .claude/
    skills/pair-programmer.md     # master skill loaded by every /pp:* command
    agents/                       # 26 sub-agent definitions (.md with frontmatter)
    commands/pp/                  # 16 slash command definitions
    rubrics/                      # mirror of the 13 rubrics + index
    teams/                        # 15 team yamls
    profiles/                     # 10 profile yamls
    settings.json                 # permissions allowlist + 25 hook commands
  .harness/<run_id>/              # per-run artifacts (request, taxonomy_mapping, code/, ux/, security/, …)
```

State at `~/.pair-programmer/state.db` (SQLite, WAL). Logs at `~/.pair-programmer/logs/`. Sub-CLI sandboxes at `~/.pair-programmer/sandboxes/`.

## Setup

```powershell
cd daemon
npm install
npm run build
node dist/index.js doctor      # confirms CLIs, DB, vendor matrix
```

Optional Copilot CLI packaging:

```powershell
node scripts/sync-copilot-assets.mjs
.\scripts\install-user-copilot.ps1
```

This is the supported **no-copy** deployment path for GitHub Copilot CLI: install once from this repo and the pair-programmer entrypoint is available in every Copilot CLI session for the current Windows user. Consumer repos do **not** need their own `.github\` copy of the harness assets.

Required external CLIs (already installed via npm if you got `codex --version` and `gemini --version` to work):
- `npm install -g @openai/codex`
- `npm install -g @google/gemini-cli`

Required env (set whichever vendor you'll use):
- `OPENAI_API_KEY` (or `codex login` / ChatGPT subscription session)
- `GEMINI_API_KEY` (or `gemini auth` / Google login session)

Cross-vendor gates require **two** vendors. The Phase 10 hook `SessionStart.vendor-matrix` warns at session start if only one is configured.

## Use

> **Full reference:** [`docs/USER_GUIDE.md`](docs/USER_GUIDE.md) — single canonical guide covering every command, agent, team, profile, rubric, forum, hook, MCP tool, and the security/trust model.

In Claude Code (after restart so the new `.mcp.json` loads):

- `/pp:doctor` — full health check.
- `/pp:run "<request>"` — single-agent + tiered judge.
- `/pp:best-of 3 "<request>"` — N-way fan-out with Borda count + diff-entropy.
- `/pp:team feature-team "<request>"` — runs one of the 15 teams.
- `/pp:review threat` — runs one of the 10 governance forums.
- `/pp:status [run_id]` — list runs or show one full tree.
- `/pp:retry <run_id>` — Reflexion ×1 retry on a surfaced stage.
- `/pp:taxonomy [run_id]` — show 16-section coverage for one run.
- `/pp:master` — view or scaffold `PROJECT_MASTER.md`.
- `/pp:checklist` — Section 10's 15-item completion check.
- `/pp:profile [show|list|template <name>]` — view active profile or render a template.
- `/pp:rubrics [list|show <id>]` — list rubrics or show body.
- `/pp:replay <run_id>` — reproduce-bundle for a past run.
- `/pp:budget [scope]` — token + dollar totals by run / day / model.
- `/pp:doctor` — full preflight.
- `/pp:teams` — list teams.

In GitHub Copilot CLI:

1. Install the plugin once at user scope from this repo with `.\scripts\install-user-copilot.ps1` — this covers every repo for the current Windows user and avoids per-project `.github\` copies.
2. Start Copilot with the orchestrator agent in a consumer repo: `copilot --agent pair-programmer-orchestrator`
3. Use ordinary chat requests and let the orchestrator route them into the correct pair-programmer workflow automatically, or call `/pp:*` directly when you want an explicit command.
4. Re-run the installer after `git pull` or prompt/hook changes so Copilot refreshes its cached plugin copy. If Copilot is currently holding the direct-install cache open, the installer now falls back to an in-place refresh of that cached copy instead of failing on uninstall.

The Copilot-facing agents, skills, commands, and hooks are generated from `.claude/` by `node scripts/sync-copilot-assets.mjs`. The recommended Copilot entrypoint agent is `pair-programmer-orchestrator`.

On first `/pp:*` run, the harness detects your project type and writes `<project>/.harness/profile.yaml` after a one-line confirmation (or auto-writes if detection confidence is high). Hand-edit or replace it any time; detection won't re-run once the file exists. CI / non-interactive runs fail loudly when confidence is below high — bootstrap the file once interactively, then commit it.

## Tests

```powershell
cd daemon
npm run typecheck
npm run build
node test/smoke.mjs              # 33 end-to-end MCP roundtrip checks
```

## Hardening flags

| Env var | Effect |
|---------|--------|
| `PP_ENFORCE_ACTIVE_RUN=1` | PreToolUse hook hard-blocks Edit/Write outside an active `/pp:run`. |
| `PP_ALLOW_DANGER=1`       | Allows `--sandbox=danger-full-access` on Codex calls (off by default). |
| `PP_LOG_LEVEL=debug`      | Verbose pino logs at `~/.pair-programmer/logs/pp-daemon-YYYY-MM-DD.log`. |
| `PP_DEBUG=1`              | Include stack traces in MCP error responses. |
