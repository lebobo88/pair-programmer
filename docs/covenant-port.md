# Covenant port of the pair-programmer agents (TASK-019, trial)

Trial port of the 42 agents in `.claude/agents` and `.github/agents` to Covenant sources in `covenant/`, built for the `claude` and `copilot` targets into `covenant/out/`. The repository's own agent files are unchanged. Every number below comes from a command run on this branch.

## Result in one paragraph

All 42 agents import, `cov check` is clean (exit 0, no diagnostics), `cov fmt --check` is clean, and `cov build --target claude,copilot` and `cov check --emitted` exit 0 with 130 warnings and no errors. The prompt text of 41 of 42 agents is identical to the original (`reflexion-coach` differs in one placeholder, gap 3), plus appended sections where the target cannot enforce a setting. The port is **not** behavior-identical: no Covenant effect grants exactly the tools the Claude files list **and** the aliases the Copilot mirrors list (see Tools), the Copilot output always carries a `tools` list and, with a model, `modelPolicy`, and the Copilot prompts keep Claude tool names. These are language gaps, not agent bugs.

## Versions and counts

- Covenant CLI: `cov 0.0.0`, commit `3901fe74962d52d16dbb4b6b271934df5a422331` (Covenant `main`), run as `node /home/user/covenant/packages/cli/dist/bin.js`.
- Agents: 42 in `.claude/agents`, 42 in `.github/agents`; `.cov` files: 42 (one per agent) plus `covenant/covenant.toml`.
- Emitted files: 42 Claude + 42 Copilot = 84.
- Bytes: sources 220601 (`.cov`) + 517 (`covenant.toml`); emitted 216439 Claude + 221200 Copilot = 437639; originals 197775 (`.claude/agents`) + 202142 (`.github/agents`) = 399917.
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

- **`harness("Read"/"Write"/"Edit"/"Bash"/"Glob")`** became `fs.read("**")`, `fs.write("**")` and `shell("*")`, the effects each target maps to a file read, edit or shell tool. They are the only effects the Copilot emitter turns into `read`/`search`, `edit` and `execute`; a `harness(...)` effect is dropped on Copilot (L0201, verified with a scratch copy of `architect.cov`: Copilot then lists only the two `pp_harness/` tools). Cost: the Claude `tools` list is wider by tool name, never by capability class (see Tools). `harness("Skill")` and the VS Code style names (`browser/…`, `execute/…`, `read/…`, `search/…`) stay `harness(...)`: they have no Copilot alias, and the originals grant them to Claude only.
- **MCP tools** stay as the named `mcp.pp_harness.<tool>`, `mcp.pp_codex.<tool>`, `mcp.pp_agy.<tool>` the Claude files list; the Copilot emitter writes each as `server/tool`, so nothing was dropped and no `tool mcp.…` declaration was needed. `mcp.pp_harness.*` was rejected: with undeclared tools it emits no entry on either target (scratch test), and with declared tools Claude still lists none while Copilot lists only the declared ones. Declaring the whole server would also widen every agent beyond the tools its Claude file names, so it was not done. Result: Copilot grants the named tools, narrower than the mirrors' `pp_harness/*`, `pp_codex/*`, `pp_agy/*`.
- **Covenant rules**: each agent keeps the importer's own empty covenant (`<Agent>Imported`, no invariants), required because `require_covenant` is true. The TODO was replaced by a plain comment that the originals declare no rules. No rule was invented.
- **Budget**: left as imported. 42 `TODO(import): budget not present in source` comments remain (the originals have no budget); `triage` and `profile-loader` carry `budget { turns: 6 }` from their `maxTurns`.
- **Copilot prompt differences (11 agents)**: the importer kept the mirror prompt as comments. Those comments were removed after checking each mirror against its Claude prompt (below). The differences are the sync script's mechanical rewrite only; no real content differs. LANGUAGE.md has no per-target prompt construct, so the Copilot output uses the Claude prompt and records the difference here.
- **`copilot-model` (pair-programmer-orchestrator)**: carried. The agent uses `model super` and `covenant.toml` maps `super` to `claude-sonnet-5` for `claude` and `gpt-5.4` for `copilot`; the output is `model: claude-sonnet-5` and `model: "gpt-5.4"`. `super` is used by that agent alone. The original `copilot-model` key was removed from `extra claude` because the mapping now carries it. (A `"claude-sonnet-5" ?? "gpt-5.4"` chain would make Copilot write both models.)
- **YAML comments** in the frontmatter of 7 Claude files (engineer, judge-cross-vendor, judge-same-vendor, pair-programmer-orchestrator, profile-loader, security-reviewer, triage) were not imported (importer warning); they were copied into the `.cov` files as `//` comments. They are not emitted: the mirrors keep them as an HTML comment in the body, the Covenant output does not.
- `cov fmt` was run on the sources (see Gaps, item 1). The built output is identical before and after.

