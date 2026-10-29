# Covenant port of the pair-programmer agents (TASK-019, trial)

Trial port of the 42 agents in `.claude/agents` and `.github/agents` to Covenant sources in `covenant/`, built for the `claude` and `copilot` targets into `covenant/out/`. The repository's own agent files are unchanged. Every number below comes from a command run on this branch.

## Result in one paragraph

All 42 agents import, `cov check` exits 0 with 143 warnings (all W0205) and no errors, `cov fmt --check` is clean, and `cov build --target claude,copilot` and `cov check --emitted` exit 0 with 343 warnings and no errors. Round 2 spells every `Read`/`Write`/`Edit`/`Bash`/`Glob`/`Grep` as an effect (`fs.read("**")`, `fs.write("**")`, `shell("*")`) and adds `invariant ... = forbid harness("X")` rules for the Claude tool names the effects add beyond the original list. The Claude effective tool set (emitted `tools` minus `disallowedTools`) equals the original for 42 of 42 agents (`covenant/compare-tools.mjs`, exit 0), and the script exits 1 when one tool is removed from a copy of the output (run recorded below). The Copilot side keeps the aliases (`read`, `search`, `edit`, `execute`) and matches the mirrors' capabilities for 35 of 42 agents; 7 differ: the 5 agents whose Claude list has a lone `Read` also get the read-only alias `search`, and `browser-validator` and `pair-programmer-orchestrator` get `tools: []` where the mirrors have no `tools` key. The prompt text of 41 of 42 agents is identical to the original apart from appended sections (`reflexion-coach` differs, gap 3). Still different on Copilot: `modelPolicy: "required"` on the 40 agents with a model (changes fallback behavior), the Copilot prompts keep Claude tool names for 11 agents, and every agent with rules gets a "Rules" section appended on both targets. These are language gaps, not agent bugs.

## Versions and counts

- Covenant CLI: `cov 0.0.0`, commit `3901fe74962d52d16dbb4b6b271934df5a422331` (Covenant `main`), run as `node /home/user/covenant/packages/cli/dist/bin.js`.
- Agents: 42 in `.claude/agents`, 42 in `.github/agents`; `.cov` files: 42 (one per agent) plus `covenant/covenant.toml`.
- Emitted files: 42 Claude + 42 Copilot = 84.
- Bytes: sources 224694 (`.cov`) + 517 (`covenant.toml`); emitted 231120 Claude + 226756 Copilot = 457876; originals 197775 (`.claude/agents`) + 202142 (`.github/agents`) = 399917.
- Verification: `node covenant/compare-tools.mjs` exit 0; `cov check` exit 0; `cov fmt --check` exit 0; `cov build` exit 0 (84 written into a fresh directory); `cov check --emitted --target claude,copilot --out out` exit 0.

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

- **`harness("Read"/"Write"/"Edit"/"Bash"/"Glob")`** placeholders (round 2): replaced in the 35 agents that had them. `Read`/`Glob`/`Grep` become `fs.read("**")`, `Write`/`Edit` become `fs.write("**")`, `Bash` becomes `shell("*")` (duplicates collapsed). The effects add Claude tool names the originals do not list, so each such agent's covenant forbids them (next bullet). `harness("Skill")` is the spec's own example of a harness tool (LANGUAGE.md §6, Effects: `harness("SendMessage")`, `harness("Skill")`) and has no Copilot alias, so it stays. The VS Code style names (`browser/…`, `execute/…`, `read/…`, `search/…`) in browser-validator and pair-programmer-orchestrator also stay: mapping them to `fs.read`/`shell` would give Claude Bash/Read/Grep that the originals do not list. Round 1 kept `harness("Write")` etc. for exact Claude tools and Copilot lost `edit`/`execute`/`read`; round 2 fixes both.
- **MCP tools** stay as the named `mcp.pp_harness.<tool>`, `mcp.pp_codex.<tool>`, `mcp.pp_agy.<tool>` the Claude files list; the Copilot emitter writes each as `server/tool`, so nothing was dropped and no `tool mcp.…` declaration was needed. `mcp.pp_harness.*` was rejected: with undeclared tools it emits no entry on either target (scratch test), and with declared tools Claude still lists none while Copilot lists only the declared ones. Declaring the whole server would also widen every agent beyond the tools its Claude file names, so it was not done. Result: Copilot grants the named tools, narrower than the mirrors' `pp_harness/*`, `pp_codex/*`, `pp_agy/*`.
- **Covenant rules**: each agent keeps the importer's own covenant (`<Agent>Imported`), required because `require_covenant` is true. In the 35 agents whose effects add Claude tool names, it now holds one `invariant <id> "exact tools" = forbid harness("X")` per added name (`NotebookEdit` in 28 agents, `PowerShell` in 3, `Grep` in 6, `Glob` in 5) under one comment line saying the rules only remove tool names the effects add, so the Claude tools equal the original. The other 7 agents keep the "No rules" comment. The rules are not agent behavior; they exist to produce `disallowedTools`.
- **Budget**: left as imported. 42 `TODO(import): budget not present in source` comments remain (the originals have no budget); `triage` and `profile-loader` carry `budget { turns: 6 }` from their `maxTurns`.
- **Copilot prompt differences (11 agents)**: the importer kept the mirror prompt as comments. Those comments were removed after checking each mirror against its Claude prompt (below). The differences are the sync script's mechanical rewrite only; no real content differs. LANGUAGE.md has no per-target prompt construct, so the Copilot output uses the Claude prompt and records the difference here.
- **`copilot-model` (pair-programmer-orchestrator)**: carried. The agent uses `model super` and `covenant.toml` maps `super` to `claude-sonnet-5` for `claude` and `gpt-5.4` for `copilot`; the output is `model: claude-sonnet-5` and `model: "gpt-5.4"`. `super` is used by that agent alone. The original `copilot-model` key was removed from `extra claude` because the mapping now carries it. (A `"claude-sonnet-5" ?? "gpt-5.4"` chain would make Copilot write both models.)
- **YAML comments** in the frontmatter of 7 Claude files (engineer, judge-cross-vendor, judge-same-vendor, pair-programmer-orchestrator, profile-loader, security-reviewer, triage) were not imported (importer warning); they were copied into the `.cov` files as `//` comments. They are not emitted: the mirrors keep them as an HTML comment in the body, the Covenant output does not.
- `cov fmt` was run on the sources (see Gaps, item 1). The built output is identical before and after.

