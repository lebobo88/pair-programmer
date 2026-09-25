// Static regression guard: no file under daemon/test/ may resolve or open
// the operator's REAL ~/.pair-programmer/state.db.
//
// Regression covered (Reflexion retry, codex gpt-5.6-terra critique):
// daemon/test/best-of-data-loss.mjs test 3 hardcoded
// `join(process.env.USERPROFILE ?? process.env.HOME, ".pair-programmer", "state.db")`
// for a raw SQLite insert/read, bypassing every other test's PP_HOME
// isolation and writing directly into the operator's real ledger.
//
// Second regression covered (cross-vendor judge, PP_DB_PATH-vs-PP_HOME
// precedence audit): several daemon-spawning tests set
// `env: { ...process.env, PP_HOME: someTempDir }` on a spawned child. Since
// src/util/paths.ts resolves `DB_PATH = process.env.PP_DB_PATH ?? join(PP_HOME, ...)`,
// PP_DB_PATH WINS. An operator with PP_DB_PATH exported in their shell (e.g.
// pointing at their real ledger for a one-off debugging session) had that
// override silently survive the spread into every such child, no matter what
// PP_HOME was set to. test/fixtures/isolated-env.mjs is the one sanctioned
// fix: it scrubs both variables from the base env and sets BOTH explicitly.
//
// This test scans every daemon/test/**/*.mjs file (this file's own source
// excluded, since it legitimately CONTAINS the banned patterns as string
// literals below) for source patterns that resolve a real-home ledger path,
// and fails with the exact file and line number of any match. It also runs
// a falsification pass (in-memory fixture strings, no real files) proving
// each pattern actually fires on the banned shape and stays silent on the
// compliant, helper-based shape.
//
// scripts/hermetic-guard.mjs is the ONE sanctioned real-ledger reader (a
// read-only pretest/posttest snapshot/verify check); it is intentionally
// excluded from this scan and is covered by its own leak-specific tests in
// test/hermetic-guard.unit.mjs. test/fixtures/isolated-env.mjs is the ONE
// sanctioned place that assigns/deletes process.env.PP_DB_PATH /
// process.env.PP_HOME directly; it is excluded from the ambient-read scan
// below for the same reason.

import { strict as assert } from "node:assert";
import { it } from "node:test";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEST_DIR = __dirname;
const SELF = fileURLToPath(import.meta.url);
const ISOLATED_ENV_HELPER = join(TEST_DIR, "fixtures", "isolated-env.mjs");

