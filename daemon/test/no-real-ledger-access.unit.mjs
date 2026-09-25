// Static regression guard: no file under daemon/test/ may resolve or open
// the operator's REAL ~/.pair-programmer/state.db.
//
// Regression covered (Reflexion retry, codex gpt-5.6-terra critique):
// daemon/test/best-of-data-loss.mjs test 3 hardcoded
// `join(process.env.USERPROFILE ?? process.env.HOME, ".pair-programmer", "state.db")`
// for a raw SQLite insert/read, bypassing every other test's PP_HOME
// isolation and writing directly into the operator's real ledger.
//
// This test scans every daemon/test/**/*.mjs file (this file's own source
// excluded, since it legitimately CONTAINS the banned patterns as string
// literals below) for source patterns that resolve a real-home ledger path
// -- `homedir()`/`os.homedir()`/`process.env.USERPROFILE`/`process.env.HOME`
// combined with the ".pair-programmer" root or a literal "state.db" join --
// and fails with the exact file and line number of any match.
//
// scripts/hermetic-guard.mjs is the ONE sanctioned real-ledger reader (a
// read-only pretest/posttest snapshot/verify check); it is intentionally
// excluded from this scan and is covered by its own leak-specific tests in
// test/hermetic-guard.unit.mjs.

import { strict as assert } from "node:assert";
import { it } from "node:test";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEST_DIR = __dirname;
const SELF = fileURLToPath(import.meta.url);

// Patterns that resolve a REAL (unredirected) home-directory ledger path.
// Each is matched against a 3-line sliding window (current line + 2 lines
// of lookahead) so a multi-line `join(\n  homedir(),\n  ".pair-programmer"\n)`
// call is still caught, while staying a cheap regex scan (no AST parse).
const DANGEROUS_PATTERNS = [
  {
    re: /(?:os\.)?homedir\(\)[\s\S]{0,80}?\.pair-programmer/,
    desc: "homedir() joined directly with '.pair-programmer' (bypasses PP_HOME)",
  },
  {
    re: /process\.env\.(?:USERPROFILE|HOME)\b(?![^\n]*\bPP_HOME\b)[\s\S]{0,80}?\.pair-programmer/,
    desc: "process.env.USERPROFILE/HOME joined directly with '.pair-programmer' (bypasses PP_HOME)",
  },
];

// scripts/hermetic-guard.mjs's own `join(homedir(), ".pair-programmer")`
// fallback is the one sanctioned real-ledger resolution (read-only
// snapshot/verify) and is excluded by directory, not by pattern -- so this
// guard stays meaningful if that file is ever copied into test/.
const ALLOWED_RELATIVE_PATHS = new Set([]);

function collectMjsFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...collectMjsFiles(full));
    } else if (entry.isFile() && entry.name.endsWith(".mjs")) {
      out.push(full);
    }
  }
  return out;
}

function scanFile(filePath) {
  const src = readFileSync(filePath, "utf8");
  const lines = src.split("\n");
  const findings = [];
  for (const { re, desc } of DANGEROUS_PATTERNS) {
    // Slide a window over the whole source (not per-line) so multi-line
    // joins are caught, but report the 1-based line number of the match start.
    const globalRe = new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g");
    let m;
    while ((m = globalRe.exec(src)) !== null) {
      const upTo = src.slice(0, m.index);
      const lineNo = upTo.split("\n").length;
      findings.push({ line: lineNo, desc, snippet: lines[lineNo - 1]?.trim() ?? "" });
      if (m.index === globalRe.lastIndex) globalRe.lastIndex++; // avoid infinite loop on zero-width
    }
  }
  return findings;
}

it("no daemon/test/**/*.mjs file resolves the operator's real ~/.pair-programmer ledger", () => {
  const files = collectMjsFiles(TEST_DIR).filter(
    (f) => f !== SELF && !ALLOWED_RELATIVE_PATHS.has(f)
  );
  assert.ok(files.length > 10, `sanity: expected many .mjs test files, found ${files.length}`);

  const allFindings = [];
  for (const file of files) {
    const findings = scanFile(file);
    for (const f of findings) {
      allFindings.push(`${file}:${f.line} — ${f.desc}\n    ${f.snippet}`);
    }
  }

  assert.equal(
    allFindings.length,
    0,
    `found ${allFindings.length} real-ledger-access pattern(s) under daemon/test/ ` +
      `(only scripts/hermetic-guard.mjs's read-only snapshot/verify may resolve the real ledger):\n` +
      allFindings.join("\n")
  );
});