## Tools

Claude: 42 agents have exactly the original effective tool set (emitted `tools` minus `disallowedTools`), 0 have extra tool names, 0 miss a tool. 35 agents carry `disallowedTools`; the other 7 (the MCP-only and VS Code-name agents) have none.
Copilot: 35 agents match the mirror's capabilities (aliases `read`, `search`, `edit`, `execute` and MCP tools), 7 differ (below). 40 agents list named MCP tools (`pp_harness/archive_artifact`, ...) where the mirror has `pp_harness/*`; that is narrower, as in the Claude originals, and is not counted as a difference.

How it works. `fs.write("**")` emits `Edit`, `NotebookEdit`, `Write` for Claude and `edit` for Copilot; `shell("*")` emits `Bash`, `PowerShell` and `execute`; `fs.read("**")` emits `Read`, `Grep`, `Glob` and `read`, `search`. A `forbid harness("X")` rule makes the Claude emitter list `X` in `disallowedTools`, and Claude Code removes disallowed tools, so the effective set equals the original while Copilot keeps its aliases. This spelling was found by an independent review; the checks here are `compare-tools.mjs` (below) and `cov check --emitted`. That Claude Code honors `disallowedTools` in the emitted agent files comes from that review's scratch test; it was not re-run here (see Load check).

What remains different on Copilot:
- 5 agents whose Claude list has a lone `Read` (agents-md-author, judge-cross-vendor, judge-same-vendor, master-plan-patcher, profile-loader) now also get `search`, a read-only alias the mirrors lacked.
- `browser-validator` and `pair-programmer-orchestrator` have no `tools` key in the mirror and the Covenant output writes `tools: []`. The emitter's own comment says an empty list disables every tool, so these two lose their default tool set on Copilot, the orchestrator being the Copilot CLI's active agent. This is the worst regression in the port; it was not tested on a Copilot CLI, and no Covenant construct can omit the key (gap 5).
- `modelPolicy: "required"` is added to the 40 Copilot agents that have a model (the 2 judges without a model have none). The mirrors omit it, and it changes fallback behavior: a model that is unavailable is an error rather than a substitution.
- The Copilot prompts keep Claude tool names for the 11 agents listed under Mirror prompts (gap 7), and every agent with rules gets a "Rules" section appended on both targets (L0202), which states the `forbid harness(...)` rules as prose.
- Copilot grants the named MCP tools, not `pp_harness/*`, `pp_codex/*`, `pp_agy/*`.

## Diagnostics from `cov check` and `cov build` (343 warnings in `build` and `check --emitted`, no errors)

`cov check` prints 143 warnings, all W0205, exit 0. `cov build` and `cov check --emitted` print the same 343 lines.

| Code | Count | Target(s) | Meaning for the agents |
|---|---|---|---|
| L0201 | 79 | claude 37, copilot 42 | tool allowlist cannot be expressed exactly. Claude: 37 agents get an "Allowed tools" section appended to the prompt (the `tools` list is still written); Copilot: all 42 agents get a "Tools" section (the CLI may add default tools to the list). |
| L0202 | 70 | claude 35, copilot 35 | the target cannot express the forbid rules; they are written as prompt text under "Rules". On Claude the `disallowedTools` list still denies the tools; the prose is extra. On Copilot the rules are prose only, and they restate tool names that Copilot never grants (`NotebookEdit`, `PowerShell`, `Grep`, `Glob`). |
| L0203 | 2 | copilot 2 | Copilot cannot enforce `budget.turns`; the limit is appended as prose (triage, profile-loader). |
| L0206 | 7 | copilot 7 | Copilot cannot preload `skills`; they are appended as prose (the 7 agents with `skills`). |
| W0205 | 143 | check, build | a `forbid harness("X")` rule applies to an agent that declares an MCP tool whose effects are unknown (there is no `tool mcp` declaration), so the checker cannot prove the tool does not reach `X`; "the runtime enforces it". By rule: NotebookEdit 81, Grep 30, Glob 22, PowerShell 10. |
| W0215 | 42 | copilot 42 | `extra copilot { "target": "github-copilot" }` is reported as a VS Code-only key the CLI table lacks; it is written as given, as in the mirrors. |

There is no W0216 (every model resolves), no L0204 to L0205, L0207 to L0210.

## Per-agent table

