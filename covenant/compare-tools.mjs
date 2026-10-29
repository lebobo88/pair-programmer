// Compares each agent's tools across the original files and the Covenant output.
//
//   node covenant/compare-tools.mjs [OUT_DIR]
//
// Claude: the emitted effective set (`tools` minus `disallowedTools`) must equal the
// original `tools` in .claude/agents/NAME.md; any difference makes the script exit 1.
// Copilot: the emitted capabilities are listed against the mirror in
// .github/agents/NAME.agent.md. Differences are reported, never fatal.
//
// Only the `tools` line(s) are read from each original, because a few originals have
// frontmatter that a strict YAML parser rejects. Node standard library only.
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "..");
const outDir = resolve(process.argv[2] ?? join(here, "out"));

const unquote = (s) => s.trim().replace(/^(["'])(.*)\1$/, "$2").trim();

// The lines between the first two `---` fences, with CRLF normalized.
function frontmatter(file) {
  const lines = readFileSync(file, "utf8").replace(/\r\n?/g, "\n").split("\n");
  if (lines[0].trim() !== "---") throw new Error(`${file}: no frontmatter`);
  const end = lines.indexOf("---", 1);
  if (end < 0) throw new Error(`${file}: unterminated frontmatter`);
  return lines.slice(1, end);
}

// Reads one key as a list. Forms: `key: a, b` (comma string), `key: [a, b]` (inline
// list), and `key:` followed by `- a` lines (YAML list). A missing key is null.
function listField(file, key) {
  const fm = frontmatter(file);
  const i = fm.findIndex((l) => l.startsWith(`${key}:`));
  if (i < 0) return null;
  const rest = fm[i].slice(key.length + 1).trim();
  if (rest === "") {
    const items = [];
    for (const l of fm.slice(i + 1)) {
      const m = /^\s+-\s+(.*)$/.exec(l);
      if (!m) break;
      items.push(unquote(m[1]));
    }
    return items;
  }
  const body = rest.startsWith("[") && rest.endsWith("]") ? rest.slice(1, -1) : rest;
  return body.split(",").map(unquote).filter(Boolean);
}

const sorted = (set) => [...set].sort();
const minus = (a, b) => sorted(a).filter((x) => !b.has(x));

const names = readdirSync(join(repo, ".claude/agents"))
  .filter((f) => f.endsWith(".md"))
  .map((f) => f.slice(0, -3))
  .sort();

let claudeDiffs = 0;
let copilotDiffs = 0;
let narrowed = 0;

for (const name of names) {
  const origClaude = new Set(listField(join(repo, ".claude/agents", `${name}.md`), "tools") ?? []);
  const emClaudeFile = join(outDir, ".claude/agents", `${name}.md`);
  const emTools = new Set(listField(emClaudeFile, "tools") ?? []);
  const emDeny = new Set(listField(emClaudeFile, "disallowedTools") ?? []);
  const effective = new Set([...emTools].filter((t) => !emDeny.has(t)));
  const missing = minus(origClaude, effective);
  const extra = minus(effective, origClaude);
  const same = missing.length === 0 && extra.length === 0;
  if (!same) claudeDiffs++;

  const mirrorList = listField(join(repo, ".github/agents", `${name}.agent.md`), "tools");
  const emCopilotList = listField(join(outDir, ".github/agents", `${name}.agent.md`), "tools");
  const mirror = new Set(mirrorList ?? []);
  const emCopilot = new Set(emCopilotList ?? []);
  // A missing `tools` key and an empty list are different on Copilot: the empty list
  // disables every tool, the missing key leaves the CLI's default set.
  const keyDiffers = (mirrorList === null) !== (emCopilotList === null);
  // A mirror entry `server/*` stands for every tool of that server; named entries
  // `server/x` in the output are narrower, not a mismatch.
  const wildcards = [...mirror].filter((t) => t.endsWith("/*")).map((t) => t.slice(0, -1));
  const coveredByWildcard = (t) => wildcards.some((w) => t.startsWith(w) && !t.endsWith("/*"));
  const narrowerNamed = [...emCopilot].filter((t) => !mirror.has(t) && coveredByWildcard(t));
  const onlyOut = sorted(emCopilot).filter((t) => !mirror.has(t) && !coveredByWildcard(t));
  const onlyMirror = sorted(mirror).filter((t) => {
    if (emCopilot.has(t)) return false;
    return !(t.endsWith("/*") && narrowerNamed.some((n) => n.startsWith(t.slice(0, -1))));
  });
  if (narrowerNamed.length) narrowed++;
  const copilotSame = onlyOut.length === 0 && onlyMirror.length === 0 && !keyDiffers;
  if (!copilotSame) copilotDiffs++;

  console.log(`${name}`);
  console.log(
    `  claude: effective set equals original: ${same ? "yes" : "NO"}` +
      ` (original ${origClaude.size}, effective ${effective.size}, disallowed ${emDeny.size})`,
  );
  if (missing.length) console.log(`    missing from emitted: ${missing.join(", ")}`);
  if (extra.length) console.log(`    extra in emitted: ${extra.join(", ")}`);
  console.log(`  copilot: ${copilotSame ? "matches mirror" : "differs from mirror"}`);
  if (keyDiffers)
    console.log(
      `    mirror ${mirrorList === null ? "has no `tools` key" : "has a `tools` key"}; ` +
        `emitted ${emCopilotList === null ? "has none" : `has \`tools: [${emCopilotList.join(", ")}]\``}`,
    );
  if (onlyOut.length) console.log(`    only in emitted: ${onlyOut.join(", ")}`);
  if (onlyMirror.length) console.log(`    only in mirror: ${onlyMirror.join(", ")}`);
  if (narrowerNamed.length)
    console.log(`    named, narrower than the mirror's wildcard (not a mismatch): ${narrowerNamed.join(", ")}`);
}

console.log("");
console.log(`agents: ${names.length}`);
console.log(`claude effective set differs from original: ${claudeDiffs}`);
console.log(`copilot differs from mirror (excluding named-narrower): ${copilotDiffs}`);
console.log(`copilot agents with named tools narrower than a mirror wildcard: ${narrowed}`);
process.exit(claudeDiffs > 0 ? 1 : 0);
