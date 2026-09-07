#!/usr/bin/env node

import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { realpathSync } from "node:fs";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isPointerFile } from "./lib/pointer-file.mjs";

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
  // R3.4: generalised across every skill name (was special-cased to
  // pair-programmer.md only), and — per this commit's R18.2 requirement that
  // the sync run cleanly on the STILL-FLAT tree — matches both the bundle
  // form `.claude/skills/<name>/SKILL.md` that R2 (commit 2) moves every
  // skill source to, and the pre-move flat form `.claude/skills/<name>.md`
  // that is still the real shape of every prose reference today (R8, the
  // reference-update requirement, is out of scope for this commit). Without
  // the flat alternative this rewrite would silently stop firing on every
  // still-flat cross-reference between now and R2 landing, regressing
  // mirrors that resolved correctly before this commit. Neither branch
  // hardcodes a skill name (AC-F11: `grep -n "skills/pair-programmer\.md"`
  // finds nothing here — the name is a capture group, not a literal).
  [/\.claude\/skills\/([A-Za-z0-9_-]+)(?:\/SKILL\.md|\.md)/g, ".github/skills/$1/SKILL.md"],
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

// NOTE: this script previously reset (rmSync + recreate) GENERATED_AGENTS_DIR,
// the commands mirror dir, and GENERATED_SKILLS_DIR unconditionally at the top
// of main() before regenerating everything. That is incompatible with R6.1's
// pointer-skip requirement -- a skip needs an EXISTING mirror to leave
// untouched, and an upfront reset destroys it before the skip decision is
// even made. main() now syncs each mirror in place (write-or-preserve per
// source) and prunes only the mirror files whose source no longer exists
// (see pruneStaleMirrorFiles / pruneEmptySkillDirs below), so no blanket
// resetDir helper remains.

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

