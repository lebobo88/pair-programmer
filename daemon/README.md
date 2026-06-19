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

## Environment flags

- `PP_DISABLE_GEMINI=1` — global Gemini kill-switch. Disables ALL Gemini interactions (cross-vendor judge **and** generation producer) without removing any code, MCP registration, or team `model_pref: gemini` hints. `doctor()` reports `vendors_configured.google=false` and `gemini_disabled=true`; the default cross-vendor pair becomes Codex (openai) + Claude (anthropic), so `cross_vendor_ready` stays true. Unset (and re-authenticate the Gemini CLI) to re-enable.
- `PP_COPILOT_FALLBACK=0` — disable the Copilot CLI fallback for codex/gemini.

See the project plan under your local Claude Code plans directory (`~/.claude/plans/`) for the full plan.
