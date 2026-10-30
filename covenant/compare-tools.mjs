#!/usr/bin/env node
// One-off measurement for TASK-019, not a test. Compares the agent files `cov build` wrote
// (working tree) with the originals at a base commit (`git show <base>:<path>`).
//
//   node covenant/compare-tools.mjs [--base <rev>]      (default base: 35720d4)
//
// Exit 1 when
//   - a Claude effective tool set (tools minus disallowedTools; no `tools` key means every
//     tool) differs from the original, except for an agent whose .cov says `tools claude none`
//     (C.28), which is printed under its own heading with the original's names and is never
//     counted as matching; that agent must write `tools: []` and its original names must not
//     include a Claude Code tool;
//   - a generated Copilot file's `reasoningEffort` or `description` differs from the mirror's;
//   - a generated Claude file's `effort` or `description` differs from the original's.
// Node standard library only.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const bi = args.indexOf("--base");
const base = bi >= 0 ? args[bi + 1] : "35720d4";

const git = (...a) => execFileSync("git", a, { cwd: root, encoding: "utf8", maxBuffer: 64 << 20 });
const original = (path) => git("show", `${base}:${path}`);
const generated = (path) => {
  const p = join(root, path);
  return existsSync(p) ? readFileSync(p, "utf8") : null;
};

