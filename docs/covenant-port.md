# Covenant port of the pair-programmer agents (TASK-019, trial)

Trial port of the 42 agents in `.claude/agents` and `.github/agents` to Covenant sources in `covenant/`, built for the `claude` and `copilot` targets into `covenant/out/`. The repository's own agent files are unchanged. Every number below comes from a command run on this branch.

## Result in one paragraph

All 42 agents import, `cov check` is clean (exit 0, no diagnostics), `cov fmt --check` is clean, and `cov build --target claude,copilot` and `cov check --emitted` exit 0 with 124 warnings and no errors. The Claude `tools` lists are exactly the originals' for 42 of 42 agents, and the prompt text of 41 of 42 agents is identical to the original apart from appended sections where the target cannot enforce a setting (`reflexion-coach` differs, gap 3). The Copilot side is **not** equivalent: no Covenant effect grants an exact Claude tool and its Copilot alias, so the exact Claude names cost every agent that uses `Write`/`Edit`/`Bash` (or a lone `Read`) its Copilot `edit`/`execute`/`read` (see Tools). The Copilot output also always carries a `tools` list and, with a model, `modelPolicy`, and the Copilot prompts keep Claude tool names. These are language gaps, not agent bugs.

## Versions and counts

- Covenant CLI: `cov 0.0.0`, commit `3901fe74962d52d16dbb4b6b271934df5a422331` (Covenant `main`), run as `node /home/user/covenant/packages/cli/dist/bin.js`.
- Agents: 42 in `.claude/agents`, 42 in `.github/agents`; `.cov` files: 42 (one per agent) plus `covenant/covenant.toml`.
- Emitted files: 42 Claude + 42 Copilot = 84.
- Bytes: sources 224758 (`.cov`) + 517 (`covenant.toml`); emitted 214438 Claude + 229162 Copilot = 443600; originals 197775 (`.claude/agents`) + 202142 (`.github/agents`) = 399917.
- Verification: `cov check` exit 0; `cov fmt --check` exit 0; `cov build` exit 0 (84 written); `cov check --emitted --target claude,copilot --out out` exit 0.

## Import log (`cov import --out covenant .claude/agents .github/agents`)

Exit 0, "42 agents imported", 178 warnings (the import warnings carry no codes). By kind:

- 84: key has no Covenant construct, passed through in `extra` (`color`, `target`, `copilot-model`)
- 40: `server/*` Copilot entry imported as `mcp.server.*`
- 42: Copilot file differs from the Claude file (tools, prompt, model, effort, description); Claude side imported
- 11:   of those, the Copilot prompt differs and was kept as comments under a TODO
- 7: YAML comments in the frontmatter are not imported
- 5: `read` listed without `search`; file-read effect grants both aliases

The importer wrote 130 `TODO(import)` comments. By kind: covenant rules not present in source: 42; budget not present in source (incl. `usd, tokens and wall`): 42; harness(...) placeholder: 35; Copilot mirror's prompt differs: 11.

## How the TODOs were resolved

