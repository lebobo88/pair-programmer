# Pair-programmer Copilot CLI instructions

This repository ships a **GitHub Copilot CLI plugin entrypoint** in parallel with the existing Claude entrypoint.

- The **source of truth** for shared harness prompts remains under `.claude/`.
- The Copilot-facing assets under `.github/agents`, `.github/skills`, and `.github/commands` are generated from `.claude/` by `node scripts/sync-copilot-assets.mjs`, then rewritten by that same script for any Copilot-only overrides.
- When changing shared harness prompts, edit `.claude/` first, then rerun the sync script. For Copilot-only Opus/tier-map behavior, update the post-sync rewrite logic instead of changing `.claude/` model ids.

## Key paths

- `plugin.json` — Copilot CLI plugin manifest.
- `hooks.json` — generated Copilot plugin hooks, derived from `.claude/settings.template.json`.
- `.mcp.json` — stdio MCP registrations for `pp_harness`, `pp_codex`, and `pp_agy`.
- `.claude/agents/pair-programmer-orchestrator.md` — canonical source for the Copilot orchestrator agent.
- `.github/agents/` — generated Copilot custom agents.
- `.github/skills/` — generated Copilot skills (`SKILL.md`).
- `.github/commands/pp/` — generated Copilot slash commands.
- `.github/hooks/pair-programmer.json` — generated repo-local Copilot hook mirror for developing the harness itself.
- `daemon/` — shared orchestration core for both entrypoints.

## Working rules

1. Build and validate daemon changes from `daemon/`:
   - `npm run typecheck`
   - `npm run build`
   - `npm test`
2. After editing `.claude/` prompt assets, run:
   - `node scripts/sync-copilot-assets.mjs`
   - Re-run `.\scripts\install-user-copilot.ps1` if you need the installed Copilot plugin cache refreshed
   - The sync script also applies Copilot-only mirror rewrites (including the Opus tier pin) after generation
   - If a Copilot-facing agent needs a different model than its Claude source agent and the difference is agent-frontmatter-only, set `copilot-model:` in the `.claude/agents/*.md` frontmatter; the sync script prefers it when generating `.github/agents/*.agent.md`
3. Keep `.mcp.json` compatible with both entrypoints.
4. Prefer updating shared daemon behavior instead of forking orchestration logic between Claude and Copilot.

## Local Copilot CLI usage

1. Build the daemon.
2. Install the plugin from the repo root:
   - `.\scripts\install-user-copilot.ps1`
3. Start Copilot CLI in a consumer repo with:
   - `copilot --agent pair-programmer-orchestrator`
4. Use ordinary chat requests and let the orchestrator route them into the right pair-programmer workflow, or call `/pp:*` directly when you want an explicit command.

`hooks.json` is the machine-wide plugin hook file; `.github/hooks/pair-programmer.json` is the repo-local mirror for working inside this harness repository. Re-run the installer after prompt or hook changes so Copilot refreshes its cached plugin bundle.