## Tools

Claude: 7 agents have exactly the original tool set, 35 have the original set plus extra tool names, 0 miss a tool.
Copilot: 0 agents have exactly the mirror's tool set, 42 do not.

The extra Claude names come from the effects: `fs.write("**")` writes `Edit`, `NotebookEdit`, `Write`; `shell("*")` writes `Bash` and `PowerShell`; `fs.read("**")` writes `Read`, `Grep`, `Glob` (and `read`, `search` on Copilot). Same capability class, more tool names than the originals listed. With `harness("Write")` etc. the Claude list is exact, but Copilot then loses `read`/`search`/`edit`/`execute` (scratch test); with the effects Copilot is exact and Claude is wider. No single effect gives both, so one of the two requirements could not be met. The port chose no loss of capability on either target.
Copilot differences from the mirrors, beyond that: (a) `pp_harness/*`, `pp_codex/*`, `pp_agy/*` become the named tools of the Claude file (narrower, as in the Claude originals); (b) the Claude files listing `Read` without `Grep`/`Glob` (agents-md-author, judge-cross-vendor, judge-same-vendor, master-plan-patcher, profile-loader) gain `search`; (c) `browser-validator` and `pair-programmer-orchestrator` have no `tools` key in the mirror, and the Covenant output writes `tools: []`. The emitter's own comment says an empty list disables every tool, so these two lose their default tool set on Copilot; this was not tested on a Copilot CLI.

## Diagnostics from `cov build` (130, all warnings, no errors)

| Code | Count | Target(s) | Meaning for the agents |
|---|---|---|---|
| L0201 | 79 | claude 37, copilot 42 | tool allowlist cannot be expressed exactly. Claude: 37 agents get an "Allowed tools" section appended to the prompt (the `tools` list is still written); Copilot: all 42 agents get a "Tools" section (the CLI may add default tools to the list). The 5 Claude agents with only exact MCP tools have none. |
| L0203 | 2 | copilot 2 | Copilot cannot enforce `budget.turns`; the limit is appended as prose (triage, profile-loader). |
| L0206 | 7 | copilot 7 | Copilot cannot preload `skills`; they are appended as prose (the 7 agents with `skills`). |
| W0215 | 42 | copilot 42 | `extra copilot { "target": "github-copilot" }` is reported as a VS Code-only key the CLI table lacks; it is written as given, as in the mirrors. |

`cov check` reports nothing. There is no W0216 (every model resolves), no L0202 (no rules), no L0204 to L0205, L0207 to L0210.

## Per-agent table

Columns: Claude tools same as the original; Copilot tools same as the mirror; model same (Claude and Copilot); prompt same as the original apart from headers. "yes (+X)" means all original tools are granted plus the named extras.