// Builds the mirror content as a string; writing is the caller's job (R6 --
// the write site is where the pointer-skip and shrink-refusal guards live,
// so every render* function is pure text-in/text-out and every write goes
// through writeMirrorSafely).
function renderCommand(sourcePath) {
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

  return `${lines.join("\n").trimEnd()}\n`;
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

// skills-mirror-decision (R7.5, MED-2 carried forward from Phase F commit 2's
// judge, verdict on 93a64db): the whitelist below (name/model/description/
// target/tools) has NO unknown-key passthrough, so a source frontmatter's
// `skills:` key -- added by R7 to seven .claude/agents/*.md files -- is
// silently dropped from every .github/agents/*.agent.md mirror. That is
// deliberate, option (b) from R7.5: (1) extending this whitelist means
// touching this script, which Phase F's ordering constraint (R18.1/AC-F-A7)
// reserved for commit 1 only -- commit 2 (the migration) and commit 3 (this
// comment) are not allowed to extend it; (2) Copilot skill preloading is
// unverified platform behaviour (spec R14), so silently carrying an
// unverified capability into the mirror is higher risk than naming the gap
// here, beside the whitelist itself, rather than only in a commit message
// nobody re-reads.
function renderAgent(sourcePath) {
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

  return `${lines.join("\n").trimEnd()}\n`;
}

// R3.3: the banner names whatever sourcePath the caller passes in, relative
// to ROOT. During the transitional flat-layout state (R18.2, this commit)
// that is `.claude/skills/<name>.md`; once R2 moves the sources it is
// `.claude/skills/<name>/SKILL.md` with no change needed here -- the banner
// is never a hardcoded flat-path template, it just relativises whatever the
// real source path was.
function renderSkill(sourcePath) {
  const content = readText(sourcePath);
  const { frontmatter, body } = splitFrontmatter(content);
  const lines = [];
  lines.push("---");
  lines.push(frontmatter.trim());
  lines.push("---");
  lines.push("");
  lines.push(generatedBanner(sourcePath.replace(`${ROOT}\\`, "")) + body.trimStart());
  return `${lines.join("\n").trimEnd()}\n`;
}

/**
 * R3.1/R3.5: enumerate skill sources under `.claude/skills/`.
 *
 * Bundle-shaped (post-R2): a directory containing `SKILL.md`. A directory
 * with no `SKILL.md` is skipped with a per-directory warning (R3.2); the
 * whole sync is NOT aborted.
 *
 * Flat-shaped (pre-R2, transitional): a loose `<name>.md` file at the skills
 * root. This branch exists only so this commit -- landed with R2's move NOT
 * yet applied -- can be exercised and demonstrated idempotent (R18.2/AC-F1):
 * a bundle-only reading of R3.1 would make `readdirSync(".claude/skills")`
 * return zero directories today, and the resetDir-then-regenerate shape this
 * script already had would turn that into an 11-mirror deletion, which is
 * exactly the AC-F1 failure this requirement exists to prevent. Once R2
 * lands (commit 2 of this phase) `.claude/skills/` contains only bundle
 * directories (R2.3) and this branch becomes dead code that this enumerator
 * simply never matches again -- it is left in rather than special-cased out,
 * since R3.1 describes the target shape, not a prohibition on staying
 * compatible with the source shape that is still true for this one commit.
 */
function enumerateSkillSources(skillsDir) {
  const sources = [];
  for (const entry of readdirSync(skillsDir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      const dirPath = join(skillsDir, entry.name);
      const skillPath = join(dirPath, "SKILL.md");
      if (!existsSync(skillPath)) {
        console.warn(`[sync-copilot-assets] skipping skill directory with no SKILL.md: ${dirPath}`);
        continue;
      }
      sources.push({ name: entry.name, sourcePath: skillPath });
      continue;
    }
    if (entry.isFile() && entry.name.endsWith(".md")) {
      sources.push({ name: basename(entry.name, ".md"), sourcePath: join(skillsDir, entry.name) });
    }
  }
  return sources;
}

/*
 * Phase G (GitHub #48): Claude Code scans `.claude/agents/` RECURSIVELY
 * (code.claude.com/docs/en/sub-agents.md -- "Claude Code scans
 * `.claude/agents/` and `~/.claude/agents/` recursively, so you can
 * organize definitions into subfolders... identity comes only from the
 * `name` frontmatter field"). The mirror generator used to do a single flat
 * `readdirSync(agentsDir)`, which would silently DROP any agent placed in a
 * subdirectory from the Copilot mirror -- a latent trap that only fires the
 * day someone reorganises `.claude/agents/` into subfolders, at which point
 * the drop would be invisible (no error, just a missing mirror). This
 * enumerator walks subdirectories so the generator's traversal matches the
 * platform's.
 *
 * Mirror target names are `<basename>.agent.md`, keyed only by basename
 * (see main()'s use of `basename(file, ".md")` for the target path) --
 * exactly like Claude Code's own name-only identity rule above. That means
 * two source agents with the same basename in different subdirectories
 * would collide on a single mirror target and one would silently overwrite
 * the other with no signal to the operator. Recursion makes that collision
 * reachable for the first time, so this enumerator detects it and FAILS
 * LOUDLY (throws) rather than let the last-writer win.
 */
function enumerateAgentSources(agentsDir) {
  const sources = [];
  const seenBasenames = new Map(); // basename -> sourcePath, for collision detection

  function walk(dir) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const entryPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(entryPath);
        continue;
      }
      if (entry.isFile() && entry.name.endsWith(".md")) {
        const base = basename(entry.name, ".md");
        const prior = seenBasenames.get(base);
        if (prior) {
          throw new Error(
            `[sync-copilot-assets] agent basename collision: "${base}" is defined at both ` +
            `"${prior}" and "${entryPath}" -- both would mirror to the same target ` +
            `"${base}.agent.md", and Claude Code identifies subagents by \`name\` (not path), ` +
            `so this cannot be resolved automatically. Rename one of the source files.`,
          );
        }
        seenBasenames.set(base, entryPath);
        sources.push({ file: entry.name, sourcePath: entryPath });
      }
    }
  }

  walk(agentsDir);
  return sources;
}

// R6.4: refuse a mirror write whose new content drops below this fraction of
// the existing mirror's byte size, unless overridden. Half is a deliberately
// blunt heuristic: an ordinary content edit shrinks a file by a few percent
// at most, so any single write that crosses the 50% mark down is the same
// shape as the incident this guard exists to prevent -- a bare pointer-path
// string (or any other near-empty payload) silently overwriting real
// content -- not an editorial trim. It does not try to distinguish "63%"
// from "40%"; either is suspicious enough to require the explicit flag.
const MIRROR_SHRINK_THRESHOLD = 0.5;
const ALLOW_SHRINK_FLAG = "--allow-shrink";

/**
 * Writes `content` to `targetPath`, refusing (R6.4) when an existing mirror
 * would shrink past MIRROR_SHRINK_THRESHOLD and `allowShrink` was not passed.
 * The threshold MUST NOT be overridable by an environment default (R6.4) --
 * only by the explicit CLI flag the caller resolves once in main().
 *
 * Returns true if the write happened, false if it was refused. A refusal
 * increments `counts.skipped` and prints a warning naming the file, both
 * sizes, and the flag that would permit it (R6.4).
 *
 * R6.5: the guard does not fire when no existing mirror is present --
 * `existsSync(targetPath)` is false on first generation, so the whole
 * refusal branch is skipped.
 */
