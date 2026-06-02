#!/usr/bin/env node

import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const CLAUDE_DIR = join(ROOT, ".claude");
const GITHUB_DIR = join(ROOT, ".github");
const GENERATED_AGENTS_DIR = join(GITHUB_DIR, "agents");
const GENERATED_COMMANDS_DIR = join(GITHUB_DIR, "commands", "pp");
const GENERATED_HOOKS_DIR = join(GITHUB_DIR, "hooks");
const GENERATED_PLUGIN_HOOKS_PATH = join(ROOT, "hooks.json");
const GENERATED_REPO_HOOKS_PATH = join(GENERATED_HOOKS_DIR, "pair-programmer.json");
const GENERATED_SKILLS_DIR = join(GITHUB_DIR, "skills");
const COPILOT_MIRROR_REWRITES = [
  [/claude-opus-4-8/g, "claude-opus-4-7"],
  [/mcp__pp_harness__get_claude_tier_models/g, "mcp__pp_harness__get_copilot_claude_tier_models"],
  [/\.claude\/skills\/pair-programmer\.md/g, ".github/skills/pair-programmer/SKILL.md"],
  [/\.claude\/commands\/pp\//g, ".github/commands/pp/"],
  [/`\.claude\/agents\/\*\.md`/g, "`.github/agents/*.agent.md`"],
  [/\.claude\/agents\/([A-Za-z0-9_-]+)\.md/g, ".github/agents/$1.agent.md"],
  [/excluding `judge-cross-vendor\.md` and `judge-same-vendor\.md`/g, "excluding `judge-cross-vendor.agent.md` and `judge-same-vendor.agent.md`"],
];
const COPILOT_TOOL_REFERENCE_REWRITES = new Map([
  ["Read", "read"],
  ["NotebookRead", "read"],
  ["Edit", "edit"],
  ["Write", "edit"],
  ["MultiEdit", "edit"],
  ["NotebookEdit", "edit"],
  ["Glob", "search"],
  ["Grep", "search"],
  ["Bash", "execute"],
  ["PowerShell", "execute"],
  ["shell", "execute"],
]);
const COPILOT_TOOL_REFERENCE_TOKEN_PATTERN = [...COPILOT_TOOL_REFERENCE_REWRITES.keys()]
  .sort((left, right) => right.length - left.length)
  .join("|");
const COPILOT_TOOL_REFERENCE_SEQUENCE_PATTERN = new RegExp(
  `\\b(?:${COPILOT_TOOL_REFERENCE_TOKEN_PATTERN})\\b(?:\\s*(?:/|,|and|or)\\s*\\b(?:${COPILOT_TOOL_REFERENCE_TOKEN_PATTERN})\\b)+`,
  "g",
);
const COPILOT_EXPLICIT_TOOL_REFERENCE_TOKEN_PATTERN = [
  "NotebookRead",
  "NotebookEdit",
  "MultiEdit",
  "PowerShell",
  "Read",
  "Edit",
  "Write",
  "Glob",
  "Grep",
  "Bash",
].join("|");
const COPILOT_COLLAPSED_TOOL_REFERENCES = ["read", "edit", "search", "execute"];

function ensureDir(path) {
  mkdirSync(path, { recursive: true });
}

function resetDir(path) {
  rmSync(path, { recursive: true, force: true });
  ensureDir(path);
}

function readText(path) {
  return readFileSync(path, "utf8").replace(/\r\n/g, "\n");
}

function splitFrontmatter(content) {
  if (!content.startsWith("---\n")) return { frontmatter: "", body: content };
  const end = content.indexOf("\n---\n", 4);
  if (end === -1) return { frontmatter: "", body: content };
  return {
    frontmatter: content.slice(4, end),
    body: content.slice(end + 5),
  };
}

function parseFlatFrontmatter(frontmatter) {
  const out = {};
  for (const rawLine of frontmatter.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const match = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!match) continue;
    out[match[1]] = match[2];
  }
  return out;
}

function quoteYaml(value) {
  return JSON.stringify(String(value));
}