// Frontmatter reader that only looks at the lines it needs, so the four originals that a
// strict YAML parser rejects (a plain value containing ": ") read like the others.
function scalar(v) {
  v = v.trim();
  if (v.startsWith('"') && v.endsWith('"') && v.length >= 2) {
    try { return JSON.parse(v); } catch { return v.slice(1, -1); }
  }
  if (v.startsWith("'") && v.endsWith("'") && v.length >= 2) return v.slice(1, -1).replace(/''/g, "'");
  return v;
}
function listValue(v) {
  v = v.trim();
  if (v.startsWith("[") && v.endsWith("]")) {
    const inner = v.slice(1, -1).trim();
    return inner === "" ? [] : inner.split(",").map(scalar);
  }
  return v === "" ? [] : v.split(",").map((s) => scalar(s.trim()));
}
function parse(text) {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  if (lines[0] !== "---") return { fm: {}, body: lines };
  let end = lines.indexOf("---", 1);
  if (end < 0) end = lines.length;
  const fm = {};
  let cur = null;
  for (const line of lines.slice(1, end)) {
    if (/^\s*#/.test(line) || line.trim() === "") continue;
    let m = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(line);
    if (m) { cur = m[1]; fm[cur] = { raw: m[2], items: null }; continue; }
    m = /^\s+-\s+(.*)$/.exec(line);
    if (m && cur) { (fm[cur].items ??= []).push(scalar(m[1])); }
  }
  let body = lines.slice(end + 1);
  while (body.length && body[0].trim() === "") body.shift();
  while (body.length && body[body.length - 1].trim() === "") body.pop();
  return { fm, body };
}
const has = (fm, k) => k in fm;
const listOf = (fm, k) => (!has(fm, k) ? null : fm[k].items ?? listValue(fm[k].raw));
const strOf = (fm, k) => (!has(fm, k) ? null : fm[k].items ? fm[k].items.join(", ") : scalar(fm[k].raw));

// Claude effective tools: null means every tool.
function effective(fm) {
  const t = listOf(fm, "tools");
  if (t === null) return null;
  const d = new Set(listOf(fm, "disallowedTools") ?? []);
  return new Set(t.filter((x) => !d.has(x)));
}
const fmt = (s) => (s === null ? "(every tool)" : `[${[...s].sort().join(", ")}]`);
function setDiff(o, g) {
  if (o === null && g === null) return null;
  if (o === null) return { missing: [], extra: [...g].sort(), note: "original is every tool" };
  if (g === null) return { missing: [...o].sort(), extra: [], note: "generated is every tool" };
  const missing = [...o].filter((x) => !g.has(x)).sort();
  const extra = [...g].filter((x) => !o.has(x)).sort();
  return missing.length || extra.length ? { missing, extra } : null;
}

// Copilot tools: no key and ["*"] both mean every tool. A mirror `server/*` against named
// `server/x` entries is "named, narrower", not a mismatch.
function copilotTools(fm) {
  const t = listOf(fm, "tools");
  if (t === null || t.includes("*")) return null;
  return new Set(t);
}
function copilotRelation(o, g) {
  if (o === null && g === null) return { kind: "same" };
  if (o === null) return { kind: "differs", why: `mirror is every tool, generated ${fmt(g)}` };
  if (g === null) return { kind: "differs", why: `mirror ${fmt(o)}, generated is every tool` };
  const wild = [...o].filter((x) => x.endsWith("/*")).map((x) => x.slice(0, -1));
  const covers = (x) => o.has(x) || wild.some((w) => x.startsWith(w));
  const missing = [...o].filter((x) => !x.endsWith("/*") && !g.has(x));
  const unmatchedWild = wild.filter((w) => ![...g].some((x) => x.startsWith(w)));
  const extra = [...g].filter((x) => !covers(x));
  if (!missing.length && !extra.length && !unmatchedWild.length) {
    const narrowed = [...o].some((x) => x.endsWith("/*") && !g.has(x));
    return narrowed ? { kind: "narrower", why: `mirror ${fmt(o)}, generated ${fmt(g)}` } : { kind: "same" };
  }
  return { kind: "differs", why: `missing ${[...missing, ...unmatchedWild.map((w) => w + "*")].join(", ") || "-"}; extra ${extra.join(", ") || "-"}` };
}

// Line diff (LCS) of two bodies.
function lineDiff(a, b) {
  const n = a.length, m = b.length;
  const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const lcs = dp[0][0];
  return { removed: n - lcs, added: m - lcs };
}

const otherKeys = (fm) => Object.keys(fm).filter((k) => !["tools", "disallowedTools"].includes(k)).sort();
function keyDiffs(o, g) {
  const out = [];
  for (const k of new Set([...otherKeys(o), ...otherKeys(g)])) {
    const a = strOf(o, k), b = strOf(g, k);
    if (a === null) out.push(`+${k}=${JSON.stringify(b)}`);
    else if (b === null) out.push(`-${k}`);
    else if (a !== b) out.push(`~${k} ${JSON.stringify(a.length > 40 ? a.slice(0, 40) + "…" : a)} -> ${JSON.stringify(b.length > 40 ? b.slice(0, 40) + "…" : b)}`);
  }
  return out;
}

const names = git("ls-tree", "--name-only", base, ".claude/agents/").split("\n").filter((l) => l.endsWith(".md")).map((l) => l.replace(/^.*\//, "").replace(/\.md$/, "")).sort();
const toolsNone = (name) => {
  const p = join(root, "covenant", `${name}.cov`);
  return existsSync(p) && /^\s*tools\s+claude\s+none\s*$/m.test(readFileSync(p, "utf8"));
};
// The tools Claude Code ships; an original naming one of these is not the VS Code-only list C.28 describes.
const CLAUDE_CODE_TOOLS = new Set(["Agent", "AskUserQuestion", "Bash", "Edit", "Glob", "Grep", "NotebookEdit", "Read", "Skill", "Task", "TodoWrite", "WebFetch", "WebSearch", "Write"]);
const fieldDiff = (label, o, g, fm1, fm2, key) => {
  const a = strOf(fm1, key), b = strOf(fm2, key);
  return a === b ? null : `${label} ${key}: ${a === null ? "(none)" : JSON.stringify(a.length > 60 ? a.slice(0, 60) + "…" : a)} -> ${b === null ? "(none)" : JSON.stringify(b.length > 60 ? b.slice(0, 60) + "…" : b)}`;
};

let failures = 0;
const star = [];
const fieldFailures = [];
const rows = [];
for (const name of names) {
  const cPath = `.claude/agents/${name}.md`;
  const gPath = `.github/agents/${name}.agent.md`;
  const co = parse(original(cPath));
  const po = parse(original(gPath));
  const cg = generated(cPath), pg = generated(gPath);
  const r = { name, lines: [] };
  if (cg === null || pg === null) {
    r.lines.push(`MISSING generated ${cg === null ? cPath : ""} ${pg === null ? gPath : ""}`.trim());
    failures++;
    rows.push(r);
    continue;
  }
  const cgp = parse(cg), pgp = parse(pg);

  const eo = effective(co.fm), eg = effective(cgp.fm);
  const d = setDiff(eo, eg);
  const isStar = toolsNone(name);
  r.claudeTools = isStar ? "tools claude none" : d === null ? "same" : "DIFFERS";
  if (isStar) {
    const bad = eg === null || eg.size !== 0 || (eo ?? new Set()).size === 0 || [...eo].some((x) => CLAUDE_CODE_TOOLS.has(x));
    star.push({ name, original: eo === null ? null : [...eo].sort() });
    if (bad) failures++;
  } else if (d) {
    r.lines.push(`claude tools: original ${fmt(eo)}; generated ${fmt(eg)}`);
    if (d.missing.length) r.lines.push(`  missing from generated: ${d.missing.join(", ")}`);
    if (d.extra.length) r.lines.push(`  extra in generated: ${d.extra.join(", ")}`);
    failures++;
  }
  for (const x of [fieldDiff("claude", 0, 0, co.fm, cgp.fm, "effort"), fieldDiff("claude", 0, 0, co.fm, cgp.fm, "description"),
                   fieldDiff("copilot", 0, 0, po.fm, pgp.fm, "reasoningEffort"), fieldDiff("copilot", 0, 0, po.fm, pgp.fm, "description")])
    if (x) fieldFailures.push(`${name}: ${x}`);
  const ck = keyDiffs(co.fm, cgp.fm);
  r.claudeKeys = ck;
  const cb = lineDiff(co.body, cgp.body);
  r.claudeBody = cb;

  const rel = copilotRelation(copilotTools(po.fm), copilotTools(pgp.fm));
  r.copilotTools = rel.kind === "same" ? "same" : rel.kind === "narrower" ? "named, narrower" : "differs";
  if (rel.why) r.lines.push(`copilot tools (${r.copilotTools}): ${rel.why}`);
  r.copilotModel = `${strOf(po.fm, "model") ?? "-"} -> ${strOf(pgp.fm, "model") ?? "-"}`;
  r.copilotPolicy = `${strOf(po.fm, "modelPolicy") ?? "-"} -> ${strOf(pgp.fm, "modelPolicy") ?? "-"}`;
  r.copilotKeys = keyDiffs(po.fm, pgp.fm).filter((x) => !/^[~+-](model|modelPolicy)\b/.test(x));
  r.copilotBody = lineDiff(po.body, pgp.body);
  rows.push(r);
}

console.log(`base ${base}; ${names.length} agents\n`);
console.log("agent | claude tools | claude body +/- | copilot tools | copilot model | modelPolicy | copilot body +/-");
for (const r of rows) {
  if (!r.claudeTools) { console.log(`${r.name} | ${r.lines[0]}`); continue; }
  console.log([r.name, r.claudeTools, `+${r.claudeBody.added}/-${r.claudeBody.removed}`, r.copilotTools, r.copilotModel, r.copilotPolicy, `+${r.copilotBody.added}/-${r.copilotBody.removed}`].join(" | "));
}
console.log("\nother frontmatter keys and values, original -> generated (+ added, - dropped, ~ changed)");
for (const r of rows) {
  if (!r.claudeKeys) continue;
  console.log(`${r.name}\n  claude: ${r.claudeKeys.join("; ") || "none"}\n  copilot: ${r.copilotKeys.join("; ") || "none"}`);
}
console.log("\ntool detail");
for (const r of rows) for (const l of r.lines) console.log(`${r.name}: ${l}`);

console.log(`\nClaude effective tool sets: ${rows.filter((r) => r.claudeTools === "same").length} same, ${failures} differ, ${star.length} under tools claude none`);
if (star.length) {
  console.log(`\n\`tools claude none\` agents (not counted as matching; generated Claude file is \`tools: []\`, the original listed only these names, none a Claude Code tool):`);
  for (const { name, original } of star) console.log(`  ${name}: original ${original === null ? "(every tool)" : `${original.length} names: ${original.join(", ")}`}`);
}
console.log(`\neffort and description differences (claude against the original, copilot against the mirror): ${fieldFailures.length}`);
for (const l of fieldFailures) console.log(`  ${l}`);
process.exit(failures || fieldFailures.length ? 1 : 0);
