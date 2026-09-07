/**
 * workflow-scripts.unit.mjs — Phase K (GitHub #52, epic #42)
 *
 * Guards every dynamic-workflow script under `.claude/workflows/`.
 *
 * WHY A GUARD AT ALL. A workflow script is JavaScript that Claude Code parses
 * and executes, and it is NOT covered by `tsc`, by eslint, or by any other
 * check in this repo. Its failure modes are all silent-until-invoked:
 *
 *   - a syntax error surfaces only when someone runs the workflow;
 *   - a non-literal `meta` block silently drops the command from `/`
 *     autocomplete (documented behaviour, not an error);
 *   - `Date.now()` / `Math.random()` / argless `new Date()` throw at RUNTIME,
 *     mid-fan-out, after agents have already been spawned and paid for;
 *   - `import()` fails the run before it starts;
 *   - a `phase()` title with no `meta.phases` entry quietly gets its own
 *     progress group instead of the one the author intended.
 *
 * ── STRUCTURE, AND WHY IT IS SHAPED THIS WAY ────────────────────────────────
 *
 * Every check is a PURE FUNCTION over source text, defined once in the CHECKS
 * section below. The real tests call those functions on the real files; the
 * falsification tests call THE SAME functions on fixture content.
 *
 * That is not stylistic. The first version of this file inlined a copy of each
 * regex into its falsification test and asserted it against a string literal —
 * so those tests passed by exercising V8's regex engine and `node:assert`,
 * never the guard. A cross-vendor judge (agy gemini-3.8-flash-medium) called it
 * out as vacuity class 3, the exact class this file's own header claims to
 * defend against, and it was right: had the real check been deleted, every
 * falsification test would still have gone green. Routing both paths through
 * one function is what makes a red fixture evidence about the guard.
 *
 * The same review found the comment stripper had a real bypass. See
 * `stripComments` for what it was and how it is closed.
 *
 * ANTI-STALL: self-contained. No daemon, no MCP peer, no network, no SQLite.
 * Reads files and parses strings.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const WORKFLOW_DIR = join(REPO_ROOT, ".claude", "workflows");

// ═══════════════════════════════════════════════════════════════════════════
// CHECKS — pure functions. The real tests and the falsification fixtures both
// go through these, so a fixture going red is evidence about the check.
// ═══════════════════════════════════════════════════════════════════════════

/** Runtime constructs the workflow docs state are unavailable or fatal. */
const BANNED = [
  ["import()", /\bimport\s*\(/, "dynamic import() — a script containing it fails before the run starts"],
  ["Date.now()", /\bDate\.now\s*\(/, "Date.now() — throws inside a workflow script (it would break resume)"],
  ["Math.random()", /\bMath\.random\s*\(/, "Math.random() — throws inside a workflow script"],
  ["new Date()", /\bnew\s+Date\s*\(\s*\)/, "argless new Date() — throws inside a workflow script"],
  ["require()", /\brequire\s*\(/, "require() — no module loading is available"],
  [
    "top-level import/export",
    /^\s*(?:import|export)\s+(?!const\s+meta)/m,
    "a top-level import/export other than `export const meta`",
  ],
];

/** TypeScript syntax — scripts are plain JavaScript. */
const TS_SMELLS = [
  ["type annotation", /:\s*(string|number|boolean|any|void)\s*[=,)\]]/],
  ["interface declaration", /\binterface\s+[A-Z]\w*\s*\{/],
  ["as-assertion", /\bas\s+(string|number|boolean|any)\b/],
  ["enum declaration", /\benum\s+[A-Z]\w*\s*\{/],
];

/**
 * Tools belonging to the driver/daemon past step 6 of /pp:best-of. A fan-out
 * script that calls any of them has silently widened past its boundary — the
 * exact mistake round-2 review caught in the original plan, and the one that
 * changes winner selection.
 */
const FORBIDDEN_TOOLS = [
  "diff_entropy",
  "borda_count",
  "record_verdict",
  "finalize_stage",
  "finalize_run",
  "archive_winner_and_losers",
  "teardown_candidates",
  "gate_eligible_judges",
];

/**
 * Strip comments so the banned-construct scan sees CODE, not documentation.
 *
 * This is load-bearing rather than cosmetic. A well-documented script is
 * *expected* to mention that `Math.random()` throws — `pp-best-of-fanout.js`
 * does, in the comment explaining why its rotation is index-addressed. A
 * scanner matching comments would report its own subject matter as a violation.
 *
 * THE NAIVE VERSION HAD TWO BYPASSES, both found by the cross-vendor judge.
 * It was `line.replace(/(^|[^:])\/\/.*$/, "$1")`:
 *
 *   1. FALSE NEGATIVE — a real banned call could HIDE behind a string literal
 *      containing a slash-slash:
 *          const sep = "//"; const leaked = Date.now();
 *      The regex found the `//` inside the string and erased the rest of the
 *      line, taking `Date.now()` with it. A guard that can be silenced by a
 *      string literal is worse than no guard, because it reports green.
 *   2. FALSE POSITIVE — the `[^:]` guard (added to protect `https://`) meant a
 *      comment preceded by a colon was never stripped:
 *          check:// Math.random() is documented here
 *      so documentation would be flagged as code.
 *
 * Both are closed by scanning character by character and tracking whether we
 * are inside a single-quoted, double-quoted, or template string. That also
 * handles `https://` correctly without needing the `[^:]` hack, since a URL in
 * code is inside a string and a URL in prose is inside a comment.
 *
 * Not a full JS tokenizer: regex literals containing quotes could still
 * confuse it. That limit is stated rather than papered over, and
 * `bannedConstructs` is a tripwire, not a compiler.
 */
function stripComments(src) {
  let out = "";
  let i = 0;
  const n = src.length;
  let quote = null; // "'" | '"' | "`" when inside a string

  while (i < n) {
    const c = src[i];
    const next = src[i + 1];

    if (quote) {
      if (c === "\\") {
        out += c + (next === undefined ? "" : next);
        i += 2;
        continue;
      }
      if (c === quote) quote = null;
      out += c;
      i += 1;
      continue;
    }

    if (c === "'" || c === '"' || c === "`") {
      quote = c;
      out += c;
      i += 1;
      continue;
    }

    if (c === "/" && next === "/") {
      // Line comment: drop to end of line, keep the newline so line-anchored
      // patterns (^...$ with /m) still see the right structure.
      while (i < n && src[i] !== "\n") i += 1;
      continue;
    }

    if (c === "/" && next === "*") {
      i += 2;
      while (i < n && !(src[i] === "*" && src[i + 1] === "/")) {
        // Preserve newlines so line numbers and /m anchors stay meaningful.
        if (src[i] === "\n") out += "\n";
        i += 1;
      }
      i += 2;
      continue;
    }

    out += c;
    i += 1;
  }

  return out;
}

/** Names of banned constructs present in CODE (comments already stripped). */
function bannedConstructs(code) {
  return BANNED.filter(([, re]) => re.test(code)).map(([name]) => name);
}

/** Names of TypeScript smells present in CODE. */
function tsSmells(code) {
  return TS_SMELLS.filter(([, re]) => re.test(code)).map(([name]) => name);
}

/** Forbidden `mcp__pp_harness__*` tools referenced in CODE. */
function forbiddenToolRefs(code) {
  return FORBIDDEN_TOOLS.filter(t => new RegExp(`mcp__pp_harness__${t}\\b`).test(code));
}

/**
 * Parse-check the script the way the runtime shapes it: `export const meta`
 * becomes a plain const and the body is wrapped in an async function, so that
 * top-level `await` AND top-level `return` are both legal. Checking it as a
 * bare ES module would report a false error on every `return`.
 *
 * Returns null when it parses, else the error message.
 */
function parseError(src) {
  const wrapped =
    "async function __wf(agent, parallel, pipeline, phase, log, workflow, args, budget) {\n" +
    src.replace(/^export\s+const\s+meta\s*=/m, "const meta =") +
    "\n}\n";
  try {
    new Function(wrapped);
    return null;
  } catch (e) {
    return e.message;
  }
}

/** Isolate the `export const meta = { ... }` literal source, or null. */
function extractMetaSource(src) {
  const m = src.match(/^export\s+const\s+meta\s*=\s*(\{[\s\S]*?\n\})\s*$/m);
  return m ? m[1] : null;
}

/**
 * Validate the meta block. Returns { ok, problems: string[], meta? }.
 * Claude Code drops `/<name>` from autocomplete when meta is not a pure
 * literal, so a non-literal meta is a silent loss of the command.
 */
function checkMeta(src) {
  const problems = [];
  const metaSrc = extractMetaSource(src);
  if (!metaSrc) return { ok: false, problems: ["no isolatable `export const meta = {...}` literal"] };
  if (/\$\{/.test(metaSrc)) problems.push("template interpolation inside meta");
  if (/\.\.\./.test(metaSrc)) problems.push("spread inside meta");

  let meta;
  try {
    meta = new Function("return (" + metaSrc + ")")();
  } catch (e) {
    problems.push("meta is not evaluable as a literal: " + e.message);
    return { ok: false, problems };
  }
  if (typeof meta.name !== "string" || !meta.name) problems.push("meta.name must be a non-empty string");
  if (typeof meta.description !== "string" || !meta.description) {
    problems.push("meta.description must be a non-empty string");
  }
  return { ok: problems.length === 0, problems, meta };
}

/**
 * Cross-check `phase()` calls against `meta.phases`.
 * Returns { calls, declared, undeclared, uncalled }.
 * Reads calls from stripped code so a phase name inside a comment is not
 * mistaken for a call.
 */
function checkPhases(src) {
  const { meta } = checkMeta(src);
  const declared = ((meta && meta.phases) || []).map(p => p.title);
  const calls = [...stripComments(src).matchAll(/\bphase\(\s*['"]([^'"]+)['"]\s*\)/g)].map(m => m[1]);
  return {
    calls,
    declared,
    undeclared: calls.filter(c => !declared.includes(c)),
    uncalled: declared.filter(d => !calls.includes(d)),
  };
}

/**
 * The shrinking-N check. `agent()` returns null when the operator skips it or
 * it dies terminally; dropping those hands the driver a SHORTER candidate list
 * than the daemon allocated slots for, which changes N — and N decides whether
 * the second Borda lane is mandatory. So a fan-out must MAP nulls to a status,
 * never filter them away.
 *
 * Banned outright rather than for one variable name: an earlier version matched
 * `settled.filter(Boolean)` and a falsification run evaded it by renaming the
 * variable to `settled0`. The check was coupled to an identifier instead of to
 * the behaviour.
 *
 * Returns { filtersBoolean, mapsCandidates }.
 */
function checkNullHandling(code) {
  return {
    filtersBoolean: /\.\s*filter\s*\(\s*Boolean\s*\)/.test(code),
    mapsCandidates: /candidates\.map\(\s*\(?\s*cand/.test(code),
  };
}

/**
 * Fields the `engineer` agent's Path A step 7 promises to return, derived from
 * `.claude/agents/engineer.md` rather than transcribed, so the two cannot
 * drift apart silently. Returns a string[]; throws if the contract line moved,
 * because reading nothing would make the subset check below vacuous.
 */
function engineerReturnContract(engineerMdPath) {
  const line = readFileSync(engineerMdPath, "utf8")
    .split("\n")
    .find(l => /\*\*Return\*\*\s+to the parent/.test(l));
  if (!line) {
    throw new Error(
      "could not find engineer.md's `**Return** to the parent:` line — if that contract moved, repoint " +
        "this derivation rather than deleting the assertion that depends on it",
    );
  }
  const brace = line.match(/\{([^}]*)\}/);
  if (!brace) throw new Error("the Return line carries no { ... } field list");
  return brace[1]
    .split(",")
    .map(f => f.replace(/[`\s?]/g, ""))
    .filter(Boolean);
}

/** The `required` array of the script's result schema. */
function schemaRequired(code) {
  const m = code.match(/required:\s*\[([^\]]*)\]/);
  if (!m) return null;
  return [...m[1].matchAll(/['"]([^'"]+)['"]/g)].map(x => x[1]);
}

function listScripts() {
  if (!existsSync(WORKFLOW_DIR)) return [];
  return readdirSync(WORKFLOW_DIR)
    .filter(f => f.endsWith(".js"))
    .map(f => ({ name: f, path: join(WORKFLOW_DIR, f) }));
}

const SCRIPTS = listScripts();

// A minimal script that must stay CLEAN through every check — the contrast
// baseline. If a check fires on this, the check is wrong.
const CLEAN_FIXTURE = [
  "export const meta = {",
  "  name: 'x',",
  "  description: 'y',",
  "  phases: [{ title: 'Go' }],",
  "}",
  "// Math.random() throws here, so vary by index instead.",
  "/* Date.now() is unavailable too — pass a timestamp via args. */",
  "const url = 'https://example.com/a//b'",
  "phase('Go')",
  "const settled = await parallel(items.map(x => () => agent('hi')))",
  "const rows = candidates.map((cand, i) => settled[i] || { status: 'infra_error' })",
  "return { rows, url }",
].join("\n");

// ═══════════════════════════════════════════════════════════════════════════

describe("workflow-scripts (Phase K, GitHub #52)", () => {
  // ── Non-vacuity gate ────────────────────────────────────────────────────
  test("the workflow directory exists and holds at least one .js script (non-vacuity)", () => {
    assert.ok(
      existsSync(WORKFLOW_DIR),
      `${WORKFLOW_DIR} does not exist — Phase K (#52) added it; if it was removed, remove this suite too`,
    );
    assert.ok(
      SCRIPTS.length > 0,
      `no .js files in ${WORKFLOW_DIR} — every per-file assertion below would pass by iterating nothing`,
    );
  });

  test("the Phase K deliverable is present under its scope-legible name", () => {
    const names = SCRIPTS.map(s => s.name);
    assert.ok(
      names.includes("pp-best-of-fanout.js"),
      `expected pp-best-of-fanout.js among [${names.join(", ")}]. The name carries meaning: a saved ` +
        `workflow becomes a slash command, so a bare "pp-best-of" would sit one character from ` +
        `/pp:best-of in autocomplete while running only the fan-out — no judging, no Borda, no winner.`,
    );
  });

  for (const script of SCRIPTS) {
    const src = readFileSync(script.path, "utf8");
    const code = stripComments(src);

    test(`${script.name}: parses as a workflow body (async wrapper, top-level await + return)`, () => {
      assert.equal(parseError(src), null, `${script.name} has a syntax error: ${parseError(src)}`);
    });

    test(`${script.name}: comment stripper kept the code and dropped only comments (non-vacuity)`, () => {
      const dense = s => s.replace(/\s/g, "").length;
      assert.ok(
        dense(code) > 0.15 * dense(src),
        `stripComments removed >85% of ${script.name}; the stripper is broken, which would make every ` +
          `banned-construct assertion below pass against an empty string`,
      );
      assert.match(
        code,
        /\bawait\s+(parallel|pipeline|agent)\s*\(/,
        `no await parallel/pipeline/agent survived stripping in ${script.name} — either the script ` +
          `orchestrates nothing, or the stripper ate real code`,
      );
    });

    test(`${script.name}: meta is a pure literal with name and description`, () => {
      const { ok, problems } = checkMeta(src);
      assert.ok(ok, `${script.name}: ${problems.join("; ")}`);
    });

    test(`${script.name}: every phase() title matches a meta.phases entry, and vice versa`, () => {
      const { calls, declared, undeclared, uncalled } = checkPhases(src);
      assert.deepEqual(
        undeclared,
        [],
        `${script.name}: phase(${JSON.stringify(undeclared)}) has no matching meta.phases entry, so it ` +
          `silently gets its own progress group. Declared: [${declared.join(", ")}]`,
      );
      assert.deepEqual(
        uncalled,
        [],
        `${script.name}: meta.phases declares ${JSON.stringify(uncalled)} but no phase() call uses it — ` +
          `a phase box that never fills. Calls: [${calls.join(", ")}]`,
      );
      // Zero-trip guard: with no declarations AND no calls both loops above
      // are empty and this test would pass having checked nothing. Every
      // script in this repo groups its agents, so that is a defect, not a
      // style choice.
      assert.ok(
        calls.length > 0,
        `${script.name} calls phase() zero times, so the phase cross-check verified nothing. Group the ` +
          `agents under at least one phase, or delete this assertion deliberately rather than letting ` +
          `it pass vacuously.`,
      );
    });

    test(`${script.name}: contains no construct the workflow runtime rejects`, () => {
      assert.deepEqual(bannedConstructs(code), [], `${script.name} contains banned construct(s)`);
    });

    test(`${script.name}: no TypeScript syntax (scripts are plain JavaScript)`, () => {
      assert.deepEqual(tsSmells(code), [], `${script.name} appears to contain TypeScript syntax`);
    });
  }

  // ── The scope invariant this phase exists to protect ────────────────────
  describe("pp-best-of-fanout: the step-6 boundary", () => {
    const path = join(WORKFLOW_DIR, "pp-best-of-fanout.js");
    const present = existsSync(path);
    const src = present ? readFileSync(path, "utf8") : "";
    const code = present ? stripComments(src) : "";

    test("it dispatches the typed `engineer` agent, not a generic one", () => {
      assert.ok(present, "pp-best-of-fanout.js missing");
      assert.match(
        code,
        /agentType:\s*['"]engineer['"]/,
        "the fan-out must dispatch agentType: 'engineer'. That typed agent owns the worktree commit, the " +
          "runtime smoke test and the mandatory self-verification step; a generic agent satisfies none " +
          "of those contracts.",
      );
    });

    test("it does NOT request its own worktree isolation", () => {
      assert.ok(present, "pp-best-of-fanout.js missing");
      assert.doesNotMatch(
        code,
        /isolation:\s*['"]worktree['"]/,
        "isolation: 'worktree' would put each engineer in a workflow-created worktree instead of the " +
          "daemon's candidate worktree. archive_winner_and_losers merges the daemon's branch, so the run " +
          "would finish with an empty winner.diff and no visible cause.",
      );
    });

    test("it does not reach into the driver's steps 6.5 through 10", () => {
      assert.ok(present, "pp-best-of-fanout.js missing");
      assert.deepEqual(
        forbiddenToolRefs(code),
        [],
        "pp-best-of-fanout.js references tools belonging to the driver/daemon past step 6. Absorbing " +
          "later steps changes winner selection — that is the finding this phase is built on.",
      );
    });

    test("null agent results become explicit infra_error rows rather than being filtered away", () => {
      assert.ok(present, "pp-best-of-fanout.js missing");
      const { filtersBoolean, mapsCandidates } = checkNullHandling(code);
      assert.match(code, /infra_error/, "a null agent result must map to smoke_status 'infra_error'");
      assert.ok(
        !filtersBoolean,
        "pp-best-of-fanout.js uses .filter(Boolean) on agent results. That silently shrinks N: the " +
          "daemon allocated a slot per candidate, and Borda over a shortened field elects a different " +
          "winner with no error anywhere. Map nulls to infra_error instead.",
      );
      assert.ok(
        mapsCandidates,
        "the result rows must be built by mapping over the daemon's `candidates` array, so the returned " +
          "length is structurally N rather than however many agents happened to succeed",
      );
    });

    test("the result schema's `required` is a subset of engineer.md's documented return contract", () => {
      assert.ok(present, "pp-best-of-fanout.js missing");

      // WHY THIS EXISTS. `schema` forces the subagent to emit a validated
      // object. If `required` demands a field the typed agent's contract does
      // not promise, validation fails and `agent()` returns null — which this
      // script (correctly) converts into an infra_error dispatch failure. The
      // result: every candidate "fails to dispatch", N collapses, and the only
      // evidence is a schema nobody re-reads. A cross-vendor judge caught
      // exactly that on the first review of this file (`committed` was
      // required and is not in the contract).
      const required = schemaRequired(code);
      assert.ok(required, "could not find the schema's `required` array");
      assert.ok(required.length > 0, "the schema declares no required fields — assertion would be vacuous");

      const engineerMd = join(REPO_ROOT, ".claude", "agents", "engineer.md");
      assert.ok(existsSync(engineerMd), `${engineerMd} not found`);
      const promised = engineerReturnContract(engineerMd);
      assert.ok(
        promised.length >= 5,
        `parsed only ${promised.length} fields from engineer.md's return contract — the parse is wrong, ` +
          `and a short list would make the subset check pass too easily`,
      );

      const over = required.filter(f => !promised.includes(f));
      assert.deepEqual(
        over,
        [],
        `pp-best-of-fanout.js requires ${JSON.stringify(over)}, which engineer.md's Path A step 7 does ` +
          `not promise (it promises: ${promised.join(", ")}). An over-demanding schema fails validation, ` +
          `and a failed validation returns null — turning every candidate into a dispatch failure.`,
      );
    });

    test("it returns a smoke_summary keyed for the driver's step 6.5", () => {
      assert.ok(present, "pp-best-of-fanout.js missing");
      assert.match(code, /smoke_summary/, "step 6.5 reads smoke_summary; the fan-out must return one");
      assert.match(
        code,
        /next_driver_step/,
        "the return value should name the driver step that resumes, so the boundary is data rather than " +
          "folklore",
      );
    });
  });

  // ═════════════════════════════════════════════════════════════════════════
  // FALSIFICATION — every fixture goes through the SAME functions the real
  // tests use. If a check above were deleted, the matching fixture here would
  // fail too. That is the property the first version of this file lacked.
  // ═════════════════════════════════════════════════════════════════════════
  describe("falsification", () => {
    test("the clean fixture passes EVERY check (the contrast baseline)", () => {
      // If any check fires here, that check is wrong — not the fixture. This
      // is what makes the negative fixtures below meaningful rather than
      // trivially satisfiable.
      assert.equal(parseError(CLEAN_FIXTURE), null, "the clean fixture must parse");
      const clean = stripComments(CLEAN_FIXTURE);
      assert.deepEqual(bannedConstructs(clean), [], "no banned construct in the clean fixture");
      assert.deepEqual(tsSmells(clean), [], "no TS smell in the clean fixture");
      assert.deepEqual(forbiddenToolRefs(clean), [], "no forbidden tool in the clean fixture");
      const { ok, problems } = checkMeta(CLEAN_FIXTURE);
      assert.ok(ok, `clean meta rejected: ${problems.join("; ")}`);
      const ph = checkPhases(CLEAN_FIXTURE);
      assert.deepEqual(ph.undeclared, [], "clean fixture has no undeclared phase");
      assert.deepEqual(ph.uncalled, [], "clean fixture has no uncalled phase");
      const nh = checkNullHandling(clean);
      assert.ok(!nh.filtersBoolean, "clean fixture does not filter(Boolean)");
      assert.ok(nh.mapsCandidates, "clean fixture maps candidates");
    });

    test("a syntax error is caught by parseError", () => {
      assert.notEqual(parseError("export const meta = { name: 'x' }\nconst a = (\n"), null);
    });

    test("a legitimate top-level await AND return parses (no false positive)", () => {
      const err = parseError("export const meta = { name: 'x', description: 'y' }\nconst r = await agent('h')\nreturn { r }\n");
      assert.equal(err, null, `a legitimate workflow body must parse, got: ${err}`);
    });

    test("EVERY banned construct is caught by bannedConstructs, one fixture each", () => {
      // Includes the top-level import/export entry, which the first version of
      // this suite left without a reachability fixture.
      const cases = [
        ["Date.now()", "const t = Date.now()"],
        ["Math.random()", "const r = Math.random()"],
        ["new Date()", "const d = new Date()"],
        ["import()", "const m = await import('fs')"],
        ["require()", "const fs = require('fs')"],
        ["top-level import/export", "import { x } from 'y'"],
      ];
      const covered = new Set();
      for (const [label, line] of cases) {
        const hits = bannedConstructs(stripComments(`export const meta = { name: 'x' }\n${line}\n`));
        assert.ok(hits.includes(label), `${label} was NOT caught; hits were [${hits.join(", ")}]`);
        covered.add(label);
      }
      // No silent gaps: every BANNED entry must have a fixture.
      const missing = BANNED.map(([n]) => n).filter(n => !covered.has(n));
      assert.deepEqual(missing, [], `BANNED entries with no falsification fixture: ${missing.join(", ")}`);
    });

    test("EVERY TypeScript smell is caught by tsSmells, one fixture each", () => {
      const cases = [
        ["type annotation", "function f(a: string) {}"],
        ["interface declaration", "interface Foo {\n  a: 1\n}"],
        ["as-assertion", "const x = y as string"],
        ["enum declaration", "enum Color {\n  Red\n}"],
      ];
      const covered = new Set();
      for (const [label, line] of cases) {
        const hits = tsSmells(stripComments(line));
        assert.ok(hits.includes(label), `${label} was NOT caught; hits were [${hits.join(", ")}]`);
        covered.add(label);
      }
      const missing = TS_SMELLS.map(([n]) => n).filter(n => !covered.has(n));
      assert.deepEqual(missing, [], `TS_SMELLS entries with no fixture: ${missing.join(", ")}`);
    });

    test("EVERY forbidden driver tool is caught by forbiddenToolRefs", () => {
      // The boundary assertion is an absence check; this proves the condition
      // is reachable for each tool rather than for one representative.
      for (const tool of FORBIDDEN_TOOLS) {
        const hits = forbiddenToolRefs(`await mcp__pp_harness__${tool}({})`);
        assert.deepEqual(hits, [tool], `${tool} was not detected as a boundary violation`);
      }
    });

    test("a non-literal meta is caught by checkMeta", () => {
      const r = checkMeta("export const meta = {\n  name: NAME,\n  description: 'y',\n}\n");
      assert.ok(!r.ok, "a meta referencing an undeclared identifier must be rejected");
      assert.ok(
        r.problems.some(p => /not evaluable/.test(p)),
        `expected an evaluability problem, got: ${r.problems.join("; ")}`,
      );
    });

    test("a spread inside meta is caught by checkMeta", () => {
      const r = checkMeta("export const meta = {\n  ...base,\n  name: 'x',\n  description: 'y',\n}\n");
      assert.ok(!r.ok, "a spread must be rejected");
      assert.ok(r.problems.some(p => /spread/.test(p)), `got: ${r.problems.join("; ")}`);
    });

    test("template interpolation inside meta is caught by checkMeta", () => {
      // This absence-assertion had no reachability fixture before.
      const r = checkMeta("export const meta = {\n  name: `x${1}`,\n  description: 'y',\n}\n");
      assert.ok(!r.ok, "template interpolation must be rejected");
      assert.ok(r.problems.some(p => /interpolation/.test(p)), `got: ${r.problems.join("; ")}`);
    });

    test("a missing meta.description is caught by checkMeta", () => {
      const r = checkMeta("export const meta = {\n  name: 'x',\n}\n");
      assert.ok(!r.ok, "a meta without a description must be rejected");
    });

    test("a phase()/meta.phases mismatch is caught by checkPhases in BOTH directions", () => {
      // Runs the real checkPhases over real fixture source — not an inline
      // array comparison, which is what the first version of this test did and
      // which tested Array.prototype.includes rather than the guard.
      const undeclaredCase =
        "export const meta = {\n  name: 'x',\n  description: 'y',\n  phases: [{ title: 'Alpha' }],\n}\n" +
        "phase('Beta')\nconst r = await agent('h')\nreturn r\n";
      const a = checkPhases(undeclaredCase);
      assert.deepEqual(a.undeclared, ["Beta"], "an undeclared phase() call must be reported");
      assert.deepEqual(a.uncalled, ["Alpha"], "a declared-but-uncalled phase must be reported");

      const matchedCase =
        "export const meta = {\n  name: 'x',\n  description: 'y',\n  phases: [{ title: 'Alpha' }],\n}\n" +
        "phase('Alpha')\nconst r = await agent('h')\nreturn r\n";
      const b = checkPhases(matchedCase);
      assert.deepEqual(b.undeclared, [], "a matching pair must not be reported");
      assert.deepEqual(b.uncalled, [], "a matching pair must not be reported");
    });

    test("a phase name that appears ONLY in a comment is not counted as a call", () => {
      const src =
        "export const meta = {\n  name: 'x',\n  description: 'y',\n  phases: [{ title: 'Alpha' }],\n}\n" +
        "// phase('Ghost') is described here but never called\nphase('Alpha')\nawait agent('h')\n";
      const r = checkPhases(src);
      assert.deepEqual(r.calls, ["Alpha"], `a commented phase() must not count; got ${r.calls.join(",")}`);
    });

    test(".filter(Boolean) is caught by checkNullHandling under ANY variable name", () => {
      // Pins a real regression: the first version of the real check matched
      // `settled.filter(Boolean)` by name, and a falsification pass against
      // the live script evaded it by renaming the variable to `settled0`.
      for (const name of ["settled", "settled0", "raw", "outcomes"]) {
        const r = checkNullHandling(`const ${name} = await parallel(x)\nconst r = ${name}.filter(Boolean)\n`);
        assert.ok(r.filtersBoolean, `the shrinking-N pattern must be caught when the variable is ${name}`);
      }
      const good = checkNullHandling(
        "const settled = await parallel(x)\nconst r = candidates.map((cand, i) => settled[i] || fb(i))\n",
      );
      assert.ok(!good.filtersBoolean, "the correct null-mapping pattern must NOT be flagged");
      assert.ok(good.mapsCandidates, "the positive form must be detected");
    });

    test("a results array NOT keyed off candidates is caught by checkNullHandling", () => {
      const r = checkNullHandling("const rows = settled.map((v, i) => v || fb(i))\n");
      assert.ok(!r.mapsCandidates, "mapping over the agent results rather than the daemon's candidates " +
        "must fail the positive check — that is how N shrinks without a filter()");
    });

    test("isolation: 'worktree' is caught by the same pattern the real check uses", () => {
      const re = /isolation:\s*['"]worktree['"]/;
      assert.ok(re.test(stripComments("agent(p, { isolation: 'worktree' })")), "must detect the flag");
      assert.ok(
        !re.test(stripComments("// deliberately not isolation: 'worktree', see above\nagent(p, {})")),
        "a comment explaining why the flag is absent must not be flagged",
      );
    });

    test("an over-demanding schema `required` is caught against the real contract", () => {
      const engineerMd = join(REPO_ROOT, ".claude", "agents", "engineer.md");
      const promised = engineerReturnContract(engineerMd);
      const over = ["candidate_index", "committed"].filter(f => !promised.includes(f));
      assert.deepEqual(
        over,
        ["committed"],
        `expected 'committed' to be absent from the engineer contract and 'candidate_index' present; ` +
          `contract is: ${promised.join(", ")}`,
      );
      assert.ok(
        schemaRequired("required: ['a', 'b']").length === 2,
        "schemaRequired must parse a required array",
      );
      assert.equal(schemaRequired("no schema here"), null, "schemaRequired must report absence as null");
    });

    // ── The stripper's own two bypasses, both found by a cross-vendor judge ──

    test("STRIPPER BYPASS 1 (closed): a banned call cannot hide behind a // inside a string", () => {
      // The naive line-regex found the `//` inside the string literal and
      // erased the rest of the line, taking Date.now() with it. A guard that
      // can be silenced by a string literal reports green while being blind.
      const src = 'const separator = "//"; const leaked = Date.now();\n';
      const hits = bannedConstructs(stripComments(src));
      assert.ok(
        hits.includes("Date.now()"),
        "Date.now() hidden after a string containing // must still be caught; the stripper must respect " +
          "string literals",
      );
    });

    test("STRIPPER BYPASS 2 (closed): a comment preceded by a colon is still stripped", () => {
      // The old `[^:]` lookbehind (there to protect `https://`) meant a
      // colon-prefixed comment was never stripped, so documentation about a
      // banned construct was reported as code.
      const src = "const o = { check:// Math.random() is documented here\n  a: 1 }\n";
      const hits = bannedConstructs(stripComments(src));
      assert.deepEqual(
        hits,
        [],
        "a comment after a colon must be stripped, not flagged as a Math.random() call",
      );
    });

    test("the stripper still keeps a URL that lives inside a string", () => {
      // The reason the `[^:]` hack existed. Handled structurally now: a URL in
      // code is inside a string; a URL in prose is inside a comment.
      const out = stripComments("const u = 'https://example.com//x'\nconst v = 1\n");
      assert.match(out, /https:\/\/example\.com\/\/x/, "a URL inside a string must survive stripping");
      assert.match(out, /const v = 1/, "code after the URL line must survive");
    });

    test("the stripper removes block comments but preserves line structure", () => {
      const out = stripComments("const a = 1\n/* Date.now()\n   Math.random() */\nconst b = 2\n");
      assert.deepEqual(bannedConstructs(out), [], "block-comment mentions must not be flagged");
      assert.match(out, /const a = 1/);
      assert.match(out, /const b = 2/);
      assert.equal(
        out.split("\n").length,
        "const a = 1\n/* Date.now()\n   Math.random() */\nconst b = 2\n".split("\n").length,
        "line count must be preserved so /m-anchored patterns stay meaningful",
      );
    });

    test("the stripper does not swallow escaped quotes", () => {
      const out = stripComments('const s = "a\\"// not a comment"; const t = Date.now();\n');
      assert.ok(
        bannedConstructs(out).includes("Date.now()"),
        "an escaped quote must not desynchronize the string tracker and hide following code",
      );
    });

    test("the non-vacuity density guard rejects an over-eager stripper", () => {
      const original = "const a = await parallel([])\nreturn a\n";
      const overStripped = " ";
      const dense = s => s.replace(/\s/g, "").length;
      assert.ok(!(dense(overStripped) > 0.15 * dense(original)), "the density guard must reject it");
      assert.doesNotMatch(overStripped, /\bawait\s+(parallel|pipeline|agent)\s*\(/);
    });

    test("engineerReturnContract throws loudly rather than returning an empty list", () => {
      // Reject-loud: a moved contract line must fail the suite, not silently
      // produce an empty `promised` array that makes the subset check pass.
      // Must be a file that EXISTS and simply lacks the contract line —
      // pointing at a missing path would throw ENOENT and prove nothing about
      // the reject-loud behaviour being asserted.
      const existingButWrong = join(REPO_ROOT, "AGENTS.md");
      assert.ok(existsSync(existingButWrong), "the fixture file must exist for this to test what it claims");
      assert.throws(
        () => engineerReturnContract(existingButWrong),
        /could not find engineer\.md's/,
        "a readable file with no Return contract line must throw, not return []",
      );
    });
  });
});