// Patterns that resolve a REAL (unredirected) home-directory ledger path.
// Each is matched against a sliding window of the whole source (current
// match position + lookahead) so a multi-line
// `join(\n  homedir(),\n  ".pair-programmer"\n)` call is still caught, while
// staying a cheap regex scan (no AST parse).
const DANGEROUS_PATTERNS = [
  {
    id: "homedir-join",
    re: /(?:os\.)?homedir\(\)[\s\S]{0,80}?\.pair-programmer/,
    desc: "homedir() joined directly with '.pair-programmer' (bypasses PP_HOME)",
  },
  {
    id: "userprofile-home-join",
    re: /process\.env\.(?:USERPROFILE|HOME)\b(?![^\n]*\bPP_HOME\b)[\s\S]{0,80}?\.pair-programmer/,
    desc: "process.env.USERPROFILE/HOME joined directly with '.pair-programmer' (bypasses PP_HOME)",
  },
  {
    id: "ambient-db-path-fallback-chain",
    // The original best-of-data-loss.mjs regression shape: process.env.PP_DB_PATH
    // used as a `??` fallback operand while deriving a db path. Deliberately
    // narrower than "any read of process.env.PP_DB_PATH" -- a save/restore
    // idiom (`const prior = process.env.PP_DB_PATH; ...; process.env.PP_DB_PATH = prior;`,
    // used by e.g. test/hermetic-guard.unit.mjs to test the guard's OWN
    // precedence logic against disposable temp ledgers) is legitimate and
    // must not be flagged; a `??`-chained fallback used to build the path
    // actually OPENED is exactly the dangerous shape.
    re: /\?\?\s*process\.env\.PP_DB_PATH\b/,
    desc:
      "uses process.env.PP_DB_PATH as a `??` fallback while deriving a db path -- an operator-exported " +
      "PP_DB_PATH wins over any PP_HOME override (src/util/paths.ts) and this can resolve straight to the " +
      "real ledger. Use isolatedChildEnv()'s returned ppDbPath from test/fixtures/isolated-env.mjs instead.",
  },
  {
    id: "ambient-db-path-raw-open",
    // A raw `new Database(...)` call opened directly against
    // process.env.PP_DB_PATH (no isolatedChildEnv/makeTempLedger indirection).
    re: /new Database\([^)]*process\.env\.PP_DB_PATH[^)]*\)/,
    desc:
      "opens a raw Database(...) connection directly against process.env.PP_DB_PATH -- use the explicit " +
      "ppDbPath returned by isolatedChildEnv()/makeTempLedger() in test/fixtures/isolated-env.mjs instead.",
  },
  {
    id: "ambient-home-db-path-join",
    // The original best-of-data-loss.mjs regression shape, generalized: a
    // join(...) call that builds a state.db path directly out of
    // process.env.PP_HOME instead of an explicit isolated temp path.
    re: /join\([^)]*process\.env\.PP_HOME[^)]*state\.db[^)]*\)/,
    desc:
      "builds a state.db path from process.env.PP_HOME directly -- use the explicit ppDbPath returned by " +
      "isolatedChildEnv()/makeTempLedger() in test/fixtures/isolated-env.mjs instead",
  },
  {
    id: "literal-absolute-state-db-path",
    // A hardcoded, drive-letter-rooted absolute literal ending in
    // .pair-programmer/state.db or .pair-programmer\state.db (either slash
    // direction) -- the "operator's real ledger, spelled out by hand" shape.
    re: /[A-Za-z]:[\\/]+[^\s"'`]*\.pair-programmer[\\/]+state\.db/,
    desc: "hardcodes a literal absolute .pair-programmer/state.db path (both slash directions banned)",
  },
];

// scripts/hermetic-guard.mjs's own `join(homedir(), ".pair-programmer")`
// fallback is the one sanctioned real-ledger resolution (read-only
// snapshot/verify) and is excluded by directory, not by pattern -- so this
// guard stays meaningful if that file is ever copied into test/.
// test/fixtures/isolated-env.mjs is the one sanctioned place that reads/sets/
// deletes PP_DB_PATH and PP_HOME on process.env directly.
const ALLOWED_ABSOLUTE_PATHS = new Set([ISOLATED_ENV_HELPER]);

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

// Finds every `env:` object literal in `src` via simple brace-depth matching
// (good enough for this codebase's consistently simple, unnested env object
// literals -- no need for a real parser). Returns an array of the object
// literal's raw text (including the enclosing braces) plus its 1-based start
// line number.
function findEnvObjectLiterals(src) {
  const out = [];
  const re = /\benv\s*:\s*\{/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    const openIdx = src.indexOf("{", m.index);
    let depth = 0;
    let closeIdx = -1;
    for (let i = openIdx; i < src.length; i++) {
      if (src[i] === "{") depth++;
      else if (src[i] === "}") {
        depth--;
        if (depth === 0) { closeIdx = i; break; }
      }
    }
    if (closeIdx === -1) continue; // unbalanced -- give up on this occurrence
    const text = src.slice(openIdx, closeIdx + 1);
    const lineNo = src.slice(0, openIdx).split("\n").length;
    out.push({ text, line: lineNo });
    re.lastIndex = closeIdx + 1;
  }
  return out;
}