function writeMirrorSafely(targetPath, content, { allowShrink, counts }) {
  const buf = Buffer.from(content, "utf8");
  if (existsSync(targetPath)) {
    const existingSize = statSync(targetPath).size;
    if (existingSize > 0 && buf.length < existingSize * MIRROR_SHRINK_THRESHOLD && !allowShrink) {
      console.warn(
        `[sync-copilot-assets] refusing to write ${targetPath}: new size ${buf.length} bytes ` +
        `is below ${Math.round(MIRROR_SHRINK_THRESHOLD * 100)}% of existing size ${existingSize} bytes. ` +
        `Pass ${ALLOW_SHRINK_FLAG} to override.`,
      );
      counts.skipped += 1;
      return false;
    }
  }
  ensureDir(dirname(targetPath));
  writeFileSync(targetPath, buf);
  return true;
}

/**
 * Syncs one source -> one mirror target through the pointer-skip (R6.1-R6.3)
 * and shrink-refusal (R6.4-R6.5) guards. `render(sourcePath)` MUST be pure
 * text-in/text-out (renderCommand/renderAgent/renderSkill above) so the
 * pointer check can run BEFORE any write happens, per R6.1.
 *
 * `keepSet` collects every target path that must survive this run's prune
 * pass (see pruneStaleMirrorFiles): a successful write, a pointer-skip that
 * leaves an existing mirror in place, and a shrink-refused write all count
 * as "keep" -- only a target with no corresponding source at all should be
 * removed.
 *
 * Returns true if the mirror was (re)written this run, false if the source
 * was skipped or the write was refused.
 */
function syncMirrorEntry({ sourcePath, targetPath, render, allowShrink, counts, keepSet, pointerSkipSet }) {
  if (!readableSource(sourcePath)) return false;
  const rawSource = readFileSync(sourcePath, "utf8");
  if (isPointerFile(rawSource)) {
    counts.skipped += 1;
    console.warn(
      `[sync-copilot-assets] skipping pointer-file source, leaving mirror untouched: ` +
      `source=${sourcePath} target=${targetPath}`,
    );
    if (existsSync(targetPath)) keepSet.add(targetPath);
    // R6.1/HIGH-1: rewriteGeneratedCopilotMirrors() runs after every sync
    // loop and MUST NOT touch a mirror this run just declined to overwrite
    // (that would silently undo the skip through a second write path). Track
    // every pointer-skipped target here so the rewrite pass can honour it.
    if (pointerSkipSet) pointerSkipSet.add(targetPath);
    return false;
  }
  const content = render(sourcePath);
  const written = writeMirrorSafely(targetPath, content, { allowShrink, counts });
  keepSet.add(targetPath);
  return written;
}

/** R6.6 prerequisite: removing a mirror whose source is genuinely gone is
 * still correct behaviour (it is not the R6 defect -- the defect is
 * deleting a mirror whose source still exists but was misread). This walks
 * `targetDir` for existing mirror files and removes any not in `keepSet`,
 * replacing the previous unconditional `resetDir` with a diff against what
 * this run actually produced or deliberately preserved. */
function pruneStaleMirrorFiles(targetDir, keepSet) {
  if (!existsSync(targetDir)) return;
  for (const filePath of listMarkdownFiles(targetDir)) {
    if (!keepSet.has(filePath)) rmSync(filePath, { force: true });
  }
}

/** Removes now-empty skill bundle directories left behind by
 * pruneStaleMirrorFiles (a directory whose only file, SKILL.md, was just
 * pruned). */
