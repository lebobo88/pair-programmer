/**
 * AGENTS.md / CLAUDE.md template producers.
 *
 * AGENTS.md is the cross-tool source of truth (Linux Foundation Agentic AI
 * Foundation standard, read natively by Codex, Cursor, Factory, and others).
 * CLAUDE.md is a thin shim that imports AGENTS.md via the @-syntax plus
 * appends Claude-specific behavior. This dual-file layout is the explicit
 * pattern recommended in https://code.claude.com/docs/en/memory and works
 * cross-platform (Windows symlinks need admin rights, so we avoid them).
 *
 * Both files stay under the 200-line adherence cliff. Profile-specific
 * extensions append to the conventions/build-commands sections, not new
 * top-level headings, so the structure stays predictable for distillation
 * from PROJECT_MASTER.md (see agents-md-sync.ts).
 */

import { basename } from "node:path";

const MANAGED_OPEN  = "<!-- pair-programmer:managed:begin — manual edits between these markers will be overwritten on the next /pp:run finalize -->";
const MANAGED_CLOSE = "<!-- pair-programmer:managed:end -->";

export const AGENTS_MD_NAME = "AGENTS.md";
export const CLAUDE_MD_NAME = "CLAUDE.md";

/** Canonical section headings used by the patcher. Order is load order. */
export const AGENTS_MD_SECTIONS = [
  "Build and test commands",
  "Project layout",
  "Coding conventions",
  "Workflow rules",
  "Do not",
  "Notes from the harness",
];

export type AgentsMdTemplateExtras = {
  /** One-line conventions appended to "Coding conventions". */
  conventions?: string[];
  /** Build/test command hints appended to "Build and test commands". */
  build_commands?: string[];
  /** Free-form sections appended after the canonical six. */
  extra_sections?: Array<{ heading: string; body: string }>;
  /** Profile name, recorded in the auto-scaffolded preamble. */
  profile?: string;
};

export function agentsMdTemplate(projectName: string, extras: AgentsMdTemplateExtras = {}): string {
  const created = new Date().toISOString().slice(0, 10);
  const profile = extras.profile ? ` (profile: \`${extras.profile}\`)` : "";

  const buildCommands = (extras.build_commands ?? []).map(c => `- ${c}`).join("\n");
  const conventions   = (extras.conventions ?? []).map(c => `- ${c}`).join("\n");
  const extra         = (extras.extra_sections ?? [])
    .map(s => `## ${s.heading}\n\n${s.body.trim()}\n`)
    .join("\n");

  return `# AGENTS.md — ${projectName}${profile}

${MANAGED_OPEN}

_Auto-scaffolded by the pair-programmer harness on ${created}. This file is the cross-tool behavioral contract for any AI agent (Claude, Codex, Gemini, Cursor, etc.) working in this repository. PROJECT_MASTER.md is the planning artifact; this file is the slim operating manual derived from it._

## Build and test commands

${buildCommands || "_To be populated. List the exact commands an agent should run to build, test, lint, and start the dev server. Specificity beats prose — \`pnpm vitest\` not \"run the tests\"._"}

## Project layout

_To be populated. One bullet per top-level directory with a one-line purpose._

## Coding conventions

${conventions || "_To be populated. Indentation, naming, error-handling, comment posture, file-size limits._"}

## Workflow rules

- For any non-trivial change, prefer \`/pp:run "<request>"\` over direct edits — the harness enforces taxonomy coverage, cross-vendor judging, and missability checks.
- Commit one logical change per commit. Reference issue or run ids in the trailer.
- Update PROJECT_MASTER.md sections 11–14 when architecture/contracts/standards/security change; this file resyncs automatically.

## Do not

- Do not bypass pre-commit hooks (\`--no-verify\`) unless the user explicitly asks.
- Do not introduce backwards-compatibility shims for code paths nothing real depends on.
- Do not invent error handling for scenarios that cannot happen.

## Notes from the harness

_Run history is redirected to \`docs/agents-md-history.md\` to keep this file under 200 lines. The harness appends there automatically._

${MANAGED_CLOSE}
${extra ? `\n${extra}` : ""}`;
}

/**
 * CLAUDE.md is a one-import shim plus a small Claude-specific add-on.
 * Loading order at session start: managed → user → CLAUDE.md → CLAUDE.local.md.
 * Using @AGENTS.md (Anthropic-canonical import syntax) means a single edit to
 * AGENTS.md propagates to Claude, Codex, and every other tool.
 */
export function claudeMdTemplate(projectName: string): string {
  const created = new Date().toISOString().slice(0, 10);
  return `# CLAUDE.md — ${projectName}

@AGENTS.md

${MANAGED_OPEN}

_Auto-scaffolded by the pair-programmer harness on ${created}. The cross-tool rules live in AGENTS.md and are imported above. Anything below is Claude-Code-specific and would not apply to other agents._

## Claude Code specifics

- Prefer \`/pp:run "<request>"\` for any change touching more than a single function.
- Plan mode is encouraged for multi-file or architecture-shaping work.
- Auto memory lives at \`~/.claude/projects/<project>/memory/\` and is machine-local — do not rely on it for cross-machine context. Anything that needs to persist for the team goes in AGENTS.md.

${MANAGED_CLOSE}
`;
}

export function defaultProjectName(projectPath: string): string {
  return basename(projectPath) || "project";
}

export const AGENTS_MD_MANAGED_OPEN = MANAGED_OPEN;
export const AGENTS_MD_MANAGED_CLOSE = MANAGED_CLOSE;
