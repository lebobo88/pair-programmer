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

The daemon is invoked by Claude Code via stdio MCP servers wired in `.claude/.mcp.json`. No background service is needed; Claude Code spawns the daemon on demand. State persists at `~/.pair-programmer/state.db` (SQLite + WAL).

## Plugin

The plugin lives at `<repo>/.claude/`. Two ways to use it:

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