function generatedBanner(source) {
  return `<!-- Generated from ${source}. Edit the .claude source file and rerun node scripts/sync-copilot-assets.mjs. -->\n\n`;
}

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function normalizeCommand(sourcePath, targetPath) {
  const content = readText(sourcePath);
  const { frontmatter, body } = splitFrontmatter(content);
  const data = parseFlatFrontmatter(frontmatter);
  const commandName = `pp:${basename(sourcePath, ".md")}`;

  const lines = [];
  lines.push("---");
  lines.push(`name: ${quoteYaml(commandName)}`);
  if (data.description) lines.push(`description: ${data.description}`);
  if (data["argument-hint"]) lines.push(`argument-hint: ${data["argument-hint"]}`);
  if (data["allowed-tools"]) lines.push(`allowed-tools: ${data["allowed-tools"]}`);
  lines.push("---");
  lines.push("");
  lines.push(generatedBanner(sourcePath.replace(`${ROOT}\\`, "")) + body.trimStart());

  writeFileSync(targetPath, `${lines.join("\n").trimEnd()}\n`);
}

function mapAgentTools(rawTools) {
  if (!rawTools) return [];
  const mapped = new Set();
  for (const token of rawTools.split(",").map((part) => part.trim()).filter(Boolean)) {
    if (/^(Read|NotebookRead)$/i.test(token)) mapped.add("read");
    else if (/^(Edit|Write|MultiEdit|NotebookEdit)$/i.test(token)) mapped.add("edit");
    else if (/^(Glob|Grep)$/i.test(token)) mapped.add("search");
    else if (/^(Bash|PowerShell|shell|execute)$/i.test(token)) mapped.add("execute");
    else if (/^(Task|Agent|custom-agent)$/i.test(token)) mapped.add("agent");
    else if (/^mcp__pp_harness__/i.test(token)) mapped.add("pp_harness/*");
    else if (/^mcp__pp_codex__/i.test(token)) mapped.add("pp_codex/*");
    else if (/^mcp__pp_gemini__/i.test(token)) mapped.add("pp_gemini/*");
    else if (/^mcp__claude-in-chrome__/i.test(token)) mapped.add("web");
  }
  return [...mapped];
}