function pruneEmptySkillDirs(skillsDir) {
  if (!existsSync(skillsDir)) return;
  for (const entry of readdirSync(skillsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dirPath = join(skillsDir, entry.name);
    if (readdirSync(dirPath).length === 0) rmSync(dirPath, { recursive: true, force: true });
  }
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

/** Best-effort (event, hook-name) label for an error message, mirroring
 * daemon/test/hook-inventory.unit.mjs's parseHookCommand: the command shape
 * is `... hook <Event> <name>`, so the last whitespace-delimited token is
 * the hook name. Used only for diagnostics -- R5.2 requires the failure
 * message to name the pair, not that this script re-derive the dispatcher's
 * routing. */
function describeHookCommand(command) {
  if (typeof command !== "string" || !command.trim()) return "(unknown hook)";
  const tokens = command.trim().split(/\s+/);
  return tokens[tokens.length - 1];
}

/**
 * R5.1: propagates each template entry's declared `timeout` to the emitted
 * `timeoutSec` instead of hardcoding 30 for every entry.
 *
 * R5.2: an entry whose `timeout` is missing or not a positive finite number
 * throws (fails loudly), naming the (event, hook) pair. It MUST NOT
 * silently substitute a default -- daemon/test/hook-inventory.unit.mjs holds
 * both real files to an unconditional positive-finite-numeric timeout
 * requirement (AC-D31/AC-D32), so a silent default here would launder a
 * template defect into a passing sync.
 *
 * R5.3: still emits no `statusMessage` and still never writes back to
 * `sourcePath` (`.claude/settings.template.json`) -- both hooks.json write-
 * guards positively require the field's absence (AC-D33), and this function
 * only ever reads settings.template.json, never writes it.
 *
 * R5.4: __PP_DAEMON__ substitution, the bash/powershell duplication,
 * mapHookMatcher, and writing both target paths are all unchanged.
 *
 * MED-2: both target writes used to go through `writeJson` (a bare
 * `writeFileSync`), so `hooks.json` and `.github/hooks/pair-programmer.json`
 * got no shrink protection at all -- unlike every markdown mirror, which
 * goes through `writeMirrorSafely`. Pointer risk was incidentally covered
 * (`JSON.parse` throws on a bare pointer path, which is why R5/R6 never
 * flagged this write site), but a truncated-but-still-valid-JSON payload
 * (e.g. an empty `hooks` object) was not. Both targets now go through
 * `writeMirrorSafely` with the JSON re-serialised as the content string, so
 * the same shrink-refusal / `--allow-shrink` contract R6.4-R6.5 gives every
 * other mirror now covers these two writes too. `{ allowShrink, counts }`
 * defaults to a fresh, non-shared counts object so a caller that does not
 * care about accounting (e.g. a future standalone fixture test) does not
 * have to construct one.
 */
/**
 * Recover a handler name from a Phase L adapter tool name.
 *
 * `hook_<Event>_<handler_with_underscores>` — the handler's real name uses
 * hyphens, which MCP tool names cannot contain. The event is stripped by exact
 * prefix rather than by splitting on the first `_`, because several events are
 * themselves multi-word (`PostToolUseFailure`, `SubagentStart`) and a naive
 * split would mis-attribute every one of them.
 */
function handlerFromAdapterTool(tool, eventName) {
  if (typeof tool !== "string") return null;
  const prefix = `hook_${eventName}_`;
  if (!tool.startsWith(prefix)) return null;
  const rest = tool.slice(prefix.length);
  if (!rest) return null;

  // RESOLVE against the real handler inventory rather than transforming blind.
  //
  // The first version returned `rest.replaceAll("_", "-")`, which a
  // cross-vendor judge correctly called lossy: the `-` → `_` mapping that
  // produces an MCP tool name is not injective, so any handler whose real name
  // legitimately contains an underscore would come back with that underscore
  // turned into a hyphen — silently emitting a command for a handler that does
  // not exist. Every handler happens to be hyphen-only today, so nothing was
  // wrong in the tree; the inverse was simply unsound.
  //
  // The timeout map's keys ARE the handler inventory (a guard holds them to it),
  // so the sound inverse is to find the one real handler whose name maps to
  // this tool name, and to refuse if it is absent or ambiguous.
  const inventory = hookInventoryFromTimeouts();
  const candidates = inventory
    .filter(({ event }) => event === eventName)
    .map(({ handler }) => handler)
    .filter(handler => handler.replaceAll("-", "_") === rest);

  if (candidates.length === 1) return candidates[0];
  if (candidates.length > 1) {
    throw new Error(
      `[sync-copilot-assets] adapter tool ${tool} is ambiguous under ${eventName}: it maps from ` +
      `${JSON.stringify(candidates)}. Two handler names cannot differ only by - versus _.`,
    );
  }
  return null;
}

let HOOK_INVENTORY = null;

/**
 * `{event, handler}` pairs from `.claude/hook-timeouts.json`, which a guard
 * holds to the daemon's implemented handler set.
 */
function hookInventoryFromTimeouts() {
  if (!HOOK_INVENTORY) {
    const p = join(CLAUDE_DIR, "hook-timeouts.json");
    if (!existsSync(p)) {
      throw new Error(`[sync-copilot-assets] ${p} is missing; it is the handler inventory this sync resolves against.`);
    }
    const timeouts = JSON.parse(readText(p)).timeouts ?? {};
    HOOK_INVENTORY = Object.keys(timeouts).map(key => {
      const idx = key.indexOf("/");
      return { event: key.slice(0, idx), handler: key.slice(idx + 1) };
    });
  }
  return HOOK_INVENTORY;
}

let HOOK_TIMEOUTS = null;

/**
 * Per-handler timeout in seconds, from `.claude/hook-timeouts.json`.
 *
 * A converted `mcp_tool` entry carries no `timeout` — that field belongs to the
 * command-hook shape — so the value for those 16 handlers has to come from
 * somewhere when rebuilding the all-command mirror. It comes from one declared
 * map that a guard holds against both manifests, rather than from a default
 * substituted here: this generator has refused to invent a timeout since Phase
 * D, and that refusal is the reason the regression surfaced as a dropped entry
 * instead of a wrong number.
 */
function hookTimeoutFor(eventName, handler, sourcePath) {
  if (!HOOK_TIMEOUTS) {
    const p = join(CLAUDE_DIR, "hook-timeouts.json");
    if (!existsSync(p)) {
      throw new Error(
        `[sync-copilot-assets] ${p} is missing; it is the single source for hook timeouts and is ` +
        `required to rebuild hooks.json from a template containing mcp_tool entries.`,
      );
    }
    HOOK_TIMEOUTS = JSON.parse(readText(p)).timeouts ?? {};
  }
  const key = `${eventName}/${handler}`;
  const t = HOOK_TIMEOUTS[key];
  if (typeof t !== "number") {
    throw new Error(
      `[sync-copilot-assets] ${sourcePath}: no timeout declared for ${key} in ` +
      `.claude/hook-timeouts.json. Add it there rather than defaulting one here.`,
    );
  }
  return t;
}

function normalizeHooks(sourcePath, targetPaths, { allowShrink = false, counts = { skipped: 0 } } = {}) {
  const settings = JSON.parse(readText(sourcePath));
  const hooks = { version: 1, hooks: {} };

  for (const [eventName, entries] of Object.entries(settings.hooks ?? {})) {
    hooks.hooks[eventName] = [];
    for (const entry of entries) {
      for (const hook of entry.hooks ?? []) {
        // Phase M (#54): an `mcp_tool` entry is CONVERTED to its command form
        // rather than skipped.
        //
        // This line used to read `if (hook.type !== "command") continue;`, and
        // that silent skip is what took hooks.json from 37 handlers to 21 the
        // first time the sync ran after Phase L converted 16 entries to
        // `mcp_tool`. Nothing failed; the file just came back smaller, and the
        // Copilot runtime quietly lost its telemetry, context-injection and
        // ledger hooks. `hook-inventory.unit.mjs` caught it on the next full
        // suite run, which is the only reason it did not ship.
        //
        // The mirror must stay all-command — `mcp_tool` is a Claude Code hook
        // type whose meaning in the Copilot runtime is unverified — so the
        // command line is reconstructed from the adapter's tool name, which
        // encodes the same `<event> <handler>` pair the command carries.
        let command;
        let timeout;

        if (hook.type === "mcp_tool") {
          const pair = handlerFromAdapterTool(hook.tool, eventName);
          if (!pair) {
            throw new Error(
              `[sync-copilot-assets] ${sourcePath}: cannot recover a handler name from mcp_tool entry ` +
              `${JSON.stringify(hook.tool)} under ${eventName}. Refusing to drop the entry -- a silently ` +
              `smaller hooks.json is exactly the failure this branch exists to prevent.`,
            );
          }
          command = `node "daemon/dist/index.js" hook ${eventName} ${pair}`;
          timeout = hookTimeoutFor(eventName, pair, sourcePath);
        } else if (hook.type === "command" && hook.command) {
          command = hook.command.replaceAll("__PP_DAEMON__", "daemon/dist/index.js");
          timeout = hook.timeout;
        } else {
          throw new Error(
            `[sync-copilot-assets] ${sourcePath}: unrecognised hook entry under ${eventName}: ` +
            `${JSON.stringify(hook).slice(0, 200)}. Refusing to skip it silently.`,
          );
        }

        if (typeof timeout !== "number" || !Number.isFinite(timeout) || timeout <= 0) {
          throw new Error(
            `[sync-copilot-assets] ${sourcePath}: missing or invalid "timeout" for ` +
            `(${eventName}, ${describeHookCommand(command)}); every hook entry must declare ` +
            `a positive finite numeric timeout -- refusing to substitute a default.`,
          );
        }
        const mapped = {
          type: "command",
          bash: command,
          powershell: command,
          timeoutSec: timeout,
        };
        const matcher = mapHookMatcher(entry.matcher ?? "");
        if (matcher) mapped.matcher = matcher;
        hooks.hooks[eventName].push(mapped);
      }
    }
  }

  const content = `${JSON.stringify(hooks, null, 2)}\n`;
  for (const targetPath of targetPaths) {
    writeMirrorSafely(targetPath, content, { allowShrink, counts });
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

/**
 * HIGH-1 (R6.1): this pass used to write with bare `writeFileSync`, bypassing
 * both guards `writeMirrorSafely` exists to enforce -- it could rewrite a
 * mirror the sync loops above had just pointer-skipped (undoing R6.1's
 * "leaving the existing mirror untouched" through a second write path in the
 * same run) and it carried no shrink protection of its own. It now routes
 * every write through `writeMirrorSafely` and refuses to touch any target in
 * `pointerSkipSet` at all -- not even to ask `writeMirrorSafely`, since that
 * function has no notion of "this target was pointer-skipped this run" and
 * skipping the call entirely is the only way to guarantee byte-identical
 * (R6.1's own wording).
 *
 * The judge's own reservation (accepted by the driver, Phase F amendment 1)
 * is that this pass reads its "original" content from the EXISTING mirror on
 * disk, never from the pointer source -- so it cannot introduce a bare
 * pointer-path string into a mirror the run declined to overwrite even
 * without this fix. That reservation is preserved, not relied upon: the
 * pointerSkipSet check below makes the refusal structural rather than
 * incidental to what COPILOT_MIRROR_REWRITES happens to match today.
 *
 * HIGH-2 (R6.6/R6.7): every write (or refusal) this pass makes is now
 * accounted for in the same `counts` object the sync loops populate, via
 * `counts.rewritten` (successful rewrite-pass writes),
 * `counts.rewriteSkipsHonoured` (pointer-skipped mirrors this pass declined
 * to touch), and `counts.skipped` (pointer sources and shrink refusals, each
 * counted exactly once at the point of the decision) -- so a bypassed rewrite
 * is no longer invisible to the summary main() prints, and no single decision
 * is counted twice.
 */
function rewriteGeneratedCopilotMirrors({ pointerSkipSet, allowShrink, counts }) {
  for (const rootPath of [GENERATED_AGENTS_DIR, join(GITHUB_DIR, "commands"), GENERATED_SKILLS_DIR]) {
    for (const filePath of listMarkdownFiles(rootPath)) {
      if (pointerSkipSet.has(filePath)) {
        // NEW-1: this used to do `counts.skipped += 1`, which double-counted.
        // syncMirrorEntry() already incremented `counts.skipped` for this same
        // source when it declined to overwrite the mirror; incrementing again
        // here reported 2 skips for 1 entry -- in exactly the field HIGH-2
        // asked to be made trustworthy. The rewrite pass honouring an existing
        // skip is not a new skip, it is the same skip observed a second time,
        // so it gets its own counter and the summary reports both without
        // inflating either.
        counts.rewriteSkipsHonoured += 1;
        console.warn(
          `[sync-copilot-assets] rewrite pass: skipping pointer-skipped mirror, leaving untouched: ` +
          `target=${filePath}`,
        );
        continue;
      }
      const original = readText(filePath);
      const rewritten = rewriteCopilotMirrorText(original);
      if (rewritten === original) continue;
      const written = writeMirrorSafely(filePath, `${rewritten.trimEnd()}\n`, { allowShrink, counts });
      if (written) counts.rewritten += 1;
    }
  }
}

/**
 * R6.6/R6.7: replaces the previous single unconditional success line with a
 * summary reporting counts accumulated during the run (never a literal), and
 * makes a non-clean run visible in the exit path -- an exit code of 0
 * alongside a nonzero skip count is the exact failure signature of the
 * ~673-line incident this phase's R6 exists to close off.
 *
 * Note on directory resets: `main()` no longer blanket-resets
 * GENERATED_AGENTS_DIR / commands / GENERATED_SKILLS_DIR before writing.
 * R6.1 requires a pointer-skip to leave the EXISTING mirror untouched, which
 * an upfront `resetDir` would have already destroyed by the time the skip
 * decision is made. Each category is now synced in place -- write or
 * preserve per source, then prune only the mirror files that have no
 * surviving source (pruneStaleMirrorFiles) -- which is strictly stronger
 * than the previous reset-then-regenerate-everything shape, not weaker: a
 * genuinely removed source still has its mirror removed, same as before.
 */
function main() {
  const allowShrink = process.argv.includes(ALLOW_SHRINK_FLAG);
  const counts = { agentsSynced: 0, commandsSynced: 0, skillsSynced: 0, skipped: 0, rewritten: 0, rewriteSkipsHonoured: 0 };
  // HIGH-1: every target pointer-skipped by ANY of the three sync loops below
  // is collected here so the rewrite pass (which walks the same three
  // directories again) can refuse to touch it too -- a single source of
  // truth for "this run declined to overwrite this mirror", shared across
  // both write paths rather than re-derived.
  const pointerSkipSet = new Set();

  // LOW-3 (Phase G judge): enumerateAgentSources() throws on a basename
  // collision, and it used to be called only when the agent loop was reached
  // -- i.e. AFTER the command mirrors had already been written and pruned. The
  // throw is uncaught, so a collision left the tree half-synced with no
  // summary, which is exactly the partial-write shape the normalizeHooks catch
  // below was added to stop being silent about. Enumeration is a pure read, so
  // it is hoisted here: a collision now aborts before anything has been
  // written at all, which is strictly better than reporting the partial write
  // after the fact.
  const agentSources = enumerateAgentSources(join(CLAUDE_DIR, "agents"));

  ensureDir(GENERATED_COMMANDS_DIR);
  const keepCommandTargets = new Set();
  for (const file of readdirSync(join(CLAUDE_DIR, "commands", "pp"))) {
    if (!file.endsWith(".md")) continue;
    const written = syncMirrorEntry({
      sourcePath: join(CLAUDE_DIR, "commands", "pp", file),
      targetPath: join(GENERATED_COMMANDS_DIR, file),
      render: renderCommand,
      allowShrink,
      counts,
      keepSet: keepCommandTargets,
      pointerSkipSet,
    });
    if (written) counts.commandsSynced += 1;
  }
  pruneStaleMirrorFiles(GENERATED_COMMANDS_DIR, keepCommandTargets);

  ensureDir(GENERATED_AGENTS_DIR);
  const keepAgentTargets = new Set();
  // Phase G (GitHub #48): recursive enumeration -- see enumerateAgentSources
  // for why a flat readdirSync would silently drop nested agents, and why a
  // basename collision across subdirectories must fail loudly instead of
  // letting one mirror write silently overwrite the other.
  for (const { file, sourcePath } of agentSources) {
    const written = syncMirrorEntry({
      sourcePath,
      targetPath: join(GENERATED_AGENTS_DIR, `${basename(file, ".md")}.agent.md`),
      render: renderAgent,
      allowShrink,
      counts,
      keepSet: keepAgentTargets,
      pointerSkipSet,
    });
    if (written) counts.agentsSynced += 1;
  }
  pruneStaleMirrorFiles(GENERATED_AGENTS_DIR, keepAgentTargets);

  ensureDir(GENERATED_SKILLS_DIR);
  const keepSkillTargets = new Set();
  for (const { name, sourcePath } of enumerateSkillSources(join(CLAUDE_DIR, "skills"))) {
    const written = syncMirrorEntry({
      sourcePath,
      targetPath: join(GENERATED_SKILLS_DIR, name, "SKILL.md"),
      render: renderSkill,
      allowShrink,
      counts,
      keepSet: keepSkillTargets,
      pointerSkipSet,
    });
    if (written) counts.skillsSynced += 1;
  }
  pruneStaleMirrorFiles(GENERATED_SKILLS_DIR, keepSkillTargets);
  pruneEmptySkillDirs(GENERATED_SKILLS_DIR);

  try {
    normalizeHooks(join(CLAUDE_DIR, "settings.template.json"), [
      GENERATED_PLUGIN_HOOKS_PATH,
      GENERATED_REPO_HOOKS_PATH,
    ], { allowShrink, counts });
  } catch (err) {
    // LOW-1: this branch used to write only the raw error to stderr, set
    // exitCode=1, and `return` -- skipping the summary entirely. Everything
    // synced by the three mirror loops above (agents/commands/skills) had
    // ALREADY been written to disk by this point (normalizeHooks runs after
    // them), so the run left partial state behind with no record of how far
    // it got before the R5.2 throw. printSummary() now runs on this path
    // too, labelled as a partial/aborted run, so a partial write is never
    // silent about its own extent.
    process.stderr.write(`${err && err.message ? err.message : String(err)}\n`);
    // NEW-2: this reason was hardcoded to "normalizeHooks threw (R5.2)", but
    // the catch is broader than that -- a malformed settings.template.json
    // raises a JSON.parse SyntaxError from the same block. Name the error
    // instead of asserting a cause we did not check.
    const errName = err && err.name ? err.name : "Error";
    printSummary(counts, {
      aborted: true,
      reason: `${errName} raised while normalising hooks; see error above`,
    });
    process.exitCode = 1;
    return;
  }

  // Keep `.claude` untouched while letting Copilot mirrors diverge where the
  // GitHub entrypoint intentionally uses different model ids and lookup paths.
  rewriteGeneratedCopilotMirrors({ pointerSkipSet, allowShrink, counts });

  printSummary(counts, { aborted: false });
  if (counts.skipped > 0) {
    console.error(
      `[sync-copilot-assets] FAILURE: ${counts.skipped} entr${counts.skipped === 1 ? "y" : "ies"} ` +
      `skipped or refused during sync -- see warnings above.`,
    );
    process.exitCode = 1;
  }
}

/**
 * LOW-1: shared by the normal completion path and the normalizeHooks-throw
 * abort path, so a failure that stops the run partway through still reports
 * exactly what had already been written (`counts` is accumulated in place by
 * every write site as the run progresses, so it is accurate up to the point
 * of the throw regardless of where that point falls).
 */
function printSummary(counts, { aborted, reason } = {}) {
  console.log(
    `[sync-copilot-assets] agents synced: ${counts.agentsSynced}, ` +
    `commands synced: ${counts.commandsSynced}, skills synced: ${counts.skillsSynced}, ` +
    `mirrors rewritten: ${counts.rewritten}, entries skipped: ${counts.skipped}, ` +
    `rewrite skips honoured: ${counts.rewriteSkipsHonoured}` +
    (aborted ? ` -- PARTIAL: run aborted before completion (${reason})` : ""),
  );
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
//
// The remaining exports below are exported for testing only too (R10.6,
// R10.7): enumerateSkillSources and normalizeHooks are pure functions that a
// future guard drives directly against temp-directory / in-memory fixtures
// rather than the real .claude tree, per AGENTS.md's ANTI-STALL TEST RULE.
// NEW-3: `preservedFrontmatterComments` and `isDirectInvocation` are imported
// today by daemon/test/sync-comment-injection.unit.mjs. The other five have no
// importer yet and are exported deliberately, not left behind: Phase F commit 3
// adds daemon/test/skill-discovery.unit.mjs, and spec R11 requires its fixtures
// to drive the REAL functions rather than reimplement them -- a reimplemented
// fixture is one of the vacuity shapes this campaign has already shipped three
// times. If commit 3 lands without importing one of the five, that export is
// dead surface and should be removed then.
//
// R3-tail retry (2026-09-07): `syncMirrorEntry` is a second, explicitly
// authorised generator export for this same reason -- the ONLY further export
// this retry adds (`pruneStaleMirrorFiles` is deliberately NOT exported here;
// the guard drives a scaffolding equivalent instead, see the comment above
// `pruneStaleMirrorFilesLocal` in skill-discovery.unit.mjs for why that is
// still a faithful check of the real invariant). The prior version of the
// guard only drove `isPointerFile()` and `writeMirrorSafely()` separately with
// hand-glued control flow standing in for `syncMirrorEntry`'s real decision
// order -- so the two lines that actually make a pointer-skip survive the
// prune pass (`keepSet.add(targetPath)` and `pointerSkipSet.add(targetPath)`
// inside the pointer branch above) were never exercised by any test. That is
// the exact shape of the ~673-line incident: the skip itself worked, but
// nothing proved the skip's target was protected from the prune pass that
// runs immediately afterward in every real sync.
//
// Phase G (GitHub #48): `enumerateAgentSources` is a third, explicitly
// authorised generator export (daemon/test/agent-frontmatter.unit.mjs). Its
// recursive-scan and basename-collision-throws behaviour is the generator's
// half of the recursive-scan platform fact; the guard drives this real
// function against temp-directory fixtures rather than reimplementing the
// walk, for the same reason as every other export in this block.
export {
  preservedFrontmatterComments,
  isDirectInvocation,
  enumerateSkillSources,
  enumerateAgentSources,
  normalizeHooks,
  writeMirrorSafely,
  syncMirrorEntry,
  // Exported for the same reason as syncMirrorEntry: the guard's scaffold
  // reproduction of this walked the target dir only one level deep, while the
  // real function delegates to the RECURSIVE listMarkdownFiles -- and the
  // skills mirror's targets are nested at <name>/SKILL.md. A scaffold that
  // cannot reach the nested case cannot prove the nested case survives.
  pruneStaleMirrorFiles,
  MIRROR_SHRINK_THRESHOLD,
  ALLOW_SHRINK_FLAG,
};
