# Pair-programmer harness — install

## Prerequisites

- Node 20+ (`node --version`).
- Git (worktrees fall back to copy mode otherwise).
- Codex CLI: `npm i -g @openai/codex`. Set `OPENAI_API_KEY` or run `codex login`.
- Gemini CLI: `npm i -g @google/gemini-cli`. Set `GEMINI_API_KEY` (or `GOOGLE_API_KEY`) or run `gemini auth`.
- Optional (visual regression): `cd daemon && npx playwright install chromium`.

## Daemon

```bash
cd daemon
npm install
npm run build
```

The daemon is invoked by Claude Code or GitHub Copilot CLI via stdio MCP servers wired in `.mcp.json` / `.claude/.mcp.json`. No background service is needed; the entrypoint spawns the daemon on demand. State persists at `~/.pair-programmer/state.db` (SQLite + WAL).

## Entrypoints

The Claude entrypoint lives under `<repo>/.claude/`. The GitHub Copilot CLI entrypoint is packaged from the repo root via `plugin.json` plus the generated `.github/` assets and `hooks.json`.

Two ways to use it:

### Option A — system-wide (recommended)

Register the harness once at user scope (`~/.claude/`) so `/pp:*`, the 3 MCP servers, the 25 hooks, the sub-agents, and the skills are available in **every** Claude Code session, regardless of cwd. The repo stays the single source of truth — `git pull` updates every project.

```powershell
cd <repo>
.\scripts\install-user.ps1
```

This creates NTFS junctions under `~/.claude/{commands/pp,agents,skills}` pointing at the repo, renders `.claude/settings.template.json` (substituting `__PP_DAEMON__` with the absolute path to `daemon/dist/index.js` on your machine), and merges the result into `~/.claude/settings.json` alongside `claude mcp add -s user` for the three MCP servers. The rendered `<repo>/.claude/settings.json` is also written locally for project-scope use and is gitignored — your installed copy is per-machine. Existing user-level entries (other MCP servers / hooks) are preserved. No admin required. Idempotent — safe to re-run after `git pull`.

To remove: `.\scripts\uninstall-user.ps1` (uses `~/.claude/.pp-managed.json` to reverse precisely).

### Option B — per-project (legacy)

1. Copy or symlink `<repo>/.claude/` into your project (or run Claude Code from this repo).
2. Verify with `mcp__pp_harness__doctor` that both vendors and the daemon are green.
3. Optionally drop a profile YAML at `<project>/.harness/profile.yaml` (see `.claude/profiles/*.yaml` for templates).

### Option C — GitHub Copilot CLI plugin (all repos for the current user)

The repo root now contains a Copilot CLI plugin manifest (`plugin.json`), generated Copilot assets under `.github/`, and a generated plugin hook file at `hooks.json`.

```powershell
cd <repo>
.\scripts\install-user-copilot.ps1
```

This installs the harness once at user scope as a Copilot CLI plugin, exposing the `pp:*` command set plus generated agents, skills, hooks, and MCP registrations in **every** Copilot CLI session for the current Windows user. Consumer repos do **not** need a copied `.github/` folder or plugin files. The installer verifies the daemon build, regenerates the Copilot-facing assets from `.claude/`, validates the packaged plugin paths, refreshes the cached plugin copy, and confirms registration with `copilot plugin list`.

Copilot caches plugin contents, so unlike the Claude user-scope junction install you must re-run `.\scripts\install-user-copilot.ps1` after `git pull`, daemon rebuilds, or prompt / hook changes. This is the Copilot equivalent of the Claude user-scope install, but with a refresh step because the installed plugin is cached instead of live-junctioned. If Copilot keeps the direct-install cache busy and uninstall cannot remove it, the installer falls back to an in-place refresh of `%USERPROFILE%\.copilot\installed-plugins\_direct\pair-programmer`. To remove the plugin: `.\scripts\uninstall-user-copilot.ps1`.

> **Upstream warning:** current Copilot CLI releases warn that direct installs from local paths / repos are deprecated in favor of marketplace installs. This workflow works today and is the closest machine-wide equivalent to the Claude user install, but long-term distribution may need a plugin marketplace or enterprise-managed plugin standard.

`hooks.json` is the plugin-installed hook file. `.github/hooks/pair-programmer.json` is a generated repo-local mirror for working on this harness repo without repackaging by hand. Both are derived from `.claude/settings.template.json` by `node scripts\sync-copilot-assets.mjs`.

Recommended Copilot entrypoint:

```powershell
copilot --agent pair-programmer-orchestrator
```

When that custom agent is active, ordinary chat requests are routed into the appropriate pair-programmer command/workflow automatically. You can still use `/pp:*` explicitly when you want a specific command.

## First run

```text
/pp:doctor          # green check on daemon + vendors + master plan
/pp:run "add a docstring to README"
```

Artifacts land under `<project>/.harness/<run_id>/`. Master plan is scaffolded at `<project>/PROJECT_MASTER.md`.

## Windows

- Long-path support: enable `LongPathsEnabled` (`Computer\HKEY_LOCAL_MACHINE\SYSTEM\CurrentControlSet\Control\FileSystem`).
- The npm shim's exit code may be wrapped — read `$LASTEXITCODE` after a CLI invocation if the harness reports an unexpected non-zero.

## Re-generating rubric mirrors

After editing `daemon/src/rubrics/registry.ts`:

```bash
cd daemon && npm run build
node dist/index.js dump-rubrics
```

Files appear at `<repo>/.claude/rubrics/<bare-id>.md`.