// Flags an `env:` object literal that spreads `...process.env` and overrides
// PP_HOME but never also pins PP_DB_PATH in the SAME literal. Order-
// independent (checks the whole object body for both keys, not a fixed
// lookahead window), so `{ ...process.env, PP_DB_PATH: x, PP_HOME: y }` is
// correctly NOT flagged regardless of key order.
function scanEnvSpreadFindings(src) {
  const findings = [];
  for (const { text, line } of findEnvObjectLiterals(src)) {
    const spreadsProcessEnv = /\.\.\.process\.env\b/.test(text);
    const setsHome = /\bPP_HOME\s*[,:]/.test(text) || /\bPP_HOME\b(?!\s*:)/.test(text); // covers `PP_HOME,` shorthand too
    const setsDbPath = /\bPP_DB_PATH\s*:/.test(text);
    if (spreadsProcessEnv && setsHome && !setsDbPath) {
      findings.push({
        line,
        desc:
          "spreads ...process.env and overrides PP_HOME without also pinning PP_DB_PATH in the same env object " +
          "-- an ambient operator PP_DB_PATH wins over PP_HOME (src/util/paths.ts) and leaks into the real ledger. " +
          "Use isolatedChildEnv() from test/fixtures/isolated-env.mjs instead.",
        snippet: text.split("\n")[0].trim(),
      });
    }
  }
  return findings;
}

// Runs every regex-based DANGEROUS_PATTERNS entry against `src`, returning
// `{ line, desc, snippet }` findings. Pure function over a string -- used by
// both the real-file scan and the falsification fixtures below.
function scanSource(src) {
  const lines = src.split("\n");
  const findings = [];
  for (const { re, desc } of DANGEROUS_PATTERNS) {
    const globalRe = new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g");
    let m;
    while ((m = globalRe.exec(src)) !== null) {
      const upTo = src.slice(0, m.index);
      const lineNo = upTo.split("\n").length;
      findings.push({ line: lineNo, desc, snippet: lines[lineNo - 1]?.trim() ?? "" });
      if (m.index === globalRe.lastIndex) globalRe.lastIndex++; // avoid infinite loop on zero-width
    }
  }
  findings.push(...scanEnvSpreadFindings(src));
  return findings;
}

function scanFile(filePath) {
  return scanSource(readFileSync(filePath, "utf8"));
}

it("no daemon/test/**/*.mjs file resolves the operator's real ~/.pair-programmer ledger", () => {
  const files = collectMjsFiles(TEST_DIR).filter(
    (f) => f !== SELF && !ALLOWED_ABSOLUTE_PATHS.has(f)
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
      `(only scripts/hermetic-guard.mjs's read-only snapshot/verify, and test/fixtures/isolated-env.mjs's ` +
      `sanctioned scrub/set, may touch these variables directly):\n` +
      allFindings.join("\n")
  );
});

// ─── Falsification: the guard itself must actually fire ───────────────────
// Small in-memory fixture SOURCE STRINGS (never written to disk, so they
// never appear in the real collectMjsFiles() scan above) -- one per banned
// pattern -- proving scanSource() reports each shape, and stays silent on
// the compliant, helper-based equivalent.

it("falsification: ambient-db-path-fallback-chain fires on the original best-of-data-loss.mjs `??` chain", () => {
  const bad = `const dbPath = env.PP_DB_PATH ?? process.env.PP_DB_PATH ?? join(ppHome, ".pair-programmer", "state.db");`;
  const findings = scanSource(bad).filter((f) => /`\?\?` fallback while deriving a db path/.test(f.desc));
  assert.ok(findings.length > 0, "expected the ambient-db-path-fallback-chain pattern to fire");
});

it("falsification: ambient-db-path-raw-open fires on a raw Database(...) opened against process.env.PP_DB_PATH", () => {
  const bad = `const dbConn = new Database(process.env.PP_DB_PATH);`;
  const findings = scanSource(bad).filter((f) => /opens a raw Database\(\.\.\.\) connection directly/.test(f.desc));
  assert.ok(findings.length > 0, "expected the ambient-db-path-raw-open pattern to fire");
});

