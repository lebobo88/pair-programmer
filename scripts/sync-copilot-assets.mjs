#!/usr/bin/env node

import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { realpathSync } from "node:fs";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
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
// NOTE: the historical `claude-opus-4-7 -> claude-opus-4-6` model rewrite was
// removed when the Copilot "one rev lower" Opus divergence was collapsed by
// operator decision (gpt-5.6 / Claude-5 refresh). COPILOT_CLAUDE_TIER_MODELS is
// now identical to CLAUDE_TIER_MODELS, so mirrors carry the same model ids
// verbatim. Re-add a rewrite here if a Copilot-only pin is ever reintroduced.
const COPILOT_MIRROR_REWRITES = [
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


/**
 * Skip entries whose target cannot be read. `.claude/agents` and `.claude/skills`
 * carry symlinks into sibling checkouts (ExecutiveSuite, AgentSmith); when a
 * sibling moves, the link dangles and `readFileSync` would abort the whole
 * sync AFTER the mirror directories were already reset. Warn and continue so
 * the mirror is regenerated from every source that still exists.
 */
function readableSource(path) {
  if (existsSync(path)) return true;
  console.warn(`[sync-copilot-assets] skipping unreadable source (dangling symlink?): ${path}`);
  return false;
}

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

/**
 * Preserve YAML comments from the .claude source frontmatter.
 *
 * APPROACH TAKEN: re-emit them as an HTML comment in the BODY, immediately
 * after the generated-from banner — NOT as YAML comments inside the mirror's
 * frontmatter.
 *
 * WHY: normalizeAgent/normalizeCommand do not copy the source frontmatter.
 * They rebuild it from a whitelist of keys, renaming as they go (`copilot-model`
 * in the source becomes `model:` in the mirror, `tools` is remapped from Claude
 * tool names to Copilot capability tokens). A source comment is anchored to the
 * source key, so re-emitting it inside the rebuilt block would either attach it
 * to a key that no longer exists or sit above a key it does not describe. The
 * Copilot frontmatter is also a validated schema; parking free text in it is a
 * needless compatibility risk. The body is schema-free and is exactly where a
 * human reading the mirror will look after the banner tells them not to edit it.
 *
 * The concrete case this exists for: the rationale above `copilot-model:
 * gpt-5.4` in .claude/agents/pair-programmer-orchestrator.md, warning that the
 * Copilot CLI catalog is NOT the `codex exec` catalog and that sweeping this pin
 * with the codex pins reproduces the AGY-MODEL-ID-STALE failure. Before this,
 * that warning existed only in the .claude source and anyone reading (or
 * sweeping) the mirror never saw it.
 *
 * Returns "" when the source frontmatter has no comments.
 */
function preservedFrontmatterComments(frontmatter, source) {
  const comments = frontmatter
    .split("\n")
    .filter((line) => line.trim().startsWith("#"))
    .map((line) => line.trim().replace(/^#\s?/, ""));
  if (comments.length === 0) return "";
  // Neutralise any "--" so the payload can never terminate the HTML comment.
  const safe = comments.map((c) => c.replace(/--+/g, (m) => m.replace(/-/g, "–")));
  return (
    `<!-- Frontmatter rationale preserved from ${source} (YAML comments are dropped by the\n` +
    `     frontmatter rebuild in scripts/sync-copilot-assets.mjs; kept here so the reasoning\n` +
    `     survives in the mirror):\n` +
    safe.map((c) => `     ${c}`).join("\n") +
    `\n-->\n\n`
  );
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
  const relSource = sourcePath.replace(`${ROOT}\\`, "");
  lines.push(
    generatedBanner(relSource)
    + preservedFrontmatterComments(frontmatter, relSource)
    + body.trimStart(),
  );

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
    else if (/^mcp__pp_agy__/i.test(token)) mapped.add("pp_agy/*");
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
  const relSource = sourcePath.replace(`${ROOT}\\`, "");
  lines.push(
    generatedBanner(relSource)
    + preservedFrontmatterComments(frontmatter, relSource)
    + body.trimStart(),
  );

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
    if (!readableSource(join(CLAUDE_DIR, "commands", "pp", file))) continue;
    normalizeCommand(
      join(CLAUDE_DIR, "commands", "pp", file),
      join(GENERATED_COMMANDS_DIR, file),
    );
  }

  for (const file of readdirSync(join(CLAUDE_DIR, "agents"))) {
    if (!file.endsWith(".md")) continue;
    if (!readableSource(join(CLAUDE_DIR, "agents", file))) continue;
    normalizeAgent(
      join(CLAUDE_DIR, "agents", file),
      join(GENERATED_AGENTS_DIR, `${basename(file, ".md")}.agent.md`),
    );
  }

  for (const file of readdirSync(join(CLAUDE_DIR, "skills"))) {
    if (!file.endsWith(".md")) continue;
    if (!readableSource(join(CLAUDE_DIR, "skills", file))) continue;
    const skillDir = join(GENERATED_SKILLS_DIR, basename(file, ".md"));
    ensureDir(skillDir);
    normalizeSkill(join(CLAUDE_DIR, "skills", file), skillDir);
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

// Only run the sync when this file is executed directly, never on import.
//
// WHY: the script's main() rewrites and resets generated directories under
// .github/. Exporting a helper for unit testing made the module importable, and
// an unguarded top-level main() meant `import` alone performed those destructive
// writes -- a test run actually triggered a partial reset of .github/agents
// (it survived only because the rm hit EPERM). Flagged by a cross-vendor judge
// on run_tYE0v6WrwFWs.
// Compare REAL paths, case-normalised. A lexical argv[1] comparison breaks in
// two directions: a symlinked invocation resolves differently, and Windows
// drive-letter / path casing can differ between argv and import.meta.url. Either
// would make direct execution silently NOT sync -- the quiet inverse of the
// destructive-on-import bug this guard exists to prevent.
function isDirectInvocation() {
  const entry = process.argv[1];
  if (!entry) return false;
  // Casefold on Windows only. An unconditional toLowerCase() can equate two
  // genuinely distinct paths on a case-sensitive filesystem.
  //
  // ACCEPTED LIMITATION: process.platform names the PLATFORM, not the filesystem
  // semantics. Per-directory case-sensitive NTFS (fsutil file setCaseSensitiveInfo)
  // and case-sensitive SMB shares both exist under win32, and on those two distinct
  // real paths differing only by case would fold equal -- routing back to the
  // destructive branch. realpathSync canonicalises first, which narrows this to a
  // very small tail. It is accepted rather than probed: an empirical case-sensitivity
  // check means filesystem writes at module load, in a guard whose entire purpose is
  // to make module load side-effect free. Flagged by a cross-vendor judge on
  // run_tYE0v6WrwFWs and knowingly left.
  const norm = (u) => (process.platform === "win32" ? u.toLowerCase() : u);
  try {
    const a = norm(pathToFileURL(realpathSync(resolve(entry))).href);
    const b = norm(pathToFileURL(realpathSync(fileURLToPath(import.meta.url))).href);
    return a === b;
  } catch (err) {
    // Fail CLOSED but LOUD. Swallowing this silently reintroduces the inverse of
    // the bug the guard exists to prevent: a genuine direct invocation that syncs
    // nothing and says nothing. Closed is the right default (the alternative risks
    // a destructive write on import), but it must be visible.
    process.stderr.write(
      "[sync-copilot-assets] could not resolve real paths to confirm direct invocation; " +
        "refusing to sync. Run the script by its real path. Cause: " +
        (err && err.message ? err.message : String(err)) + String.fromCharCode(10));
    return false;
  }
}
const invokedDirectly = isDirectInvocation();

if (invokedDirectly) {
  main();
}

// Exported for testing only. The comment-neutralisation below is a safety
// boundary -- untrusted-ish source text is embedded inside an HTML comment in a
// generated file -- so it deserves a direct test that pushes a hostile payload
// through the transform, not just an assertion against the checked-in mirror.
export { preservedFrontmatterComments, isDirectInvocation };
