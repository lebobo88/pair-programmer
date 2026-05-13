# Troubleshooting

## Daemon health

`/pp:doctor` reports CLI versions, vendor configuration, and DB reachability. If `db_reachable=false`, restart your Claude Code session — the SQLite file at `~/.pair-programmer/state.db` may have a stale WAL.

The `daemon-up` SessionStart hook fails closed: a session won't start while the daemon is unhealthy. If you're stuck, run `node daemon/dist/index.js doctor` to inspect the JSON report directly.

## Vendor matrix

Cross-vendor gates require both OpenAI (Codex) and Google (Gemini) configured. The fastest check:

```bash
codex --version
gemini --version
```

If either is missing:
- Codex: `npm i -g @openai/codex`, then `codex login` or `setx OPENAI_API_KEY <key>`.
- Gemini: `npm i -g @google/gemini-cli`, then `gemini auth` or `setx GEMINI_API_KEY <key>`.

The `vendor-matrix` SessionStart hook only fails closed when an active run already exists in this project. New projects can still start in same-vendor mode (until they hit a cross-vendor gate).

## Hook blocked my edit

Hooks default to enforcing inside an active run:
- `enforce-active-run` — set `PP_ALLOW_AD_HOC=1` to bypass.
- `enforce-validator-gate` — call `retry_with_critique` (or invoke `reflexion-coach`) to clear a failed-verdict block.
- `enforce-rfc2119-language` — add MUST/SHOULD/MAY to the spec, or change the artifact `kind` to a non-spec value.
- `enforce-sandbox-policy` — match the sandbox flag to the active stage kind (read-only for spec/design/security/contracts; workspace-write for code/tests).

## Manual edit detected

`archive_artifact` returns `manual_edit_detected` when the on-disk file's hash differs from the stored hash. Either:
- merge your edits manually, then re-call with the merged bytes; or
- pass `force_overwrite: true` to clobber.

## Best-of-N merge conflict

`archive_winner_and_losers` returns `merge_status: "conflict"` when `git merge --no-ff` of the winner branch fails. Conflict markers are left in the project tree; the run finalizes as `surfaced`. Resolve the conflicts manually, then run `/pp:retry <run_id>` to re-enter the lifecycle.

## Windows long paths

If artifact writes fail with `ENAMETOOLONG`:
1. Enable `LongPathsEnabled` in the registry: `Computer\HKEY_LOCAL_MACHINE\SYSTEM\CurrentControlSet\Control\FileSystem\LongPathsEnabled = 1`.
2. Restart the shell.

## Codex / Gemini exit codes

The npm shim wraps the binary's exit code on Windows. The wrappers in `daemon/src/mcp/{codex,gemini}-server.ts` already handle this — they read `exitCode` from execa's structured result rather than `$LASTEXITCODE`.

## Codex "Not inside a trusted directory"

For harness-driven Codex calls (`pp_codex.generate` / `pp_codex.critique`), the daemon already adds `--skip-git-repo-check`, so bridge calls should not fail on Codex's trusted-directory prompt.

If you run `codex` directly in your own shell and hit the same error, invoke it as:

```bash
codex exec --skip-git-repo-check --cd <project> ...
```

## Visual regression unavailable

The `visual_regression_capture` tool returns `{ status: "unavailable", reason }` when:
- `@playwright/test` isn't installed: `cd daemon && npm install`.
- Chromium binary missing: `npx playwright install chromium`.

The `visual-regression-runner` agent reports the reason without failing the run — the parent decides whether to surface or continue.

## Concurrent runs

The daemon takes a per-project file lock (`<project>/.harness/.lock`) at `start_run` and releases it at `finalize_run`. If a daemon crashes mid-run, the janitor sweeps stale lock files on the next startup. To force-release: delete `<project>/.harness/.lock` (only when no daemon is running).