- **`harness("Read"/"Write"/"Edit"/"Bash"/"Glob")`** placeholders: kept as `harness(...)` wherever the original Claude list is not a complete tool group, because the task forbids widening and `harness("Write")` is the only spelling that grants exactly `Write` on Claude (`fs.write("**")` also grants `NotebookEdit`; `shell("*")` also `PowerShell`; `fs.read("**")` also `Grep`/`Glob`). A complete group (Read+Grep+Glob together, 29 agents) is `fs.read("**")`, exact on both targets. Cost: a `harness(...)` effect is dropped on Copilot (L0201, scratch test on `architect.cov`), so those agents lose `edit`, `execute` or `read` there. The TODO text was replaced by a comment saying so. `harness("Skill")` is the spec's own example of a harness tool (LANGUAGE.md §6, Effects: `harness("SendMessage")`, `harness("Skill")`) and has no Copilot alias, so it stays. The VS Code style names (`browser/…`, `execute/…`, `read/…`, `search/…`) in browser-validator and pair-programmer-orchestrator also stay: mapping them to `fs.read`/`shell` would give Claude Bash/Read/Grep that the originals do not list, and the Claude originals grant them to Claude only.
- **MCP tools** stay as the named `mcp.pp_harness.<tool>`, `mcp.pp_codex.<tool>`, `mcp.pp_agy.<tool>` the Claude files list; the Copilot emitter writes each as `server/tool`, so nothing was dropped and no `tool mcp.…` declaration was needed. `mcp.pp_harness.*` was rejected: with undeclared tools it emits no entry on either target (scratch test), and with declared tools Claude still lists none while Copilot lists only the declared ones. Declaring the whole server would also widen every agent beyond the tools its Claude file names, so it was not done. Result: Copilot grants the named tools, narrower than the mirrors' `pp_harness/*`, `pp_codex/*`, `pp_agy/*`.
- **Covenant rules**: each agent keeps the importer's own empty covenant (`<Agent>Imported`, no invariants), required because `require_covenant` is true. The TODO was replaced by a plain comment that the originals declare no rules. No rule was invented.
- **Budget**: left as imported. 42 `TODO(import): budget not present in source` comments remain (the originals have no budget); `triage` and `profile-loader` carry `budget { turns: 6 }` from their `maxTurns`.
- **Copilot prompt differences (11 agents)**: the importer kept the mirror prompt as comments. Those comments were removed after checking each mirror against its Claude prompt (below). The differences are the sync script's mechanical rewrite only; no real content differs. LANGUAGE.md has no per-target prompt construct, so the Copilot output uses the Claude prompt and records the difference here.
- **`copilot-model` (pair-programmer-orchestrator)**: carried. The agent uses `model super` and `covenant.toml` maps `super` to `claude-sonnet-5` for `claude` and `gpt-5.4` for `copilot`; the output is `model: claude-sonnet-5` and `model: "gpt-5.4"`. `super` is used by that agent alone. The original `copilot-model` key was removed from `extra claude` because the mapping now carries it. (A `"claude-sonnet-5" ?? "gpt-5.4"` chain would make Copilot write both models.)
- **YAML comments** in the frontmatter of 7 Claude files (engineer, judge-cross-vendor, judge-same-vendor, pair-programmer-orchestrator, profile-loader, security-reviewer, triage) were not imported (importer warning); they were copied into the `.cov` files as `//` comments. They are not emitted: the mirrors keep them as an HTML comment in the body, the Covenant output does not.
- `cov fmt` was run on the sources (see Gaps, item 1). The built output is identical before and after.

## Tools

Claude: 42 agents have exactly the original tool set, 0 have the original set plus extra tool names, 0 miss a tool.
Copilot: 0 agents have exactly the mirror's tool set, 42 do not.

Spelling a tool as an effect widens Claude by tool name: `fs.write("**")` writes `Edit`, `NotebookEdit`, `Write`; `shell("*")` writes `Bash` and `PowerShell`; a lone `Read` as `fs.read("**")` writes `Read`, `Grep`, `Glob`. Spelling it as `harness(...)` is exact on Claude but Copilot drops it. No single effect gives both, so the port follows the task's no-widening rule and accepts the Copilot loss. The port does not widen Claude to buy Copilot parity: widening is a permission change, and the real fix is in Covenant (an effect that names one tool on every target, gap 2), not in these sources. The widening variant was tried in commit 22ebf8e and reverted.
Copilot differences from the mirrors: (a) the agents above lose the aliases the Claude `Read`/`Write`/`Edit`/`Bash` map to in the mirrors (per-agent column, "missing"); (b) `pp_harness/*`, `pp_codex/*`, `pp_agy/*` become the named tools of the Claude file (narrower, as in the Claude originals); (c) `browser-validator` and `pair-programmer-orchestrator` have no `tools` key in the mirror, and the Covenant output writes `tools: []`. The emitter's own comment says an empty list disables every tool, so these two lose their default tool set on Copilot, the orchestrator being the Copilot CLI's active agent. This is the worst regression in the port; it was not tested on a Copilot CLI, and no Covenant construct can omit the key (gap 5).