Columns: Claude effective tools same as the original; Copilot tools same as the mirror ("extra search" = lone `Read` also grants `search`; "pp_harness/* -> N named" = named tools narrower than the mirror's wildcard, not a mismatch); model same (Claude and Copilot); prompt same as the original apart from the generated header and the appended sections named in Notes.

| Agent | Claude tools | Copilot tools | Model | Prompt | Notes |
|---|---|---|---|---|---|
| agents-md-author | yes | no (pp_harness/* -> 5 named; extra search) | yes | yes | appends "Allowed tools", "Rules" (Claude); "Tools", "Rules" (Copilot); mirror prompt differs from Claude in 3 line(s), tool names/paths only; Copilot gains `modelPolicy` |
| ai-controls-author | yes | yes (pp_harness/* -> 2 named) | yes | yes | appends "Allowed tools", "Rules" (Claude); "Tools", "Rules" (Copilot); Copilot gains `modelPolicy` |
| api-designer | yes | yes (pp_harness/* -> 2 named) | yes | yes | appends "Allowed tools", "Rules" (Claude); "Tools", "Rules" (Copilot); mirror prompt differs from Claude in 1 line(s), tool names/paths only; Copilot gains `modelPolicy` |
| architect | yes | yes (pp_harness/* -> 2 named) | yes | yes | appends "Allowed tools", "Rules" (Claude); "Tools", "Rules" (Copilot); mirror prompt differs from Claude in 2 line(s), tool names/paths only; Copilot gains `modelPolicy` |
| browser-validator | yes | no (mirror has no `tools` key; emitted `tools: []`) | yes | yes | appends "Allowed tools" (Claude); "Tools" (Copilot); mirror prompt differs from Claude in 4 line(s), tool names/paths only; Copilot gains `modelPolicy` |
| data-modeler | yes | yes (pp_harness/* -> 2 named) | yes | yes | appends "Allowed tools", "Rules" (Claude); "Tools", "Rules" (Copilot); Copilot gains `modelPolicy` |
| design-system-curator | yes | yes (pp_harness/* -> 2 named) | yes | yes | appends "Allowed tools", "Rules" (Claude); "Tools", "Rules", "Skills" (Copilot); mirror prompt differs from Claude in 1 line(s), tool names/paths only; Copilot gains `modelPolicy`; skills: Claude native, Copilot prose |
| designer | yes | yes (pp_harness/* -> 2 named) | yes | yes | appends "Allowed tools", "Rules" (Claude); "Tools", "Rules", "Skills" (Copilot); Copilot gains `modelPolicy`; skills: Claude native, Copilot prose |
| discovery-researcher | yes | yes (pp_harness/* -> 2 named) | yes | yes | appends "Allowed tools", "Rules" (Claude); "Tools", "Rules" (Copilot); Copilot gains `modelPolicy` |
| docs-author | yes | yes (pp_codex/* -> 1 named; pp_harness/* -> 2 named) | yes | yes | appends "Allowed tools", "Rules" (Claude); "Tools", "Rules" (Copilot); Copilot gains `modelPolicy` |
| economy-designer | yes | yes (pp_agy/* -> 1 named; pp_codex/* -> 1 named; pp_harness/* -> 2 named) | yes | yes | appends "Allowed tools", "Rules" (Claude); "Tools", "Rules" (Copilot); Copilot gains `modelPolicy` |
| encounter-designer | yes | yes (pp_agy/* -> 1 named; pp_codex/* -> 1 named; pp_harness/* -> 2 named) | yes | yes | appends "Allowed tools", "Rules" (Claude); "Tools", "Rules" (Copilot); Copilot gains `modelPolicy` |
| engineer | yes | yes (pp_harness/* -> 3 named) | yes | yes | appends "Allowed tools", "Rules" (Claude); "Tools", "Rules" (Copilot); mirror prompt differs from Claude in 6 line(s), tool names/paths only; Copilot gains `modelPolicy` |
| game-accessibility-specialist | yes | yes (pp_agy/* -> 1 named; pp_codex/* -> 1 named; pp_harness/* -> 2 named) | yes | yes | appends "Allowed tools", "Rules" (Claude); "Tools", "Rules" (Copilot); Copilot gains `modelPolicy` |
| game-ai-programmer | yes | yes (pp_agy/* -> 1 named; pp_codex/* -> 1 named; pp_harness/* -> 2 named) | yes | yes | appends "Allowed tools", "Rules" (Claude); "Tools", "Rules" (Copilot); Copilot gains `modelPolicy` |
| game-security | yes | yes (pp_agy/* -> 1 named; pp_codex/* -> 1 named; pp_harness/* -> 2 named) | yes | yes | appends "Allowed tools", "Rules" (Claude); "Tools", "Rules" (Copilot); Copilot gains `modelPolicy`; original YAML invalid; emitted parses |
| governance-author | yes | yes (pp_harness/* -> 2 named) | yes | yes | appends "Allowed tools", "Rules" (Claude); "Tools", "Rules" (Copilot); Copilot gains `modelPolicy` |
| judge-cross-vendor | yes | no (pp_agy/* -> 1 named; pp_codex/* -> 1 named; pp_harness/* -> 2 named; extra search) | yes (none) | yes | appends "Allowed tools", "Rules" (Claude); "Tools", "Rules", "Skills" (Copilot); Copilot gains `reasoningEffort`; skills: Claude native, Copilot prose |
| judge-router | yes | yes (pp_harness/* -> 1 named) | yes | yes | appends nothing (Claude); "Tools", "Skills" (Copilot); Copilot gains `modelPolicy`; skills: Claude native, Copilot prose |
| judge-same-vendor | yes | no (pp_agy/* -> 1 named; pp_codex/* -> 1 named; pp_harness/* -> 2 named; extra search) | yes (none) | yes | appends "Allowed tools", "Rules" (Claude); "Tools", "Rules", "Skills" (Copilot); mirror prompt differs from Claude in 1 line(s), tool names/paths only; original YAML invalid; emitted parses; skills: Claude native, Copilot prose |
| level-designer | yes | yes (pp_agy/* -> 1 named; pp_codex/* -> 1 named; pp_harness/* -> 2 named) | yes | yes | appends "Allowed tools", "Rules" (Claude); "Tools", "Rules" (Copilot); Copilot gains `modelPolicy` |
| live-ops-manager | yes | yes (pp_agy/* -> 1 named; pp_codex/* -> 1 named; pp_harness/* -> 2 named) | yes | yes | appends "Allowed tools", "Rules" (Claude); "Tools", "Rules" (Copilot); Copilot gains `modelPolicy`; original YAML invalid; emitted parses |
| master-plan-patcher | yes | no (pp_harness/* -> 4 named; extra search) | yes | yes | appends "Allowed tools", "Rules" (Claude); "Tools", "Rules", "Skills" (Copilot); mirror prompt differs from Claude in 3 line(s), tool names/paths only; Copilot gains `modelPolicy`; skills: Claude native, Copilot prose |
| missability-inspector | yes | yes (pp_harness/* -> 2 named) | yes | yes | appends nothing (Claude); "Tools" (Copilot); Copilot gains `modelPolicy`, `reasoningEffort` |
| narrative-designer | yes | yes (pp_agy/* -> 1 named; pp_codex/* -> 1 named; pp_harness/* -> 2 named) | yes | yes | appends "Allowed tools", "Rules" (Claude); "Tools", "Rules" (Copilot); Copilot gains `modelPolicy` |
| netcode-programmer | yes | yes (pp_agy/* -> 1 named; pp_codex/* -> 1 named; pp_harness/* -> 2 named) | yes | yes | appends "Allowed tools", "Rules" (Claude); "Tools", "Rules" (Copilot); Copilot gains `modelPolicy`; original YAML invalid; emitted parses |
| ops-author | yes | yes (pp_harness/* -> 2 named) | yes | yes | appends "Allowed tools", "Rules" (Claude); "Tools", "Rules" (Copilot); Copilot gains `modelPolicy` |
| pair-programmer-orchestrator | yes | no (mirror has no `tools` key; emitted `tools: []`) | yes | yes | appends "Allowed tools" (Claude); "Tools" (Copilot); mirror prompt differs from Claude in 2 line(s), tool names/paths only; Copilot gains `modelPolicy`; Copilot model gpt-5.4 carried via `super` tier mapping |
| profile-loader | yes | no (pp_harness/* -> 5 named; extra search) | yes | yes | appends "Allowed tools", "Rules" (Claude); "Tools", "Rules", "Budget" (Copilot); Copilot gains `modelPolicy`, `reasoningEffort` |
| reflexion-coach | yes | yes (pp_harness/* -> 2 named) | yes | no (doubled braces, gap 3) | appends nothing (Claude); "Tools" (Copilot); Copilot gains `modelPolicy` |
| release-planner | yes | yes (pp_harness/* -> 2 named) | yes | yes | appends "Allowed tools", "Rules" (Claude); "Tools", "Rules" (Copilot); Copilot gains `modelPolicy` |
| retirement-planner | yes | yes (pp_harness/* -> 2 named) | yes | yes | appends "Allowed tools", "Rules" (Claude); "Tools", "Rules" (Copilot); Copilot gains `modelPolicy` |
| run-finalizer | yes | yes (pp_harness/* -> 8 named) | yes | yes | appends "Allowed tools", "Rules" (Claude); "Tools", "Rules" (Copilot); Copilot gains `modelPolicy`, `reasoningEffort` |
| security-reviewer | yes | yes (pp_harness/* -> 2 named) | yes | yes | appends "Allowed tools", "Rules" (Claude); "Tools", "Rules" (Copilot); Copilot gains `modelPolicy`, `reasoningEffort` |
| spec-author | yes | yes (pp_harness/* -> 2 named) | yes | yes | appends "Allowed tools", "Rules" (Claude); "Tools", "Rules" (Copilot); mirror prompt differs from Claude in 2 line(s), tool names/paths only; Copilot gains `modelPolicy` |
| strategy-author | yes | yes (pp_harness/* -> 2 named) | yes | yes | appends "Allowed tools", "Rules" (Claude); "Tools", "Rules" (Copilot); Copilot gains `modelPolicy` |
| taxonomy-mapper | yes | yes (pp_harness/* -> 3 named) | yes | yes | appends nothing (Claude); "Tools", "Skills" (Copilot); Copilot gains `modelPolicy`, `reasoningEffort`; skills: Claude native, Copilot prose |
| tech-animator | yes | yes (pp_agy/* -> 1 named; pp_codex/* -> 1 named; pp_harness/* -> 2 named) | yes | yes | appends "Allowed tools", "Rules" (Claude); "Tools", "Rules" (Copilot); Copilot gains `modelPolicy` |
| technical-artist | yes | yes (pp_agy/* -> 1 named; pp_codex/* -> 1 named; pp_harness/* -> 2 named) | yes | yes | appends "Allowed tools", "Rules" (Claude); "Tools", "Rules" (Copilot); Copilot gains `modelPolicy` |
| test-strategist | yes | yes (pp_codex/* -> 1 named; pp_harness/* -> 2 named) | yes | yes | appends "Allowed tools", "Rules" (Claude); "Tools", "Rules" (Copilot); mirror prompt differs from Claude in 2 line(s), tool names/paths only; Copilot gains `modelPolicy` |
| triage | yes | yes (pp_harness/* -> 1 named) | yes | yes | appends nothing (Claude); "Tools", "Budget" (Copilot); Copilot gains `modelPolicy`, `reasoningEffort` |
| visual-regression-runner | yes | yes (pp_harness/* -> 4 named) | yes | yes | appends "Allowed tools", "Rules" (Claude); "Tools", "Rules" (Copilot); Copilot gains `modelPolicy` |

## Mirror prompts versus Claude prompts

11 mirrors differ from their Claude prompt beyond the generated banner and the preserved-comments block: agents-md-author, api-designer, architect, browser-validator, design-system-curator, engineer, judge-same-vendor, master-plan-patcher, pair-programmer-orchestrator, spec-author, test-strategist. In every case each differing line pair is the same text with Claude tool names (`Read`, `Write`, `Edit`, `Glob`, `Grep`, `Bash`) replaced by `read`, `edit`, `search`, `execute`, or `.claude/commands/pp/` and `.claude/agents/` paths replaced by `.github/...` ones, i.e. the sync script's mechanical rewrite (checked line by line, 0 other differences; `engineer`'s mirror description has the same rewrite). That is not harmless on Copilot: after the port those 11 Copilot prompts tell the model to use `Write`, `Glob` and `Bash`, which are not the granted `edit`, `search`, `execute`, and point at `.claude/` paths instead of `.github/`. It is a behavior regression there. No agent mentions `get_claude_tier_models`, so that rewrite does not occur.

## Original YAML that does not parse strictly

A strict loader (PyYAML `safe_load`) rejects 4 of the 42 `.claude/agents` files ("mapping values are not allowed here": an unquoted `: ` inside `description`): `game-security` (line 3, column 263); `judge-same-vendor` (line 8, column 396); `live-ops-manager` (line 3, column 207); `netcode-programmer` (line 3, column 232). Claude Code 2.1.312 loads all four anyway: a headless session in a folder holding only the original `.claude/agents` lists all 42 agents in its init event (48 with the 6 built-ins), so its loader is more lenient than PyYAML. What description it reads from them is unverified. The importer accepted them silently (no warning). The emitted Claude and Copilot files quote the description, and all 84 emitted files parse strictly, so after the port those four agents become loadable. The original `.github/agents` mirrors parse (the sync script quotes descriptions).

## Covenant bugs and spec gaps

1. `cov import` output is not `cov fmt` clean. Repro: `cov import --out d .claude/agents .github/agents && cd d && cov fmt --check` reports "would reformat" for all 42 files (multi-line `uses` and `extra` blocks that fmt joins). Building before and after `cov fmt` gives identical output.
2. Resolved in round 2, no Covenant change needed: effects plus `forbid harness("X")` rules keep the Claude effective set exact and keep the Copilot aliases (see Tools). Cost: the rules are written as prose under "Rules" on both targets (L0202), and W0205 fires for every MCP tool next to a rule (143). A rule that only exists to subtract tool names reads as a policy in the output, which is not what it means.
3. `{{` in a prompt is not unescaped by the emitters (Covenant issue #47). LANGUAGE.md §1 says `{{` renders as `{`, and `cov import` writes the original `{{critique_md}}` as `{{{{critique_md}}}}` accordingly, but `cov build` writes the prompt text raw, so `reflexion-coach` is emitted with `{{{{critique_md}}}}` and its 8 other placeholders doubled, on both targets. The source keeps the spec-correct form, so the output becomes faithful once #47 is fixed; writing `{{x}}` in the source would hide the bug and break when it is fixed.
4. `mcp.S.*` emits no entry in the Claude `tools` list, with or without `tool mcp.S.T` declarations (`covenant/architect.cov` with `uses mcp.pp_harness.*`); Copilot lists only declared tools. There is no way to write the mirrors' `pp_harness/*`.
5. Copilot always gets `tools: [...]` (`[]` when empty) and, with any model, `modelPolicy: "required"` (`covenant/browser-validator.cov` gets `tools: []`, `covenant/triage.cov` gets `modelPolicy`). Neither can be omitted (`tools` and `modelPolicy` are governed keys, so `extra copilot` cannot set them). The mirrors omit both.
6. `extra copilot { "target": "github-copilot" }` is W0215 on all 42 agents, although the mirrors in this repository carry that key. Only the report can say whether the Copilot CLI honors it.
7. No per-target prompt text: the Copilot prompt cannot use `edit`/`search`/`execute` while the Claude prompt uses `Write`/`Glob`/`Bash` (11 agents, see above).
8. No way to give one agent a different model per target except a tier mapping: `pair-programmer-orchestrator.cov` uses `model super` with `[models.claude]`/`[models.copilot]` `super` entries. This is a workaround, not a documented use of `super`.
9. `cov import` accepts YAML that a strict loader rejects (`.claude/agents/game-security.md` line 3: `cov import --out d .claude/agents` prints no warning).
10. Frontmatter YAML comments cannot be emitted: `//` comments in `.cov` are not copied to the output, so rationale (e.g. `maxTurns=6` in `triage`) is lost from the Claude and Copilot files; the mirrors keep it as an HTML comment.

## Decisions made without asking

- Round 2: effects plus `forbid harness(...)` rules instead of `harness(...)` names, so Claude stays exact and Copilot keeps its aliases. Rules were derived from the measured difference (`compare-tools.mjs` before the rules: extra `NotebookEdit` in 28 agents, `PowerShell` in 3, `Grep` in 6, `Glob` in 5), not guessed.
- Rule ids `no_nb`, `no_ps`, `no_grep`, `no_glob` with the description "exact tools", as in the review's scratch test; the rule block carries one comment line stating what the rules do.
- Left the 7 agents with no added tool names (MCP-only, VS Code names) without rules.
- `compare-tools.mjs` counts a missing Copilot `tools` key versus `tools: []` as a Copilot difference, though both lists are empty; the empty list disables tools, the missing key does not. It exits non-zero only for Claude differences, as asked.
- Amended the first round-2 commit to include that script fix before the report was written (nothing pushed).
- Kept MCP tools as the named tools instead of `mcp.S.*`, so no agent got a tool its Claude file does not list.
- Used `super` for the orchestrator's Copilot model, and dropped its `copilot-model` key from `extra claude`.
- Kept `reflexion-coach`'s spec-correct `{{{{x}}}}` source, accepting the doubled braces in the output until #47 is fixed (gap 3).
- `super` appears only in `pair-programmer-orchestrator.cov` (`grep -l "model super" covenant/*.cov`); any new agent using it would get gpt-5.4 on Copilot.
- Committed `covenant/out` (the verification commands read it).

## Load check

- Round 1 output, not re-run for round 2 (the new `disallowedTools` key is untested here). Claude Code 2.1.312, headless, Haiku: a folder holding only `covenant/out/.claude/agents` lists all 42 agents in the session's init event, the same 42 as the originals. With `covenant/out/.github/agents` added beside it, the count is unchanged: Claude Code reads only `.claude/agents`.
- Copilot CLI: not run. It is not installed in the cloud session and needs a GitHub sign-in, so whether it loads the emitted files, and which copy it prefers when it sees both `.github/agents` and `.claude/agents`, is unverified.

## Reproduce the numbers

From the repository root, with `cov` = `node /home/user/covenant/packages/cli/dist/bin.js`: `cd covenant && cov check`; `cov fmt --check`; `cov build --target claude,copilot --out out`; `cov check --emitted --target claude,copilot --out out` (warning counts are its output lines by code); `cov import --out <dir> .claude/agents .github/agents` for the import log; `wc -c` over `covenant/*.cov`, `covenant/out/.claude/agents/*`, `covenant/out/.github/agents/*`, `.claude/agents/*.md`, `.github/agents/*.agent.md` for bytes; `grep -c "TODO(import)" covenant/*.cov` for the remaining TODOs; `node covenant/compare-tools.mjs` for the tools comparison below.

## `compare-tools.mjs` output

`node covenant/compare-tools.mjs` from the repository root (exit 0). For each agent: the Claude effective set (emitted `tools` minus `disallowedTools`) against `.claude/agents/NAME.md`, and the emitted Copilot capabilities against `.github/agents/NAME.agent.md`. Only the `tools` line of each original is read (comma string, YAML list and inline list are handled; 4 originals fail a strict YAML parser).

```
agents-md-author
  claude: effective set equals original: yes (original 6, effective 6, disallowed 2)
  copilot: differs from mirror
    only in emitted: search
    named, narrower than the mirror's wildcard (not a mismatch): pp_harness/agents_md_status, pp_harness/apply_agents_md_patch, pp_harness/ensure_agents_md, pp_harness/list_taxonomy_sections, pp_harness/master_plan_status
ai-controls-author
  claude: effective set equals original: yes (original 7, effective 7, disallowed 1)
  copilot: matches mirror
    named, narrower than the mirror's wildcard (not a mismatch): pp_harness/archive_artifact, pp_harness/record_attempt
api-designer
  claude: effective set equals original: yes (original 7, effective 7, disallowed 1)
  copilot: matches mirror
    named, narrower than the mirror's wildcard (not a mismatch): pp_harness/archive_artifact, pp_harness/record_attempt
architect
  claude: effective set equals original: yes (original 7, effective 7, disallowed 1)
  copilot: matches mirror
    named, narrower than the mirror's wildcard (not a mismatch): pp_harness/archive_artifact, pp_harness/record_attempt
browser-validator
  claude: effective set equals original: yes (original 23, effective 23, disallowed 0)
  copilot: differs from mirror
    mirror has no `tools` key; emitted has `tools: []`
data-modeler
  claude: effective set equals original: yes (original 7, effective 7, disallowed 1)
  copilot: matches mirror
    named, narrower than the mirror's wildcard (not a mismatch): pp_harness/archive_artifact, pp_harness/record_attempt
design-system-curator
  claude: effective set equals original: yes (original 8, effective 8, disallowed 1)
  copilot: matches mirror
    named, narrower than the mirror's wildcard (not a mismatch): pp_harness/archive_artifact, pp_harness/record_attempt
designer
  claude: effective set equals original: yes (original 8, effective 8, disallowed 1)
  copilot: matches mirror
    named, narrower than the mirror's wildcard (not a mismatch): pp_harness/archive_artifact, pp_harness/record_attempt
discovery-researcher
  claude: effective set equals original: yes (original 7, effective 7, disallowed 1)
  copilot: matches mirror
    named, narrower than the mirror's wildcard (not a mismatch): pp_harness/archive_artifact, pp_harness/record_attempt
docs-author
  claude: effective set equals original: yes (original 8, effective 8, disallowed 1)
  copilot: matches mirror
    named, narrower than the mirror's wildcard (not a mismatch): pp_codex/generate, pp_harness/archive_artifact, pp_harness/record_attempt
economy-designer
  claude: effective set equals original: yes (original 10, effective 10, disallowed 1)
  copilot: matches mirror
    named, narrower than the mirror's wildcard (not a mismatch): pp_agy/generate, pp_codex/generate, pp_harness/archive_artifact, pp_harness/record_attempt
encounter-designer
  claude: effective set equals original: yes (original 10, effective 10, disallowed 1)
  copilot: matches mirror
    named, narrower than the mirror's wildcard (not a mismatch): pp_agy/generate, pp_codex/generate, pp_harness/archive_artifact, pp_harness/record_attempt
engineer
  claude: effective set equals original: yes (original 9, effective 9, disallowed 2)
  copilot: matches mirror
    named, narrower than the mirror's wildcard (not a mismatch): pp_harness/archive_artifact, pp_harness/record_attempt, pp_harness/record_smoke_status
game-accessibility-specialist
  claude: effective set equals original: yes (original 9, effective 9, disallowed 1)
  copilot: matches mirror
    named, narrower than the mirror's wildcard (not a mismatch): pp_agy/generate, pp_codex/generate, pp_harness/archive_artifact, pp_harness/record_attempt
game-ai-programmer
  claude: effective set equals original: yes (original 9, effective 9, disallowed 1)
  copilot: matches mirror
    named, narrower than the mirror's wildcard (not a mismatch): pp_agy/generate, pp_codex/generate, pp_harness/archive_artifact, pp_harness/record_attempt
game-security
  claude: effective set equals original: yes (original 9, effective 9, disallowed 1)
  copilot: matches mirror
    named, narrower than the mirror's wildcard (not a mismatch): pp_agy/generate, pp_codex/generate, pp_harness/archive_artifact, pp_harness/record_attempt
governance-author
  claude: effective set equals original: yes (original 7, effective 7, disallowed 1)
  copilot: matches mirror
    named, narrower than the mirror's wildcard (not a mismatch): pp_harness/archive_artifact, pp_harness/record_attempt
judge-cross-vendor
  claude: effective set equals original: yes (original 5, effective 5, disallowed 2)
  copilot: differs from mirror
    only in emitted: search
    named, narrower than the mirror's wildcard (not a mismatch): pp_agy/critique, pp_codex/critique, pp_harness/get_rubric, pp_harness/record_verdict
judge-router
  claude: effective set equals original: yes (original 1, effective 1, disallowed 0)
  copilot: matches mirror
    named, narrower than the mirror's wildcard (not a mismatch): pp_harness/gate_eligible_judges
judge-same-vendor
  claude: effective set equals original: yes (original 5, effective 5, disallowed 2)
  copilot: differs from mirror
    only in emitted: search
    named, narrower than the mirror's wildcard (not a mismatch): pp_agy/critique, pp_codex/critique, pp_harness/get_rubric, pp_harness/record_verdict
level-designer
  claude: effective set equals original: yes (original 10, effective 10, disallowed 1)
  copilot: matches mirror
    named, narrower than the mirror's wildcard (not a mismatch): pp_agy/generate, pp_codex/generate, pp_harness/archive_artifact, pp_harness/record_attempt
live-ops-manager
  claude: effective set equals original: yes (original 9, effective 9, disallowed 1)
  copilot: matches mirror
    named, narrower than the mirror's wildcard (not a mismatch): pp_agy/generate, pp_codex/generate, pp_harness/archive_artifact, pp_harness/record_attempt
master-plan-patcher
  claude: effective set equals original: yes (original 5, effective 5, disallowed 2)
  copilot: differs from mirror
    only in emitted: search
    named, narrower than the mirror's wildcard (not a mismatch): pp_harness/apply_master_plan_patch, pp_harness/ensure_master_plan, pp_harness/list_taxonomy_sections, pp_harness/master_plan_status
missability-inspector
  claude: effective set equals original: yes (original 2, effective 2, disallowed 0)
  copilot: matches mirror
    named, narrower than the mirror's wildcard (not a mismatch): pp_harness/list_missability_checks, pp_harness/run_missability_checks
narrative-designer
  claude: effective set equals original: yes (original 10, effective 10, disallowed 1)
  copilot: matches mirror
    named, narrower than the mirror's wildcard (not a mismatch): pp_agy/generate, pp_codex/generate, pp_harness/archive_artifact, pp_harness/record_attempt
netcode-programmer
  claude: effective set equals original: yes (original 9, effective 9, disallowed 1)
  copilot: matches mirror
    named, narrower than the mirror's wildcard (not a mismatch): pp_agy/generate, pp_codex/generate, pp_harness/archive_artifact, pp_harness/record_attempt
ops-author
  claude: effective set equals original: yes (original 7, effective 7, disallowed 1)
  copilot: matches mirror
    named, narrower than the mirror's wildcard (not a mismatch): pp_harness/archive_artifact, pp_harness/record_attempt
pair-programmer-orchestrator
  claude: effective set equals original: yes (original 10, effective 10, disallowed 0)
  copilot: differs from mirror
    mirror has no `tools` key; emitted has `tools: []`
profile-loader
  claude: effective set equals original: yes (original 6, effective 6, disallowed 2)
  copilot: differs from mirror
    only in emitted: search
    named, narrower than the mirror's wildcard (not a mismatch): pp_harness/detect_profile, pp_harness/get_builtin_profile, pp_harness/get_profile, pp_harness/list_profiles, pp_harness/write_profile
reflexion-coach
  claude: effective set equals original: yes (original 2, effective 2, disallowed 0)
  copilot: matches mirror
    named, narrower than the mirror's wildcard (not a mismatch): pp_harness/list_prior_critiques, pp_harness/retry_with_critique
release-planner
  claude: effective set equals original: yes (original 7, effective 7, disallowed 1)
  copilot: matches mirror
    named, narrower than the mirror's wildcard (not a mismatch): pp_harness/archive_artifact, pp_harness/record_attempt
retirement-planner
  claude: effective set equals original: yes (original 7, effective 7, disallowed 1)
  copilot: matches mirror
    named, narrower than the mirror's wildcard (not a mismatch): pp_harness/archive_artifact, pp_harness/record_attempt
run-finalizer
  claude: effective set equals original: yes (original 10, effective 10, disallowed 1)
  copilot: matches mirror
    named, narrower than the mirror's wildcard (not a mismatch): pp_harness/apply_master_plan_patch, pp_harness/archive_artifact, pp_harness/archive_winner_and_losers, pp_harness/ensure_master_plan, pp_harness/finalize_run, pp_harness/get_run, pp_harness/master_plan_status, pp_harness/teardown_candidates
security-reviewer
  claude: effective set equals original: yes (original 7, effective 7, disallowed 1)
  copilot: matches mirror
    named, narrower than the mirror's wildcard (not a mismatch): pp_harness/archive_artifact, pp_harness/record_attempt
spec-author
  claude: effective set equals original: yes (original 7, effective 7, disallowed 1)
  copilot: matches mirror
    named, narrower than the mirror's wildcard (not a mismatch): pp_harness/archive_artifact, pp_harness/record_attempt
strategy-author
  claude: effective set equals original: yes (original 7, effective 7, disallowed 1)
  copilot: matches mirror
    named, narrower than the mirror's wildcard (not a mismatch): pp_harness/archive_artifact, pp_harness/record_attempt
taxonomy-mapper
  claude: effective set equals original: yes (original 3, effective 3, disallowed 0)
  copilot: matches mirror
    named, narrower than the mirror's wildcard (not a mismatch): pp_harness/list_taxonomy_sections, pp_harness/map_taxonomy, pp_harness/record_taxonomy_mapping
tech-animator
  claude: effective set equals original: yes (original 9, effective 9, disallowed 1)
  copilot: matches mirror
    named, narrower than the mirror's wildcard (not a mismatch): pp_agy/generate, pp_codex/generate, pp_harness/archive_artifact, pp_harness/record_attempt
technical-artist
  claude: effective set equals original: yes (original 9, effective 9, disallowed 1)
  copilot: matches mirror
    named, narrower than the mirror's wildcard (not a mismatch): pp_agy/generate, pp_codex/generate, pp_harness/archive_artifact, pp_harness/record_attempt
test-strategist
  claude: effective set equals original: yes (original 9, effective 9, disallowed 2)
  copilot: matches mirror
    named, narrower than the mirror's wildcard (not a mismatch): pp_codex/generate, pp_harness/archive_artifact, pp_harness/record_attempt
triage
  claude: effective set equals original: yes (original 1, effective 1, disallowed 0)
  copilot: matches mirror
    named, narrower than the mirror's wildcard (not a mismatch): pp_harness/triage_request
visual-regression-runner
  claude: effective set equals original: yes (original 8, effective 8, disallowed 1)
  copilot: matches mirror
    named, narrower than the mirror's wildcard (not a mismatch): pp_harness/archive_artifact, pp_harness/record_attempt, pp_harness/visual_regression_capture, pp_harness/visual_regression_diff

agents: 42
claude effective set differs from original: 0
copilot differs from mirror (excluding named-narrower): 7
copilot agents with named tools narrower than a mirror wildcard: 40
```

### The script failing once

The output was copied to a scratch directory and the `Grep` line removed from `out/.claude/agents/architect.md`; `node covenant/compare-tools.mjs <that directory>` then exits 1. The `architect` block and the summary of that run (the other 41 agents report as above):

```
architect
  claude: effective set equals original: NO (original 7, effective 6, disallowed 1)
    missing from emitted: Grep
  copilot: matches mirror
    named, narrower than the mirror's wildcard (not a mismatch): pp_harness/archive_artifact, pp_harness/record_attempt
agents: 42
claude effective set differs from original: 1
copilot differs from mirror (excluding named-narrower): 7
copilot agents with named tools narrower than a mirror wildcard: 40
exit status: 1
```