| Agent | Claude tools | Copilot tools | Model | Prompt | Notes |
|---|---|---|---|---|---|
| agents-md-author | yes (+Glob, Grep) | no (pp_harness/* -> 5 named; +search) | yes | yes | appends "Allowed tools" (Claude); "Tools" (Copilot); mirror prompt differs from Claude in 3 line(s), tool names/paths only; Copilot gains `modelPolicy` |
| ai-controls-author | yes (+NotebookEdit) | no (pp_harness/* -> 2 named) | yes | yes | appends "Allowed tools" (Claude); "Tools" (Copilot); Copilot gains `modelPolicy` |
| api-designer | yes (+NotebookEdit) | no (pp_harness/* -> 2 named) | yes | yes | appends "Allowed tools" (Claude); "Tools" (Copilot); mirror prompt differs from Claude in 1 line(s), tool names/paths only; Copilot gains `modelPolicy` |
| architect | yes (+NotebookEdit) | no (pp_harness/* -> 2 named) | yes | yes | appends "Allowed tools" (Claude); "Tools" (Copilot); mirror prompt differs from Claude in 2 line(s), tool names/paths only; Copilot gains `modelPolicy` |
| browser-validator | yes | no (mirror has no `tools` key; emitted `tools: []`) | yes | yes | appends "Allowed tools" (Claude); "Tools" (Copilot); mirror prompt differs from Claude in 4 line(s), tool names/paths only; Copilot gains `modelPolicy` |
| data-modeler | yes (+NotebookEdit) | no (pp_harness/* -> 2 named) | yes | yes | appends "Allowed tools" (Claude); "Tools" (Copilot); Copilot gains `modelPolicy` |
| design-system-curator | yes (+NotebookEdit) | no (pp_harness/* -> 2 named) | yes | yes | appends "Allowed tools" (Claude); "Tools", "Skills" (Copilot); mirror prompt differs from Claude in 1 line(s), tool names/paths only; Copilot gains `modelPolicy`; skills: Claude native, Copilot prose |
| designer | yes (+NotebookEdit) | no (pp_harness/* -> 2 named) | yes | yes | appends "Allowed tools" (Claude); "Tools", "Skills" (Copilot); Copilot gains `modelPolicy`; skills: Claude native, Copilot prose |
| discovery-researcher | yes (+NotebookEdit) | no (pp_harness/* -> 2 named) | yes | yes | appends "Allowed tools" (Claude); "Tools" (Copilot); Copilot gains `modelPolicy` |
| docs-author | yes (+NotebookEdit) | no (pp_codex/* -> 1 named; pp_harness/* -> 2 named) | yes | yes | appends "Allowed tools" (Claude); "Tools" (Copilot); Copilot gains `modelPolicy` |
| economy-designer | yes (+NotebookEdit) | no (pp_agy/* -> 1 named; pp_codex/* -> 1 named; pp_harness/* -> 2 named) | yes | yes | appends "Allowed tools" (Claude); "Tools" (Copilot); Copilot gains `modelPolicy` |
| encounter-designer | yes (+NotebookEdit) | no (pp_agy/* -> 1 named; pp_codex/* -> 1 named; pp_harness/* -> 2 named) | yes | yes | appends "Allowed tools" (Claude); "Tools" (Copilot); Copilot gains `modelPolicy` |
| engineer | yes (+NotebookEdit, PowerShell) | no (pp_harness/* -> 3 named) | yes | yes | appends "Allowed tools" (Claude); "Tools" (Copilot); mirror prompt differs from Claude in 6 line(s), tool names/paths only; Copilot gains `modelPolicy` |
| game-accessibility-specialist | yes (+NotebookEdit) | no (pp_agy/* -> 1 named; pp_codex/* -> 1 named; pp_harness/* -> 2 named) | yes | yes | appends "Allowed tools" (Claude); "Tools" (Copilot); Copilot gains `modelPolicy` |
| game-ai-programmer | yes (+NotebookEdit) | no (pp_agy/* -> 1 named; pp_codex/* -> 1 named; pp_harness/* -> 2 named) | yes | yes | appends "Allowed tools" (Claude); "Tools" (Copilot); Copilot gains `modelPolicy` |
| game-security | yes (+NotebookEdit) | no (pp_agy/* -> 1 named; pp_codex/* -> 1 named; pp_harness/* -> 2 named) | yes | yes | appends "Allowed tools" (Claude); "Tools" (Copilot); Copilot gains `modelPolicy`; original YAML invalid; emitted parses |
| governance-author | yes (+NotebookEdit) | no (pp_harness/* -> 2 named) | yes | yes | appends "Allowed tools" (Claude); "Tools" (Copilot); Copilot gains `modelPolicy` |
| judge-cross-vendor | yes (+Glob, Grep) | no (pp_agy/* -> 1 named; pp_codex/* -> 1 named; pp_harness/* -> 2 named; +search) | yes (none) | yes | appends "Allowed tools" (Claude); "Tools", "Skills" (Copilot); Copilot gains `reasoningEffort`; skills: Claude native, Copilot prose |
| judge-router | yes | no (pp_harness/* -> 1 named) | yes | yes | appends nothing (Claude); "Tools", "Skills" (Copilot); Copilot gains `modelPolicy`; skills: Claude native, Copilot prose |
| judge-same-vendor | yes (+Glob, Grep) | no (pp_agy/* -> 1 named; pp_codex/* -> 1 named; pp_harness/* -> 2 named; +search) | yes (none) | yes | appends "Allowed tools" (Claude); "Tools", "Skills" (Copilot); mirror prompt differs from Claude in 1 line(s), tool names/paths only; original YAML invalid; emitted parses; skills: Claude native, Copilot prose |
| level-designer | yes (+NotebookEdit) | no (pp_agy/* -> 1 named; pp_codex/* -> 1 named; pp_harness/* -> 2 named) | yes | yes | appends "Allowed tools" (Claude); "Tools" (Copilot); Copilot gains `modelPolicy` |
| live-ops-manager | yes (+NotebookEdit) | no (pp_agy/* -> 1 named; pp_codex/* -> 1 named; pp_harness/* -> 2 named) | yes | yes | appends "Allowed tools" (Claude); "Tools" (Copilot); Copilot gains `modelPolicy`; original YAML invalid; emitted parses |
| master-plan-patcher | yes (+Glob, Grep) | no (pp_harness/* -> 4 named; +search) | yes | yes | appends "Allowed tools" (Claude); "Tools", "Skills" (Copilot); mirror prompt differs from Claude in 3 line(s), tool names/paths only; Copilot gains `modelPolicy`; skills: Claude native, Copilot prose |
| missability-inspector | yes | no (pp_harness/* -> 2 named) | yes | yes | appends nothing (Claude); "Tools" (Copilot); Copilot gains `modelPolicy`, `reasoningEffort` |
| narrative-designer | yes (+NotebookEdit) | no (pp_agy/* -> 1 named; pp_codex/* -> 1 named; pp_harness/* -> 2 named) | yes | yes | appends "Allowed tools" (Claude); "Tools" (Copilot); Copilot gains `modelPolicy` |
| netcode-programmer | yes (+NotebookEdit) | no (pp_agy/* -> 1 named; pp_codex/* -> 1 named; pp_harness/* -> 2 named) | yes | yes | appends "Allowed tools" (Claude); "Tools" (Copilot); Copilot gains `modelPolicy`; original YAML invalid; emitted parses |
| ops-author | yes (+NotebookEdit) | no (pp_harness/* -> 2 named) | yes | yes | appends "Allowed tools" (Claude); "Tools" (Copilot); Copilot gains `modelPolicy` |
| pair-programmer-orchestrator | yes | no (mirror has no `tools` key; emitted `tools: []`) | yes | yes | appends "Allowed tools" (Claude); "Tools" (Copilot); mirror prompt differs from Claude in 2 line(s), tool names/paths only; Copilot gains `modelPolicy`; Copilot model gpt-5.4 carried via `super` tier mapping |
| profile-loader | yes (+Glob, Grep) | no (pp_harness/* -> 5 named; +search) | yes | yes | appends "Allowed tools" (Claude); "Tools", "Budget" (Copilot); Copilot gains `modelPolicy`, `reasoningEffort` |
| reflexion-coach | yes | no (pp_harness/* -> 2 named) | yes | NO | appends nothing (Claude); nothing (Copilot); Copilot gains `modelPolicy`; prompt differs: `{{critique_md}}` is emitted as `{{{{critique_md}}}}` on both targets (gap 3) |
| release-planner | yes (+NotebookEdit) | no (pp_harness/* -> 2 named) | yes | yes | appends "Allowed tools" (Claude); "Tools" (Copilot); Copilot gains `modelPolicy` |
| retirement-planner | yes (+NotebookEdit) | no (pp_harness/* -> 2 named) | yes | yes | appends "Allowed tools" (Claude); "Tools" (Copilot); Copilot gains `modelPolicy` |
| run-finalizer | yes (+Grep) | no (pp_harness/* -> 8 named) | yes | yes | appends "Allowed tools" (Claude); "Tools" (Copilot); Copilot gains `modelPolicy`, `reasoningEffort` |
| security-reviewer | yes (+NotebookEdit) | no (pp_harness/* -> 2 named) | yes | yes | appends "Allowed tools" (Claude); "Tools" (Copilot); Copilot gains `modelPolicy`, `reasoningEffort` |
| spec-author | yes (+NotebookEdit) | no (pp_harness/* -> 2 named) | yes | yes | appends "Allowed tools" (Claude); "Tools" (Copilot); mirror prompt differs from Claude in 2 line(s), tool names/paths only; Copilot gains `modelPolicy` |
| strategy-author | yes (+NotebookEdit) | no (pp_harness/* -> 2 named) | yes | yes | appends "Allowed tools" (Claude); "Tools" (Copilot); Copilot gains `modelPolicy` |
| taxonomy-mapper | yes | no (pp_harness/* -> 3 named) | yes | yes | appends nothing (Claude); "Tools", "Skills" (Copilot); Copilot gains `modelPolicy`, `reasoningEffort`; skills: Claude native, Copilot prose |
| tech-animator | yes (+NotebookEdit) | no (pp_agy/* -> 1 named; pp_codex/* -> 1 named; pp_harness/* -> 2 named) | yes | yes | appends "Allowed tools" (Claude); "Tools" (Copilot); Copilot gains `modelPolicy` |
| technical-artist | yes (+NotebookEdit) | no (pp_agy/* -> 1 named; pp_codex/* -> 1 named; pp_harness/* -> 2 named) | yes | yes | appends "Allowed tools" (Claude); "Tools" (Copilot); Copilot gains `modelPolicy` |
| test-strategist | yes (+NotebookEdit, PowerShell) | no (pp_codex/* -> 1 named; pp_harness/* -> 2 named) | yes | yes | appends "Allowed tools" (Claude); "Tools" (Copilot); mirror prompt differs from Claude in 2 line(s), tool names/paths only; Copilot gains `modelPolicy` |
| triage | yes | no (pp_harness/* -> 1 named) | yes | yes | appends nothing (Claude); "Tools", "Budget" (Copilot); Copilot gains `modelPolicy`, `reasoningEffort` |
| visual-regression-runner | yes (+PowerShell) | no (pp_harness/* -> 4 named) | yes | yes | appends "Allowed tools" (Claude); "Tools" (Copilot); Copilot gains `modelPolicy` |

## Mirror prompts versus Claude prompts

11 mirrors differ from their Claude prompt beyond the generated banner and the preserved-comments block: agents-md-author, api-designer, architect, browser-validator, design-system-curator, engineer, judge-same-vendor, master-plan-patcher, pair-programmer-orchestrator, spec-author, test-strategist. In every case each differing line pair is the same text with Claude tool names (`Read`, `Write`, `Edit`, `Glob`, `Grep`, `Bash`) replaced by `read`, `edit`, `search`, `execute`, or `.claude/commands/pp/` and `.claude/agents/` paths replaced by `.github/...` ones, i.e. the sync script's mechanical rewrite (checked line by line, 0 other differences). `engineer`'s mirror description has the same rewrite. After the port the Copilot prompts say `Write`, `Glob`, `Bash` and point at `.claude/` paths. No agent mentions `get_claude_tier_models`, so that rewrite does not occur.

## Original YAML that does not parse strictly

A strict loader (PyYAML `safe_load`) rejects 4 of the 42 `.claude/agents` files ("mapping values are not allowed here": an unquoted `: ` inside `description`): `game-security` (line 3, column 263); `judge-same-vendor` (line 8, column 396); `live-ops-manager` (line 3, column 207); `netcode-programmer` (line 3, column 232). Claude Code most likely skips these four today. The importer accepted them silently (no warning). The emitted Claude and Copilot files quote the description, and all 84 emitted files parse strictly, so after the port those four agents become loadable. The original `.github/agents` mirrors parse (the sync script quotes descriptions).

## Covenant bugs and spec gaps

1. `cov import` output is not `cov fmt` clean. Repro: `cov import --out d .claude/agents .github/agents && cd d && cov fmt --check` reports "would reformat" for all 42 files (multi-line `uses` and `extra` blocks that fmt joins). Building before and after `cov fmt` gives identical output.
2. No effect grants exactly one Claude tool and its Copilot alias. `covenant/architect.cov`: `fs.write("**")` emits `Edit`, `NotebookEdit`, `Write` for Claude; `harness("Write"), harness("Edit")` is exact for Claude but the Copilot `tools` list loses `edit` (L0201). Same for `shell("*")` (adds `PowerShell`) and a lone `Read` (`fs.read("**")` adds `Grep`, `Glob`, `search`). The importer's own warning ("the file-read effect grants both aliases when built") points at this.
3. `{{` in a prompt is not unescaped by the emitters. LANGUAGE.md §1 says `{{` renders as `{`, and `cov import` writes the original `{{critique_md}}` as `{{{{critique_md}}}}` accordingly, but `cov build` writes the prompt text raw, so `.claude/agents/reflexion-coach.md` and the Copilot file contain `{{{{critique_md}}}}`. Repro: an agent whose prompt holds `{{{{x}}}}` builds to `{{{{x}}}}`. Writing `{{critique_md}}` in the source would give the original text but contradict §1; not done.
4. `mcp.S.*` emits no entry in the Claude `tools` list, with or without `tool mcp.S.T` declarations (`covenant/architect.cov` with `uses mcp.pp_harness.*`); Copilot lists only declared tools. There is no way to write the mirrors' `pp_harness/*`.
5. Copilot always gets `tools: [...]` (`[]` when empty) and, with any model, `modelPolicy: "required"` (`covenant/browser-validator.cov`, `covenant/triage.cov`). Neither can be omitted (`tools` and `modelPolicy` are governed keys, so `extra copilot` cannot set them). The mirrors omit both.
6. `extra copilot { "target": "github-copilot" }` is W0215 on all 42 agents, although the mirrors in this repository carry that key. Only the report can say whether the Copilot CLI honors it.
7. No per-target prompt text: the Copilot prompt cannot use `edit`/`search`/`execute` while the Claude prompt uses `Write`/`Glob`/`Bash` (11 agents, see above).
8. No way to give one agent a different model per target except a tier mapping: `pair-programmer-orchestrator.cov` uses `model super` with `[models.claude]`/`[models.copilot]` `super` entries. This is a workaround, not a documented use of `super`.
9. `cov import` accepts YAML that a strict loader rejects (`.claude/agents/game-security.md` line 3: `cov import --out d .claude/agents` prints no warning).
10. Frontmatter YAML comments cannot be emitted: `//` comments in `.cov` are not copied to the output, so rationale (e.g. `maxTurns=6` in `triage`) is lost from the Claude and Copilot files; the mirrors keep it as an HTML comment.

## Decisions made without asking

- Chose capability-complete effects (`fs.read`, `fs.write`, `shell`) over exact Claude tool names, because the harness-name form removes file access from every Copilot agent. The extra tool names are listed per agent above.
- Kept MCP tools as the named tools instead of `mcp.S.*`, so no agent got a tool its Claude file does not list.
- Used `super` for the orchestrator's Copilot model, and dropped its `copilot-model` key from `extra claude`.
- Left `reflexion-coach` with the spec-correct `{{{{critique_md}}}}` source instead of bending it to the emitter (gap 3).
- Committed `covenant/out` (the verification commands read it).
