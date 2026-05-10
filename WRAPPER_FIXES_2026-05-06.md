# pair-programmer harness — wrapper fixes (2026-05-06)

Status: applied locally to `<repo-root>\daemon\` on 2026-05-06.

## Symptoms

After a routine `gemini` CLI upgrade (0.37.1 -> 0.41.2), cross-vendor critique broke:

- pp_gemini.critique and pp_gemini.generate exit 1 with empty stdout in ~1100 ms.
- pp_codex.critique exits 0 but gpt-5.4 (the only model on ChatGPT-account auth) returns "Paste the recap and the concrete task..." templated meta-reply, ~25k input tokens, score: {}.
- mcp__pp_harness__doctor reports cross_vendor_ready: true despite both lanes broken (only checks CLI presence + login).

## Root cause #1 — gemini removed --prompt-file in >=0.40

Wrapper builds: gemini --model X --prompt-file <tmp> --output-format json
Gemini >=0.40: "Unknown arguments: prompt-file, promptFile" + prints --help to stderr (visible in ~/.pair-programmer/logs/pp-daemon-*.log).
CLI now requires -p/--prompt; "Appended to input on stdin (if any)."

Fix: pass -p "" to enable headless and pipe prompt via stdin (runCliWithRetry already supports input, codex wrapper uses the same pattern).

## Root cause #2 — codex critique injects synthesized recap

Both wrappers prepend synthesizeRecap(cwd, vendor) when no prior session exists. Reasonable for generate, wrong for critique (should be stateless per-artifact). gpt-5.4 reads the recap as conversational history and replies with the templated "paste the recap" meta-prompt.

Fix: add skip_recap flag to GenerateSchema, set it from {codex,gemini}Critique.

## Patch A — daemon/src/mcp/gemini-server.ts (mirror in dist/mcp/gemini-server.js)

Add skip_recap?: z.boolean().optional() to GenerateSchema.

Replace lines 73-75:
  if (!existing) {
    const recap = synthesizeRecap(args.cwd, "gemini");
    if (recap) prompt = \`\${recap}\n\${prompt}\`;
  }
With:
  if (!existing && !args.skip_recap) {
    const recap = synthesizeRecap(args.cwd, "gemini");
    if (recap) prompt = \`\${recap}\n\${prompt}\`;
  }

Replace lines 82-88 (promptPath/writeFileSync + cliArgs):
  const promptPath = join(tmpDir, "prompt.md");
  writeFileSync(promptPath, prompt, "utf8");
  // ... old comment ...
  const cliArgs = ["--model", args.model, "--prompt-file", promptPath, "--output-format", "json"];
With:
  // gemini >=0.40 removed --prompt-file. Use -p "" for headless mode, pipe prompt via stdin.
  const cliArgs = ["--model", args.model, "-p", "", "--output-format", "json"];

Add input: prompt to the runCliWithRetry call:
  const run = await runCliWithRetry({ bin: "gemini", cliArgs, cwd: args.cwd, vendor: "gemini", input: prompt, timeout_ms: args.timeout_ms });

In geminiCritique, pass skip_recap: true to the geminiGenerate call.

## Patch B — daemon/src/mcp/codex-server.ts (mirror in dist/mcp/codex-server.js)

Add skip_recap?: z.boolean().optional() to GenerateSchema.

Change else branch on line 88-91:
  } else {
    const recap = synthesizeRecap(args.cwd, "codex");
    if (recap) prompt = \`\${recap}\n\${prompt}\`;
  }
To:
  } else if (!args.skip_recap) {
    const recap = synthesizeRecap(args.cwd, "codex");
    if (recap) prompt = \`\${recap}\n\${prompt}\`;
  }

In codexCritique's codexGenerate({...}) call, add skip_recap: true.

## Recommended doctor improvements

- After CLI/login checks, run a tiny smoke critique against each non-claude wrapper.
- Fail cross_vendor_ready if exit_code != 0, text empty, or templated reply detected (input_tokens > 5000 with score: {} and outcome: revise).
- Surface effective cliArgs in doctor output for flag-incompat visibility.

## Verification

  echo "Reply PONG only." | gemini --model gemini-2.5-pro -p "" --output-format json
  # expect exit 0 + JSON containing "response": "PONG"

After patches, pp_codex.critique and pp_gemini.critique should return real verdicts (not score: {}, not exit 1).

## File touchpoints (for upstream PR)

- daemon/src/mcp/gemini-server.ts — Patch A
- daemon/src/mcp/codex-server.ts — Patch B
- daemon/src/orchestrator/runs.ts:585-586 — verify smoke-test args don't reuse --prompt-file
- daemon/src/mcp/harness-server.ts (doctor) — add real critique smoke-test

## Root cause #3 — pp_harness ListTools fails on ZodEffects (`record_verdict`)

Symptom: Claude Code reports `pp_harness` as `connected · tools fetch failed` with:
```
{ "code": "invalid_value", "values": ["object"], "path": ["tools", 3, "inputSchema", "type"] }
```
None of the harness MCP tools register. Judge agents can't call `record_verdict`. `run-finalizer` can't call `finalize_run`. Driver oscillates between "delegate" and "tools missing" with no way to make progress. This is the load-bearing bug behind the "harness is unbound" pattern users have hit since MCP SDK >=1.29 started enforcing `inputSchema.type === "object"`.

Root cause: `daemon/src/mcp/helpers.ts:30-58` ships a hand-rolled `zodToJsonSchema` converter with cases for `ZodObject`, `ZodOptional`, `ZodNullable`, `ZodDefault`, `ZodArray`, `ZodEnum`, `ZodLiteral`, `ZodUnion`, primitives, and `ZodRecord` — but **no case for `ZodEffects`**. `.refine()` / `.transform()` / `.preprocess()` all wrap the underlying type in `ZodEffects`. When the converter sees one, it falls through to the final `return {}`, producing a JSON Schema with no `type` field. MCP SDK 1.29 validates each tool's `inputSchema` against `{ type: "object", … }` and aborts the entire ListTools response on the first failure.

Tool index 3 in the harness is `record_verdict`; its schema is `z.object({…}).refine(…).refine(…)` (anti-vacuous-pass guard added late). It was the only tool with `.refine()` in any of the three MCP servers, which is why this never showed up under earlier SDK versions and why the failure was specifically at `tools[3]`.

## Patch D — daemon/src/mcp/helpers.ts (mirror in dist/mcp/helpers.js)

Add a `ZodEffects` unwrap clause before the array case. The runtime refinements still fire via `.parse()` in the tool handler — only the JSON-Schema shape is published from the inner type.

```ts
// .refine() / .transform() / .preprocess() wrap the underlying type in
// ZodEffects. The MCP SDK requires inputSchema.type === "object" at the
// root, so we unwrap to the inner schema for shape discovery; runtime
// validation still runs the refinements via .parse() in the handler.
if (schema instanceof z.ZodEffects) return zodToJsonSchema(schema._def.schema);
```

Verification:
```
node --input-type=module -e "import { zodToJsonSchema } from './dist/mcp/helpers.js'; import { z } from 'zod'; const s = z.object({a: z.string()}).refine(v => true); console.log(zodToJsonSchema(s).type);"
# expect: object
```

After reconnecting the `pp_harness` MCP server in Claude Code (`/mcp` reconnect or session restart), `tools fetch` should succeed and all 30+ harness tools should appear in sub-agent surfaces. This removes the load-bearing cause of the "judge agents can't record verdicts" / "run-finalizer can't finalize" cascade observed during `run_v8h3RqEujCHo`.

## Root cause #3.5 — gemini wrapper passed `--session <uuid>` (Unknown argument)

Symptom (most recent failure: `pp-test/.harness/critique_failures/gemini_1778161037789.txt`):
```
cli_args_sanitized: ["--model","gemini-3.1-pro-preview","-p","","--output-format","json","--session","2ff87935-..."]
stderr: Unknown argument: session
```
The fresh-call path worked after Patch A; the resume path crashed because `--session` was never a valid gemini CLI flag. The valid flags are `--session-id <UUID>` (start a fresh session with a manual UUID) and `-r/--resume <id>` (resume a prior session). The harness's session-continuity logic wants resume.

## Patch C — daemon/src/mcp/gemini-server.ts (mirror in dist/mcp/gemini-server.js)

Single-line change:
```ts
// before
if (existing) cliArgs.push("--session", existing.session_id);
// after
if (existing) cliArgs.push("--resume", existing.session_id);
```

Verified live against `gemini-cli@0.41.2`:
- Fresh call: `gemini --model gemini-3.1-pro-preview -p "" --output-format json` (with prompt on stdin) → exit 0, valid JSON, returns `session_id`.
- Resume call: `gemini --model gemini-3.1-pro-preview -p "" --output-format json --resume <uuid-from-fresh>` → exit 0, valid JSON, same `session_id` echoed back.

This was the load-bearing bug for `/pp:team ux-team` runs in `pp-test`: every cross-vendor judge call after the first session created in a project would fail at the second turn with "Unknown argument: session", aborting the run.

## Root cause #4 — pp_codex.critique honored caller-supplied model, drivers passed bogus ids

Symptom: codex critique calls fail intermittently with "model not found" / "model not served" / silent exit-1, blocking entire runs at the spec/code judge gate. Root cause: Claude Code drivers (Opus 4.7) sometimes invent codex model ids when delegating to the cross-vendor judge — `gpt-5.5`, `gpt-5-codex`, `o1`, etc. — instead of the documented `gpt-5.4`. The wrapper passed `args.model` straight through to `codex --model <X>` with no validation. The judge agent prompts said "use gpt-5.4" but agents-prompts-as-contract is one-sided enforcement.

The user's `~/.codex/config.toml` also has `model_reasoning_effort = "xhigh"` as a global default, which is correct for interactive use but not what we want for critique calls (we want deterministic `high`).

## Patch E — daemon/src/mcp/codex-server.ts (mirror in dist/mcp/codex-server.js)

Two changes, both belt-and-suspenders against agent-side contract violations:

1. **Pin the critique model.** `codexCritique` now ignores `args.model` if it isn't `DEFAULT_MODELS.codex_critique` (`gpt-5.4`), warns to stderr, and substitutes the pinned value. The judge agent prompts still require `gpt-5.4` — the wrapper enforcement is the second line of defense.

2. **Pin the critique reasoning effort.** Added `reasoning_effort` to `GenerateSchema` (enum: `minimal | low | medium | high | xhigh`); when set, `codexGenerate` pushes `--config model_reasoning_effort=<value>` into `cliArgs`. `codexCritique` always sets `reasoning_effort: "high"`.

Effect: `codex exec --json --cd <cwd> --sandbox read-only --model gpt-5.4 --config model_reasoning_effort=high -` is the deterministic shape every critique invocation now emits, regardless of what the calling agent passed.

Generate calls (`engineer` etc.) remain configurable — the pinning is critique-only.

**Verification (after `/mcp` reconnect of pp_codex):** call `pp_codex.critique` with `model: "gpt-5.5"` (deliberately wrong); the wrapper should emit the stderr warning, override to gpt-5.4, and the codex CLI should accept the call. No more "model not found" failures from this class.

## Root cause #5 — gemini default `gemini-3-pro` was never a valid id

Symptom: every gemini call defaulting to `gemini-3-pro` (or any agent passing it) failed silently with `ModelNotFoundError: Requested entity was not found.` — exit-1, empty output. Same outcome users had been treating as "gemini auth flaky" or "CLI version drift".

Root cause: `gemini-3-pro` is not, and was never, a real model id served by the `@google/gemini-cli` (verified at v0.41.2). The real id for the gemini-3 generation is `gemini-3.1-pro-preview` (preview suffix is part of the id, not a flag). The harness defaults were wrong from the start.

Hard verification (CLI smoke against the live API):
- `gemini -m gemini-3-pro …` → **404 ModelNotFoundError** (id doesn't exist)
- `gemini -m gemini-3.1-pro` → **404 ModelNotFoundError**
- `gemini -m gemini-3.1-pro-preview` → **429 capacity** (id is real, just rate-limited)
- `gemini -m gemini-2.5-pro` → 429 capacity (real, valid)
- `gemini -m gemini-2.5-flash` → 200 OK (real, valid)

## Patch F — replace `gemini-3-pro` → `gemini-3.1-pro-preview` everywhere

Touched files:
- `daemon/src/config.ts` — `DEFAULT_MODELS.gemini_generate`
- `daemon/dist/config.js` — same
- `daemon/prices.json` — pricing key (kept same $7/$21 per-1M placeholder; user should verify against Google's current preview pricing)
- `.claude/agents/engineer.md` — 2 references (input doc + Path C default)
- `.claude/agents/judge-cross-vendor.md` — security/spec gate model
- `.claude/agents/judge-same-vendor.md` — generator→judge mapping
- `docs/USER_GUIDE.md` — 2 references (best-of-N example + pp_gemini schema doc)

Per user policy ("no 2.x anything for anything when 3.x is available"), all active gemini defaults and judge mappings are now `gemini-3.1-pro-preview`:
- `DEFAULT_MODELS.gemini_generate` = `gemini-3.1-pro-preview`
- `DEFAULT_MODELS.gemini_critique` = `gemini-3.1-pro-preview` (was `gemini-2.5-pro`)
- `judge-cross-vendor.md`: `gemini-3.1-pro-preview` for all gate types (was split between code/contract → 2.5-pro and security/spec → 3-pro)
- `judge-same-vendor.md`: `gemini-3.1-pro-preview` for both generator and judge. The same-vendor different-model invariant cannot be honored on the gemini lane right now — only one 3.x id is served. Result is **degenerate same-vendor critique** (model grading its own output). When a second 3.x id ships (e.g., a 3.x flash variant), restore the invariant. Per user policy, never fall back to gemini-2.x.

`gemini-2.5-pro` and `gemini-2.5-flash` remain in `prices.json` only as historical lookup data — no active code path references them.

**Verification (after `/mcp` reconnect of pp_gemini):** call `pp_gemini.generate` and `pp_gemini.critique` with no `model` arg; both schema defaults should now resolve to `gemini-3.1-pro-preview`.