function normalizeAgent(sourcePath, targetPath) {
  const content = readText(sourcePath);
  const { frontmatter, body } = splitFrontmatter(content);
  const data = parseFlatFrontmatter(frontmatter);
  const tools = mapAgentTools(data.tools ?? "");
  const copilotModel = (data["copilot-model"] || data.model || "").replace(/^["']|["']$/g, "");

  const lines = [];
  lines.push("---");
  lines.push(`name: ${quoteYaml(data.name || basename(sourcePath, ".md"))}`);
  if (copilotModel) lines.push(`model: ${quoteYaml(copilotModel)}`);
  lines.push(`description: ${quoteYaml((data.description || "").replace(/^["']|["']$/g, ""))}`);
  lines.push("target: github-copilot");
  if (tools.length) {
    lines.push("tools:");
    for (const tool of tools) lines.push(`  - ${quoteYaml(tool)}`);
  }
  lines.push("---");
  lines.push("");
  lines.push(generatedBanner(sourcePath.replace(`${ROOT}\\`, "")) + body.trimStart());

  writeFileSync(targetPath, `${lines.join("\n").trimEnd()}\n`);
}

function normalizeSkill(sourcePath, targetDir) {
  const content = readText(sourcePath);
  const targetPath = join(targetDir, "SKILL.md");
  const { frontmatter, body } = splitFrontmatter(content);
  const lines = [];
  lines.push("---");
  lines.push(frontmatter.trim());
  lines.push("---");
  lines.push("");
  lines.push(generatedBanner(sourcePath.replace(`${ROOT}\\`, "")) + body.trimStart());
  writeFileSync(targetPath, `${lines.join("\n").trimEnd()}\n`);
}

function mapHookMatcher(rawMatcher = "") {
  const mapped = [];
  for (const token of rawMatcher.split("|").map((part) => part.trim()).filter(Boolean)) {
    if (/^Bash$/i.test(token)) mapped.push("bash");
    else if (/^PowerShell$/i.test(token)) mapped.push("powershell");
    else if (/^(Edit|MultiEdit|NotebookEdit)$/i.test(token)) mapped.push("edit");
    else if (/^Write$/i.test(token)) mapped.push("create");
    else mapped.push(token);
  }
  return [...new Set(mapped)].join("|");
}

function normalizeHooks(sourcePath, targetPaths) {
  const settings = JSON.parse(readText(sourcePath));
  const hooks = { version: 1, hooks: {} };

  for (const [eventName, entries] of Object.entries(settings.hooks ?? {})) {
    hooks.hooks[eventName] = [];
    for (const entry of entries) {
      for (const hook of entry.hooks ?? []) {
        if (hook.type !== "command" || !hook.command) continue;
        const command = hook.command.replaceAll("__PP_DAEMON__", "daemon/dist/index.js");
        const mapped = {
          type: "command",
          bash: command,
          powershell: command,
          timeoutSec: 30,
        };
        const matcher = mapHookMatcher(entry.matcher ?? "");
        if (matcher) mapped.matcher = matcher;
        hooks.hooks[eventName].push(mapped);
      }
    }
  }

  for (const targetPath of targetPaths) {
    ensureDir(dirname(targetPath));
    writeJson(targetPath, hooks);
  }
}

function listMarkdownFiles(rootPath) {
  const files = [];
  for (const entry of readdirSync(rootPath, { withFileTypes: true })) {
    const entryPath = join(rootPath, entry.name);
    if (entry.isDirectory()) files.push(...listMarkdownFiles(entryPath));
    else if (entry.isFile() && entry.name.endsWith(".md")) files.push(entryPath);
  }
  return files;
}

function rewriteCopilotMirrorText(text) {
  let rewritten = text;
  for (const [pattern, replacement] of COPILOT_MIRROR_REWRITES) {
    rewritten = rewritten.replace(pattern, replacement);
  }
  rewritten = rewritten.replace(COPILOT_TOOL_REFERENCE_SEQUENCE_PATTERN, (match) =>
    match.replace(new RegExp(`\\b(${COPILOT_TOOL_REFERENCE_TOKEN_PATTERN})\\b`, "g"), (tokenMatch, token) => {
      const replacement = COPILOT_TOOL_REFERENCE_REWRITES.get(token);
      return replacement ?? tokenMatch;
    }),
  );
  rewritten = rewritten.replace(/`([A-Za-z][A-Za-z0-9-]*)`/g, (match, token) => {
    const replacement = COPILOT_TOOL_REFERENCE_REWRITES.get(token);
    return replacement ? `\`${replacement}\`` : match;
  });
  rewritten = rewritten.replace(
    new RegExp(`\\b(${COPILOT_TOOL_REFERENCE_TOKEN_PATTERN})\\b(?=\\s+tools?\\b)`, "g"),
    (match, token) => COPILOT_TOOL_REFERENCE_REWRITES.get(token) ?? match,
  );
  rewritten = rewritten.replace(
    new RegExp(`\\b(${COPILOT_TOOL_REFERENCE_TOKEN_PATTERN})\\b(?=\\s+for\\b)`, "g"),
    (match, token) => COPILOT_TOOL_REFERENCE_REWRITES.get(token) ?? match,
  );
  rewritten = rewritten.replace(
    new RegExp(`\\bvia\\s+(${COPILOT_TOOL_REFERENCE_TOKEN_PATTERN})\\b`, "g"),
    (match, token) => `via ${COPILOT_TOOL_REFERENCE_REWRITES.get(token) ?? token}`,
  );
  rewritten = rewritten.replace(
    new RegExp(`\\b([Uu]se|[Uu]sing)\\s+(${COPILOT_EXPLICIT_TOOL_REFERENCE_TOKEN_PATTERN})\\b`, "g"),
    (match, verb, token) => `${verb} ${COPILOT_TOOL_REFERENCE_REWRITES.get(token) ?? token}`,
  );
  for (const token of COPILOT_COLLAPSED_TOOL_REFERENCES) {
    rewritten = rewritten.replace(
      new RegExp(`\\b${token}\\b(?:\\s*(?:/|,|and|or)\\s*\\b${token}\\b)+`, "g"),
      token,
    );
    rewritten = rewritten.replace(
      new RegExp(`\`${token}\`(?:\\s*(?:/|,|and|or)\\s*\`${token}\`)+`, "g"),
      `\`${token}\``,
    );
  }
  return rewritten;
}

function rewriteGeneratedCopilotMirrors() {
  for (const rootPath of [GENERATED_AGENTS_DIR, join(GITHUB_DIR, "commands"), GENERATED_SKILLS_DIR]) {
    for (const filePath of listMarkdownFiles(rootPath)) {
      const original = readText(filePath);
      const rewritten = rewriteCopilotMirrorText(original);
      if (rewritten !== original) writeFileSync(filePath, `${rewritten.trimEnd()}\n`);
    }
  }
}

function main() {
  resetDir(GENERATED_AGENTS_DIR);
  resetDir(join(GITHUB_DIR, "commands"));
  ensureDir(GENERATED_COMMANDS_DIR);
  resetDir(GENERATED_SKILLS_DIR);

  for (const file of readdirSync(join(CLAUDE_DIR, "commands", "pp"))) {
    if (!file.endsWith(".md")) continue;
    normalizeCommand(
      join(CLAUDE_DIR, "commands", "pp", file),
      join(GENERATED_COMMANDS_DIR, file),
    );
  }

  for (const file of readdirSync(join(CLAUDE_DIR, "agents"))) {
    if (!file.endsWith(".md")) continue;
    normalizeAgent(
      join(CLAUDE_DIR, "agents", file),
      join(GENERATED_AGENTS_DIR, `${basename(file, ".md")}.agent.md`),
    );
  }

  for (const entry of readdirSync(join(CLAUDE_DIR, "skills"), { withFileTypes: true })) {
    const srcPath = join(CLAUDE_DIR, "skills", entry.name);
    // A skill can be either a single `.md` file (pp-native convention) OR a directory
    // containing SKILL.md (the sibling/ecosystem convention — these are materialized into
    // .claude/skills as symlinked dirs by scripts/link-ecosystem.*). Mirror BOTH so the
    // Copilot plugin includes sibling skills (previously directory skills were dropped).
    // Note: a symlinked directory is reported as a symlink by Dirent, so resolve via statSync.
    let isDir = entry.isDirectory();
    if (entry.isSymbolicLink()) {
      try { isDir = statSync(srcPath).isDirectory(); } catch { continue; }
    }
    if (isDir) {
      const skillFile = join(srcPath, "SKILL.md");
      if (!existsSync(skillFile)) continue; // not a skill package
      const skillDir = join(GENERATED_SKILLS_DIR, entry.name);
      ensureDir(skillDir);
      // Copy any supporting files (references, scripts) verbatim, then overwrite SKILL.md
      // with the normalized + Copilot-rewritten version.
      for (const inner of readdirSync(srcPath, { withFileTypes: true })) {
        if (inner.name === "SKILL.md") continue;
        cpSync(join(srcPath, inner.name), join(skillDir, inner.name), { recursive: true });
      }
      normalizeSkill(skillFile, skillDir);
    } else if (entry.name.endsWith(".md")) {
      const skillDir = join(GENERATED_SKILLS_DIR, basename(entry.name, ".md"));
      ensureDir(skillDir);
      normalizeSkill(srcPath, skillDir);
    }
  }

  normalizeHooks(join(CLAUDE_DIR, "settings.template.json"), [
    GENERATED_PLUGIN_HOOKS_PATH,
    GENERATED_REPO_HOOKS_PATH,
  ]);

  // Keep `.claude` untouched while letting Copilot mirrors diverge where the
  // GitHub entrypoint intentionally uses different model ids and lookup paths.
  rewriteGeneratedCopilotMirrors();

  console.log("Synced Copilot assets and hooks from .claude, then applied Copilot-only mirror rewrites");
}

main();