## Diagnostics from `cov build` (124, all warnings, no errors)

| Code | Count | Target(s) | Meaning for the agents |
|---|---|---|---|
| L0201 | 73 | claude 31, copilot 42 | tool allowlist cannot be expressed exactly. Claude: 31 agents get an "Allowed tools" section appended to the prompt (the `tools` list is still written); Copilot: all 42 agents get a "Tools" section (the CLI may add default tools to the list). The 11 Claude agents with only exact MCP tools have none. |
| L0203 | 2 | copilot 2 | Copilot cannot enforce `budget.turns`; the limit is appended as prose (triage, profile-loader). |
| L0206 | 7 | copilot 7 | Copilot cannot preload `skills`; they are appended as prose (the 7 agents with `skills`). |
| W0215 | 42 | copilot 42 | `extra copilot { "target": "github-copilot" }` is reported as a VS Code-only key the CLI table lacks; it is written as given, as in the mirrors. |

`cov check` reports nothing. There is no W0216 (every model resolves), no L0202 (no rules), no L0204 to L0205, L0207 to L0210.

## Per-agent table

Columns: Claude tools same as the original; Copilot tools same as the mirror; model same (Claude and Copilot); prompt same as the original apart from the generated header and the appended sections named in Notes. "yes (+X)" means all original tools are granted plus the named extras.