it("falsification: a save/restore of process.env.PP_DB_PATH (no `??`, no raw Database open) is NOT flagged", () => {
  const good = `
    const priorDbPath = process.env.PP_DB_PATH;
    process.env.PP_DB_PATH = otherPath;
    try {
      doThing();
    } finally {
      if (priorDbPath === undefined) delete process.env.PP_DB_PATH;
      else process.env.PP_DB_PATH = priorDbPath;
    }
  `;
  const findings = scanSource(good).filter(
    (f) => f.desc.includes("PP_DB_PATH") && !f.desc.includes("spreads ...process.env"),
  );
  assert.deepEqual(findings, [], "a plain save/restore idiom must never be flagged as a real-ledger leak");
});

it("falsification: ambient-home-db-path-join fires on the original best-of-data-loss.mjs shape", () => {
  const bad = `const dbPath = join(process.env.PP_HOME, ".pair-programmer", "state.db");`;
  const findings = scanSource(bad).filter((f) => /builds a state\.db path from process\.env\.PP_HOME/.test(f.desc));
  assert.ok(findings.length > 0, "expected the ambient-home-db-path-join pattern to fire");
});

it("falsification: literal-absolute-state-db-path fires on a hardcoded drive-letter path (both slash directions)", () => {
  const forward = `const REAL = "C:/Users/rob/.pair-programmer/state.db";`;
  const backward = `const REAL = "C:\\\\Users\\\\rob\\\\.pair-programmer\\\\state.db";`;
  for (const bad of [forward, backward]) {
    const findings = scanSource(bad).filter((f) => /hardcodes a literal absolute/.test(f.desc));
    assert.ok(findings.length > 0, `expected the literal-absolute-state-db-path pattern to fire on: ${bad}`);
  }
});

it("falsification: homedir-join and userprofile-home-join still fire (pre-existing patterns)", () => {
  const bad1 = `const p = join(homedir(), ".pair-programmer", "state.db");`;
  const bad2 = `const p = join(process.env.USERPROFILE ?? process.env.HOME, ".pair-programmer", "state.db");`;
  assert.ok(scanSource(bad1).some((f) => /homedir\(\) joined/.test(f.desc)));
  assert.ok(scanSource(bad2).some((f) => /USERPROFILE\/HOME joined/.test(f.desc)));
});

it("falsification: env-spread-without-dbpath fires when PP_HOME is overridden but PP_DB_PATH is not, regardless of key order", () => {
  const bad = `
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [DAEMON, "mcp"],
      env: { ...process.env, PP_HOME: ppHome, EIGHTS_SKIP_AUDIT_CHECK: "1" },
    });
  `;
  const findings = scanSource(bad).filter((f) => /spreads \.\.\.process\.env and overrides PP_HOME/.test(f.desc));
  assert.ok(findings.length > 0, "expected the env-spread-without-dbpath pattern to fire");
});

it("falsification: the compliant isolatedChildEnv()-based form is NOT flagged by any pattern", () => {
  const good = `
    import { isolatedChildEnv } from "./fixtures/isolated-env.mjs";
    const { env, ppHome, ppDbPath } = isolatedChildEnv({ extra: { EIGHTS_SKIP_AUDIT_CHECK: "1" } });
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [DAEMON, "mcp"],
      env,
    });
    await fn(client, ppDbPath);
  `;
  assert.deepEqual(scanSource(good), [], "the compliant helper-based form must never be flagged");
});

it("falsification: an explicit PP_DB_PATH pin alongside a spread + PP_HOME override is NOT flagged (order-independent)", () => {
  // Mirrors test/schema-v10.unit.mjs / schema-v11-migration.unit.mjs's
  // legitimate legacy-fixture pattern: both variables pinned explicitly to
  // the test's OWN temp fixture paths, in either key order.
  const goodOrderA = `env: { ...process.env, PP_DB_PATH: legacyPath, PP_HOME: legacyDir, EIGHTS_SKIP_AUDIT_CHECK: "1" },`;
  const goodOrderB = `env: { ...process.env, PP_HOME: legacyDir, PP_DB_PATH: legacyPath, EIGHTS_SKIP_AUDIT_CHECK: "1" },`;
  for (const good of [goodOrderA, goodOrderB]) {
    const findings = scanEnvSpreadFindings(good);
    assert.deepEqual(findings, [], `expected no env-spread finding for: ${good}`);
  }
});
