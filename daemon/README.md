# pp-daemon

Pair-Programmer harness daemon. Three MCP servers (`pp.harness.*`, `pp.codex.*`, `pp.gemini.*`) plus an optional read-only HTTP control plane, all hosted by a single Node binary.

## Install

```powershell
cd daemon
npm install
npm run build
npm link   # exposes the `pp-daemon` command on PATH for local dev
```

## Run

```powershell
pp-daemon mcp          # harness MCP server (stdio)
pp-daemon mcp-codex    # Codex MCP wrapper (stdio)
pp-daemon mcp-gemini   # Gemini MCP wrapper (stdio)
pp-daemon serve        # read-only HTTP control plane on 127.0.0.1:7878
pp-daemon doctor       # health check
```

State lives at `~/.pair-programmer/state.db` (SQLite, WAL mode). Per-project artifacts at `<project>/.harness/<run_id>/`.

See the project plan under your local Claude Code plans directory (`~/.claude/plans/`) for the full plan.
