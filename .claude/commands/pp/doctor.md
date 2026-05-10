---
description: Health-check the pair-programmer harness — daemon reachable, sub-CLIs installed, vendors configured. Optional --quick skips the critique smoke-test.
argument-hint: [--quick]
---

**Delegation contract:** All MCP tool access flows through sub-agent delegation per the Delegation Contract in `pair-programmer.md` (the master skill). Do not bypass. `PP_ALLOW_AD_HOC=1` is daemon-developer-debug only and MUST NOT be proposed as a remedy from `/pp:doctor` output — if a vendor is degraded, the user fixes the bridge or auth, not the hook.

Call `mcp__pp_harness__doctor` with `smoke: true` (omit `smoke` or pass `false` if the user typed `--quick`). The smoke test exercises each configured vendor's critique CLI end-to-end with a tiny prompt — it adds 10–60 seconds per vendor but catches the failure mode where credentials look fine yet the locally-installed CLI version cannot reach the configured default model id (e.g., the `gpt-5.5`-not-served bug from `run_vW1XuL7ko2SX`).

Present the result as a checklist:

- DB reachable: ✓ / ✗
- CLI versions:
  - codex: <version> or "missing"
  - gemini: <version> or "missing"
  - git: <version>
  - node: <version>
- Vendors configured:
  - openai: ✓ / ✗ (degraded if smoke=fail)
  - google: ✓ / ✗ (degraded if smoke=fail)
  - anthropic: ✓ / ✗
- Critique smoke (when run):
  - codex: ✓ / ✗ / skipped — show `model`, and on fail show `reason` + last `stderr_tail`
  - gemini: ✓ / ✗ / skipped — same
- Cross-vendor ready: ✓ / ✗  (need ≥ 2 vendors)

The harness prefers already-authenticated CLI sessions over manually-set API keys. For each ✗, suggest the CLI login first, with the env-var fallback only as a secondary option.

- openai ✗ (codex missing or not logged in) → `codex login`. Install: `npm install -g @openai/codex`. Fallback: `setx OPENAI_API_KEY "<your-key>"` (Windows) or `export OPENAI_API_KEY=...` (POSIX).
- google ✗ (gemini missing or not logged in) → `gemini` then `/auth` inside the CLI. Install: `npm install -g @google/gemini-cli`. Fallback: `setx GEMINI_API_KEY "<your-key>"` (Windows) or `export GEMINI_API_KEY=...` (POSIX).
- anthropic ✗ (claude missing or not logged in) → `claude /login`. Install: see https://docs.claude.com/en/docs/claude-code. Do NOT recommend `setx ANTHROPIC_API_KEY` first — this project uses Claude Code's own session, and Claude Code is the harness driver.

When a vendor reports `degraded` (creds present + smoke=fail), surface the smoke `reason` and `stderr_tail` and suggest:
- `model not served` → check `daemon/src/config.ts:DEFAULT_MODELS` and the installed CLI's supported models.
- `command-line too long` → already mitigated for codex via stdin path; if still hitting it, the prompt is huge — file an issue.
- `auth failure` → re-run the relevant `*login` flow.