| Agent | Claude tools | Copilot tools | Model | Prompt | Notes |
|---|---|---|---|---|---|
| agents-md-author | yes | no (pp_harness/* -> 5 named; missing read) | yes | yes | appends nothing (Claude); "Tools" (Copilot); mirror prompt differs from Claude in 3 line(s), tool names/paths only; Copilot gains `modelPolicy` |
| ai-controls-author | yes | no (pp_harness/* -> 2 named; missing edit) | yes | yes | appends "Allowed tools" (Claude); "Tools" (Copilot); Copilot gains `modelPolicy` |
| api-designer | yes | no (pp_harness/* -> 2 named; missing edit) | yes | yes | appends "Allowed tools" (Claude); "Tools" (Copilot); mirror prompt differs from Claude in 1 line(s), tool names/paths only; Copilot gains `modelPolicy` |
| architect | yes | no (pp_harness/* -> 2 named; missing edit) | yes | yes | appends "Allowed tools" (Claude); "Tools" (Copilot); mirror prompt differs from Claude in 2 line(s), tool names/paths only; Copilot gains `modelPolicy` |
| browser-validator | yes | no (mirror has no `tools` key; emitted `tools: []`) | yes | yes | appends "Allowed tools" (Claude); "Tools" (Copilot); mirror prompt differs from Claude in 4 line(s), tool names/paths only; Copilot gains `modelPolicy` |
| data-modeler | yes | no (pp_harness/* -> 2 named; missing edit) | yes | yes | appends "Allowed tools" (Claude); "Tools" (Copilot); Copilot gains `modelPolicy` |
| design-system-curator | yes | no (pp_harness/* -> 2 named; missing edit) | yes | yes | appends "Allowed tools" (Claude); "Tools", "Skills" (Copilot); mirror prompt differs from Claude in 1 line(s), tool names/paths only; Copilot gains `modelPolicy`; skills: Claude native, Copilot prose |
| designer | yes | no (pp_harness/* -> 2 named; missing edit) | yes | yes | appends "Allowed tools" (Claude); "Tools", "Skills" (Copilot); Copilot gains `modelPolicy`; skills: Claude native, Copilot prose |
| discovery-researcher | yes | no (pp_harness/* -> 2 named; missing edit) | yes | yes | appends "Allowed tools" (Claude); "Tools" (Copilot); Copilot gains `modelPolicy` |
| docs-author | yes | no (pp_codex/* -> 1 named; pp_harness/* -> 2 named; missing edit) | yes | yes | appends "Allowed tools" (Claude); "Tools" (Copilot); Copilot gains `modelPolicy` |
| economy-designer | yes | no (pp_agy/* -> 1 named; pp_codex/* -> 1 named; pp_harness/* -> 2 named; missing edit) | yes | yes | appends "Allowed tools" (Claude); "Tools" (Copilot); Copilot gains `modelPolicy` |
| encounter-designer | yes | no (pp_agy/* -> 1 named; pp_codex/* -> 1 named; pp_harness/* -> 2 named; missing edit) | yes | yes | appends "Allowed tools" (Claude); "Tools" (Copilot); Copilot gains `modelPolicy` |
| engineer | yes | no (pp_harness/* -> 3 named; missing edit, execute) | yes | yes | appends "Allowed tools" (Claude); "Tools" (Copilot); mirror prompt differs from Claude in 6 line(s), tool names/paths only; Copilot gains `modelPolicy` |
| game-accessibility-specialist | yes | no (pp_agy/* -> 1 named; pp_codex/* -> 1 named; pp_harness/* -> 2 named; missing edit) | yes | yes | appends "Allowed tools" (Claude); "Tools" (Copilot); Copilot gains `modelPolicy` |
| game-ai-programmer | yes | no (pp_agy/* -> 1 named; pp_codex/* -> 1 named; pp_harness/* -> 2 named; missing edit) | yes | yes | appends "Allowed tools" (Claude); "Tools" (Copilot); Copilot gains `modelPolicy` |
| game-security | yes | no (pp_agy/* -> 1 named; pp_codex/* -> 1 named; pp_harness/* -> 2 named; missing edit) | yes | yes | appends "Allowed tools" (Claude); "Tools" (Copilot); Copilot gains `modelPolicy`; original YAML invalid; emitted parses |
| governance-author | yes | no (pp_harness/* -> 2 named; missing edit) | yes | yes | appends "Allowed tools" (Claude); "Tools" (Copilot); Copilot gains `modelPolicy` |
| judge-cross-vendor | yes | no (pp_agy/* -> 1 named; pp_codex/* -> 1 named; pp_harness/* -> 2 named; missing read) | yes (none) | yes | appends nothing (Claude); "Tools", "Skills" (Copilot); Copilot gains `reasoningEffort`; skills: Claude native, Copilot prose |
| judge-router | yes | no (pp_harness/* -> 1 named) | yes | yes | appends nothing (Claude); "Tools", "Skills" (Copilot); Copilot gains `modelPolicy`; skills: Claude native, Copilot prose |
| judge-same-vendor | yes | no (pp_agy/* -> 1 named; pp_codex/* -> 1 named; pp_harness/* -> 2 named; missing read) | yes (none) | yes | appends nothing (Claude); "Tools", "Skills" (Copilot); mirror prompt differs from Claude in 1 line(s), tool names/paths only; original YAML invalid; emitted parses; skills: Claude native, Copilot prose |
| level-designer | yes | no (pp_agy/* -> 1 named; pp_codex/* -> 1 named; pp_harness/* -> 2 named; missing edit) | yes | yes | appends "Allowed tools" (Claude); "Tools" (Copilot); Copilot gains `modelPolicy` |
| live-ops-manager | yes | no (pp_agy/* -> 1 named; pp_codex/* -> 1 named; pp_harness/* -> 2 named; missing edit) | yes | yes | appends "Allowed tools" (Claude); "Tools" (Copilot); Copilot gains `modelPolicy`; original YAML invalid; emitted parses |
| master-plan-patcher | yes | no (pp_harness/* -> 4 named; missing read) | yes | yes | appends nothing (Claude); "Tools", "Skills" (Copilot); mirror prompt differs from Claude in 3 line(s), tool names/paths only; Copilot gains `modelPolicy`; skills: Claude native, Copilot prose |
| missability-inspector | yes | no (pp_harness/* -> 2 named) | yes | yes | appends nothing (Claude); "Tools" (Copilot); Copilot gains `modelPolicy`, `reasoningEffort` |
| narrative-designer | yes | no (pp_agy/* -> 1 named; pp_codex/* -> 1 named; pp_harness/* -> 2 named; missing edit) | yes | yes | appends "Allowed tools" (Claude); "Tools" (Copilot); Copilot gains `modelPolicy` |
| netcode-programmer | yes | no (pp_agy/* -> 1 named; pp_codex/* -> 1 named; pp_harness/* -> 2 named; missing edit) | yes | yes | appends "Allowed tools" (Claude); "Tools" (Copilot); Copilot gains `modelPolicy`; original YAML invalid; emitted parses |
| ops-author | yes | no (pp_harness/* -> 2 named; missing edit) | yes | yes | appends "Allowed tools" (Claude); "Tools" (Copilot); Copilot gains `modelPolicy` |
| pair-programmer-orchestrator | yes | no (mirror has no `tools` key; emitted `tools: []`) | yes | yes | appends "Allowed tools" (Claude); "Tools" (Copilot); mirror prompt differs from Claude in 2 line(s), tool names/paths only; Copilot gains `modelPolicy`; Copilot model gpt-5.4 carried via `super` tier mapping |
| profile-loader | yes | no (pp_harness/* -> 5 named; missing read) | yes | yes | appends nothing (Claude); "Tools", "Budget" (Copilot); Copilot gains `modelPolicy`, `reasoningEffort` |
| reflexion-coach | yes | no (pp_harness/* -> 2 named) | yes | no (doubled braces, gap 3) | appends nothing (Claude); "Tools" (Copilot); Copilot gains `modelPolicy` |
| release-planner | yes | no (pp_harness/* -> 2 named; missing edit) | yes | yes | appends "Allowed tools" (Claude); "Tools" (Copilot); Copilot gains `modelPolicy` |
| retirement-planner | yes | no (pp_harness/* -> 2 named; missing edit) | yes | yes | appends "Allowed tools" (Claude); "Tools" (Copilot); Copilot gains `modelPolicy` |
| run-finalizer | yes | no (pp_harness/* -> 8 named; missing read, search) | yes | yes | appends nothing (Claude); "Tools" (Copilot); Copilot gains `modelPolicy`, `reasoningEffort` |
| security-reviewer | yes | no (pp_harness/* -> 2 named; missing edit) | yes | yes | appends "Allowed tools" (Claude); "Tools" (Copilot); Copilot gains `modelPolicy`, `reasoningEffort` |
| spec-author | yes | no (pp_harness/* -> 2 named; missing edit) | yes | yes | appends "Allowed tools" (Claude); "Tools" (Copilot); mirror prompt differs from Claude in 2 line(s), tool names/paths only; Copilot gains `modelPolicy` |
| strategy-author | yes | no (pp_harness/* -> 2 named; missing edit) | yes | yes | appends "Allowed tools" (Claude); "Tools" (Copilot); Copilot gains `modelPolicy` |
| taxonomy-mapper | yes | no (pp_harness/* -> 3 named) | yes | yes | appends nothing (Claude); "Tools", "Skills" (Copilot); Copilot gains `modelPolicy`, `reasoningEffort`; skills: Claude native, Copilot prose |
| tech-animator | yes | no (pp_agy/* -> 1 named; pp_codex/* -> 1 named; pp_harness/* -> 2 named; missing edit) | yes | yes | appends "Allowed tools" (Claude); "Tools" (Copilot); Copilot gains `modelPolicy` |
| technical-artist | yes | no (pp_agy/* -> 1 named; pp_codex/* -> 1 named; pp_harness/* -> 2 named; missing edit) | yes | yes | appends "Allowed tools" (Claude); "Tools" (Copilot); Copilot gains `modelPolicy` |
| test-strategist | yes | no (pp_codex/* -> 1 named; pp_harness/* -> 2 named; missing edit, execute) | yes | yes | appends "Allowed tools" (Claude); "Tools" (Copilot); mirror prompt differs from Claude in 2 line(s), tool names/paths only; Copilot gains `modelPolicy` |
| triage | yes | no (pp_harness/* -> 1 named) | yes | yes | appends nothing (Claude); "Tools", "Budget" (Copilot); Copilot gains `modelPolicy`, `reasoningEffort` |
| visual-regression-runner | yes | no (pp_harness/* -> 4 named; missing execute) | yes | yes | appends "Allowed tools" (Claude); "Tools" (Copilot); Copilot gains `modelPolicy` |

## Mirror prompts versus Claude prompts

11 mirrors differ from their Claude prompt beyond the generated banner and the preserved-comments block: agents-md-author, api-designer, architect, browser-validator, design-system-curator, engineer, judge-same-vendor, master-plan-patcher, pair-programmer-orchestrator, spec-author, test-strategist. In every case each differing line pair is the same text with Claude tool names (`Read`, `Write`, `Edit`, `Glob`, `Grep`, `Bash`) replaced by `read`, `edit`, `search`, `execute`, or `.claude/commands/pp/` and `.claude/agents/` paths replaced by `.github/...` ones, i.e. the sync script's mechanical rewrite (checked line by line, 0 other differences; `engineer`'s mirror description has the same rewrite). That is not harmless on Copilot: after the port those 11 Copilot prompts tell the model to use `Write`, `Glob` and `Bash`, which are not the granted `edit`, `search`, `execute`, and point at `.claude/` paths instead of `.github/`. It is a behavior regression there. No agent mentions `get_claude_tier_models`, so that rewrite does not occur.

## Original YAML that does not parse strictly

A strict loader (PyYAML `safe_load`) rejects 4 of the 42 `.claude/agents` files ("mapping values are not allowed here": an unquoted `: ` inside `description`): `game-security` (line 3, column 263); `judge-same-vendor` (line 8, column 396); `live-ops-manager` (line 3, column 207); `netcode-programmer` (line 3, column 232). Claude Code 2.1.312 loads all four anyway: a headless session in a folder holding only the original `.claude/agents` lists all 42 agents in its init event (48 with the 6 built-ins), so its loader is more lenient than PyYAML. What description it reads from them is unverified. The importer accepted them silently (no warning). The emitted Claude and Copilot files quote the description, and all 84 emitted files parse strictly, so after the port those four agents become loadable. The original `.github/agents` mirrors parse (the sync script quotes descriptions).

## Covenant bugs and spec gaps

1. `cov import` output is not `cov fmt` clean. Repro: `cov import --out d .claude/agents .github/agents && cd d && cov fmt --check` reports "would reformat" for all 42 files (multi-line `uses` and `extra` blocks that fmt joins). Building before and after `cov fmt` gives identical output.
2. No effect grants exactly one Claude tool and its Copilot alias. `covenant/architect.cov`: `fs.write("**")` emits `Edit`, `NotebookEdit`, `Write` for Claude; `harness("Write"), harness("Edit")` is exact for Claude but the Copilot `tools` list loses `edit` (L0201). Same for `shell("*")` (adds `PowerShell`) and a lone `Read` (`fs.read("**")` adds `Grep`, `Glob`, `search`). The importer's own warning ("the file-read effect grants both aliases when built") points at this.
3. `{{` in a prompt is not unescaped by the emitters (Covenant issue #47). LANGUAGE.md §1 says `{{` renders as `{`, and `cov import` writes the original `{{critique_md}}` as `{{{{critique_md}}}}` accordingly, but `cov build` writes the prompt text raw, so `reflexion-coach` is emitted with `{{{{critique_md}}}}` and its 8 other placeholders doubled, on both targets. The source keeps the spec-correct form, so the output becomes faithful once #47 is fixed; writing `{{x}}` in the source would hide the bug and break when it is fixed.
4. `mcp.S.*` emits no entry in the Claude `tools` list, with or without `tool mcp.S.T` declarations (`covenant/architect.cov` with `uses mcp.pp_harness.*`); Copilot lists only declared tools. There is no way to write the mirrors' `pp_harness/*`.
5. Copilot always gets `tools: [...]` (`[]` when empty) and, with any model, `modelPolicy: "required"` (`covenant/browser-validator.cov` gets `tools: []`, `covenant/triage.cov` gets `modelPolicy`). Neither can be omitted (`tools` and `modelPolicy` are governed keys, so `extra copilot` cannot set them). The mirrors omit both.
6. `extra copilot { "target": "github-copilot" }` is W0215 on all 42 agents, although the mirrors in this repository carry that key. Only the report can say whether the Copilot CLI honors it.
7. No per-target prompt text: the Copilot prompt cannot use `edit`/`search`/`execute` while the Claude prompt uses `Write`/`Glob`/`Bash` (11 agents, see above).
8. No way to give one agent a different model per target except a tier mapping: `pair-programmer-orchestrator.cov` uses `model super` with `[models.claude]`/`[models.copilot]` `super` entries. This is a workaround, not a documented use of `super`.
9. `cov import` accepts YAML that a strict loader rejects (`.claude/agents/game-security.md` line 3: `cov import --out d .claude/agents` prints no warning).
10. Frontmatter YAML comments cannot be emitted: `//` comments in `.cov` are not copied to the output, so rationale (e.g. `maxTurns=6` in `triage`) is lost from the Claude and Copilot files; the mirrors keep it as an HTML comment.

## Decisions made without asking

- Followed the no-widening rule: exact `harness(...)` Claude names where no complete tool group exists, accepting the Copilot loss. The alternative (effects) is described under Tools and needs Rob's decision.
- Kept MCP tools as the named tools instead of `mcp.S.*`, so no agent got a tool its Claude file does not list.
- Used `super` for the orchestrator's Copilot model, and dropped its `copilot-model` key from `extra claude`.
- Kept `reflexion-coach`'s spec-correct `{{{{x}}}}` source, accepting the doubled braces in the output until #47 is fixed (gap 3).
- `super` appears only in `pair-programmer-orchestrator.cov` (`grep -l "model super" covenant/*.cov`); any new agent using it would get gpt-5.4 on Copilot.
- Committed `covenant/out` (the verification commands read it).

## Load check

- Claude Code 2.1.312, headless, Haiku: a folder holding only `covenant/out/.claude/agents` lists all 42 agents in the session's init event, the same 42 as the originals. With `covenant/out/.github/agents` added beside it, the count is unchanged: Claude Code reads only `.claude/agents`.
- Copilot CLI: not run. It is not installed in the cloud session and needs a GitHub sign-in, so whether it loads the emitted files, and which copy it prefers when it sees both `.github/agents` and `.claude/agents`, is unverified.

## Reproduce the numbers

From the repository root, with `cov` = `node /home/user/covenant/packages/cli/dist/bin.js`: `cd covenant && cov check`; `cov fmt --check`; `cov build --target claude,copilot --out out`; `cov check --emitted --target claude,copilot --out out` (warning counts are its output lines by code); `cov import --out <dir> .claude/agents .github/agents` for the import log; `wc -c` over `covenant/*.cov`, `covenant/out/.claude/agents/*`, `covenant/out/.github/agents/*`, `.claude/agents/*.md`, `.github/agents/*.agent.md` for bytes; `grep -c "TODO(import)" covenant/*.cov` for the remaining TODOs.
