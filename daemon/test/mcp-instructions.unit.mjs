// ─── daemon/test/mcp-instructions.unit.mjs ────────────────────────────────
//
// Phase B (GitHub #44) — guard test for:
//   B1: server-level `instructions` on pp_harness / pp_codex / pp_agy
//       (HARNESS_INSTRUCTIONS / CODEX_INSTRUCTIONS / AGY_INSTRUCTIONS).
//   B2: `_meta["anthropic/maxResultSizeChars"]` on EXACTLY `get_run`.
//   B3: this file, plus the committed fixture builder
//       daemon/test/fixtures/run-fixture.mjs.
//
// Spec: .harness/run_z4V5xI8SlOIp/spec.md (revision 3). Requirement ids
// (R1.x / R2.x / R3.x / AC-x / NG-x / F-x) below refer to that document.
//
// ANTI-STALL TEST RULE (AGENTS.md): self-contained. Temp SQLite (PP_HOME
// override), direct imports from dist/, no live daemon, no MCP peer, no
// network.
//
// RUNNER (revision 2, judge finding HIGH-2): every assertion group below is a
// REAL `node:test` subtest, registered via `test()`. The earlier revision
// hand-rolled its own it()/pass/fail counters inside a single node:test case
// and terminated with `process.exit()`. That had two defects: (a) the file
// reported "+1 test" to the suite total while actually carrying 43 assertion
// groups, so the counts lied; and (b) its only failure signal was buffered
// stdout, which `process.exit()` can truncate before flush — a real failure
// could exit non-zero with no attributable reason. Using the runner's own
// registration removes both: counts are honest, failures are reported and
// attributed by node:test itself, and no `process.exit()` is needed.
// Teardown (SQLite handle + temp dirs) is the last registered subtest, so a
// cleanup failure is a visible test failure rather than a swallowed catch.
//
// FOUR TRAPS THIS FILE DELIBERATELY AVOIDS (see spec + driver brief):
//   1. Content assertions run against the IMPORTED CONSTS from dist/, never
//      a source grep — comments in codex-server.ts / harness-server.ts
//      legitimately contain "resume a prior", "--resume", and "NOT a
//      documented platform limit" because their job is to explain why the
//      *string* must not say those things. A source grep would false-positive
//      on the honest comment. (AC-7 below is the one deliberate exception: it
//      DOES scan source text, and handles the honest negation with an
//      explicit named allowance rather than by weakening its regex.)
//   2. `_meta` is asserted on the WIRE projection (describeToolSurface(),
//      which mirrors the ListTools handler's own conditional), never on the
//      ToolDef descriptor alone — annotating ToolDef without patching the
//      handler would be a silent no-op (F-3/F-4/RK-8).
//   3. The import side-effect assertion targets the absence of `state.db`,
//      not the absence of `<PP_HOME>/.pair-programmer/` — importing DOES
//      create that directory (util/logger.ts's top-level `ensureDirs()`).
//      F-7 is only half true; see R1.3 below.
//   4. `PP_HOME` is set before the FIRST `dist/` import in this file (R3.2).
//      `DB_PATH` (util/paths.ts) is a module-level const resolved at import
//      time.
//
// UNITS (revision 2, judge finding MED-1). Two different budgets live in this
// file and they are deliberately in different units:
//   - R1.7's 2048 is a SELF-IMPOSED budget on the instructions strings, and
//     is expressed in UTF-8 BYTES (`Buffer.byteLength`), because what travels
//     the `initialize` response is bytes.
//   - `get_run`'s ceiling is named `anthropic/maxResultSizeChars` and the
//     platform counts CHARACTERS, so every assertion against it — the R2.7
//     derivation, the R3.10 fixture floor, the R3.7 positive case, the R3.11
//     negative case, and the R3.7a replay tripwire — is in CHARACTERS,
//     measured as `serialized.length` (UTF-16 code units, which is what
//     JavaScript reports as a string's character count).
// No conversion happens anywhere: nothing compares a byte figure against a
// char ceiling. `Buffer.byteLength(...) >= .length` for our content (the
// instruction strings and fixture prose contain em-dashes and arrows, which
// are multi-byte in UTF-8), so mixing the two — as revision 1 did at the
// R3.7 site — silently over-measured the payload against a char ceiling.
// Byte figures are still PRINTED as diagnostics; they are never asserted
// against the char ceiling.

import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import {
  mkdtempSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";

const SUITE_STARTED_AT = Date.now();

// ─── R3.2 — PP_HOME MUST be set before the first dist/ import ────────────
// This applies to BOTH test groups (declaration group and the hard-assertion
// group), because DB_PATH (daemon/src/util/paths.ts:8,11) is a module-level
// const resolved at import time. Setting it later is too late to protect
// the developer's real ~/.pair-programmer/state.db.
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = join(__dirname, "..", "..");
const DIST = join(__dirname, "..", "dist");
const CONSTITUTION_PATH = join(REPO_ROOT, "CONSTITUTION.md");

const PP_HOME = mkdtempSync(join(tmpdir(), "pp-mcp-instructions-"));
process.env.PP_HOME = PP_HOME;

// Runtime proof (not just a top-to-bottom read at review) that PP_HOME was
// pointed at an isolated temp dir before anything else happened.
if (!PP_HOME.toLowerCase().startsWith(tmpdir().toLowerCase())) {
  throw new Error(`R3.2 violation: PP_HOME (${PP_HOME}) does not resolve inside os.tmpdir() (${tmpdir()})`);
}

function importDist(relPath) {
  return import(pathToFileURL(join(DIST, relPath)).href);
}

const cleanupDirs = [PP_HOME];

// ═══════════════════════════════════════════════════════════════════════
// Group 1 — declaration assertions (no database work)
// ═══════════════════════════════════════════════════════════════════════

// This is the FIRST dist/ import in the file (R3.2).
const beforeImport = existsSync(join(PP_HOME, ".pair-programmer"));
const harnessMod = await importDist("mcp/harness-server.js");
const codexMod = await importDist("mcp/codex-server.js");
const agyMod = await importDist("mcp/antigravity-server.js");
const { scanForSecrets } = await importDist("security/secret-scan.js");
const { closeDb } = await importDist("db/database.js");

const HARNESS_INSTRUCTIONS = harnessMod.HARNESS_INSTRUCTIONS;
const CODEX_INSTRUCTIONS = codexMod.CODEX_INSTRUCTIONS;
const AGY_INSTRUCTIONS = agyMod.AGY_INSTRUCTIONS;
const describeHarnessSurface = harnessMod.describeToolSurface;
const describeCodexSurface = codexMod.describeToolSurface;
const describeAgySurface = agyMod.describeToolSurface;

// ─── R1.3 (corrected) — import side effects ───────────────────────────────
// F-7 is only half true: importing DOES create <PP_HOME>/.pair-programmer/
// (util/logger.ts's top-level ensureDirs()), which also mkdirs logs/ and
// sandboxes/ (util/paths.ts:17-21). What must NOT happen is any SQLite
// work — db() is lazy (daemon/src/db/database.ts:7-10) — so the correct
// assertion targets the absence of state.db (respecting a PP_DB_PATH
// override, which relocates state.db out of the ROOT_DIR tree per
// paths.ts:11), not the absence of the directory tree itself.
test("R1.3: import side effects — no state.db, nothing beyond the logger's dirs under PP_HOME", () => {
  assert.equal(beforeImport, false, "PP_HOME must have been empty before the first dist/ import");
  const rootEntries = readdirSync(PP_HOME).sort();
  assert.deepEqual(
    rootEntries, [".pair-programmer"],
    "importing the three MCP server modules must create nothing under PP_HOME except the logger's root dir",
  );
  const innerEntries = readdirSync(join(PP_HOME, ".pair-programmer")).sort();
  assert.deepEqual(
    innerEntries, ["logs", "sandboxes"],
    "the ONLY subdirectories created by import must be logs/ and sandboxes/ (ensureDirs); " +
      "in particular, no state.db, no prices.json, no daemon.lock",
  );
  const dbPath = process.env.PP_DB_PATH ?? join(PP_HOME, ".pair-programmer", "state.db");
  assert.ok(
    !existsSync(dbPath),
    "importing the MCP server modules must not open or create state.db",
  );
});

// ─── R1.1 / R1.2 — structural: the const is referenced, not duplicated ────
const SRC_FILES = {
  harness: join(REPO_ROOT, "daemon", "src", "mcp", "harness-server.ts"),
  codex: join(REPO_ROOT, "daemon", "src", "mcp", "codex-server.ts"),
  agy: join(REPO_ROOT, "daemon", "src", "mcp", "antigravity-server.ts"),
};
const SRC_TEXT = Object.fromEntries(
  Object.entries(SRC_FILES).map(([k, p]) => [k, readFileSync(p, "utf8")]),
);

test("R1.1/R1.2: each server's `new Server(...)` call references its exported instructions const, not a duplicated literal", () => {
  const checks = [
    ["harness", "HARNESS_INSTRUCTIONS"],
    ["codex", "CODEX_INSTRUCTIONS"],
    ["agy", "AGY_INSTRUCTIONS"],
  ];
  for (const [key, constName] of checks) {
    const src = SRC_TEXT[key];
    assert.match(src, new RegExp(`instructions:\\s*${constName}\\b`),
      `${key}: new Server(...) must pass instructions: ${constName}`);
    const declCount = (src.match(new RegExp(`export const ${constName}\\s*=`, "g")) ?? []).length;
    assert.equal(declCount, 1, `${key}: ${constName} must be declared exactly once`);
    assert.ok(
      !/instructions:\s*["'`]/.test(src),
      `${key}: the construction site must reference the const, not inline a string literal`,
    );
  }
});

// ─── R1.4 — the three strings are distinct ────────────────────────────────
test("R1.4: HARNESS_INSTRUCTIONS, CODEX_INSTRUCTIONS, AGY_INSTRUCTIONS are pairwise distinct", () => {
  assert.equal(new Set([HARNESS_INSTRUCTIONS, CODEX_INSTRUCTIONS, AGY_INSTRUCTIONS]).size, 3);
});

// ─── R1.1 (length) / R1.7 (byte budget) / R1.8 (diagnostic) ───────────────
const ALL_INSTRUCTIONS = [
  { label: "pp_harness", text: HARNESS_INSTRUCTIONS },
  { label: "pp_codex", text: CODEX_INSTRUCTIONS },
  { label: "pp_agy", text: AGY_INSTRUCTIONS },
];

test("R1.1: each instructions string has length >= 1", () => {
  for (const { label, text } of ALL_INSTRUCTIONS) {
    assert.ok(typeof text === "string" && text.length >= 1, `${label}: instructions must be non-empty`);
  }
});

// UNITS: R1.7's budget is deliberately in UTF-8 BYTES (what travels the
// `initialize` response), unlike get_run's char-denominated ceiling. The two
// are never compared to each other.
test("R1.7: each instructions string is <= 2048 bytes UTF-8", () => {
  for (const { label, text } of ALL_INSTRUCTIONS) {
    const n = Buffer.byteLength(text, "utf8");
    assert.ok(n <= 2048, `${label}: ${n} bytes exceeds the 2048-byte self-imposed budget (R1.7, U-1 — NOT a documented platform limit)`);
  }
});

test("R1.8: diagnostic (non-fatal) when a string exceeds 1600 bytes — logged, not asserted", () => {
  for (const { label, text } of ALL_INSTRUCTIONS) {
    const n = Buffer.byteLength(text, "utf8");
    if (n > 1600) {
      console.log(`  [R1.8 diagnostic] ${label}: ${n} bytes exceeds the 1600-byte SHOULD headroom target (non-fatal)`);
    }
  }
  // Deliberately no assert here — R1.8 is a SHOULD with a diagnostic, not a MUST.
});

// ─── R1.5 — no secret-shaped substrings, reusing enforce-no-secrets' own
//     pattern set (daemon/src/security/secret-scan.ts) so the two cannot drift.
test("R1.5: no instructions string matches the daemon's own secret-scan patterns", () => {
  for (const { label, text } of ALL_INSTRUCTIONS) {
    const matches = scanForSecrets(text);
    assert.equal(matches.length, 0, `${label}: matched secret-shaped pattern(s): ${matches.map(m => m.kind).join(", ")}`);
  }
});

// ─── R1.6 — instructions are static: byte-identical across two imports made
//     with different PP_DISABLE_AGY settings, in separate child processes ──
test("R1.6: instructions are byte-identical across PP_DISABLE_AGY=0 vs PP_DISABLE_AGY=1 (separate child processes)", async () => {
  const scratchDir = mkdtempSync(join(tmpdir(), "pp-mcp-instructions-r16-"));
  cleanupDirs.push(scratchDir);
  const childScriptPath = join(scratchDir, "read-instructions.mjs");
  writeFileSync(
    childScriptPath,
    [
      "import { pathToFileURL } from 'node:url';",
      "const h = await import(pathToFileURL(process.argv[2]).href);",
      "const c = await import(pathToFileURL(process.argv[3]).href);",
      "const a = await import(pathToFileURL(process.argv[4]).href);",
      "process.stdout.write(JSON.stringify({",
      "  h: h.HARNESS_INSTRUCTIONS, c: c.CODEX_INSTRUCTIONS, a: a.AGY_INSTRUCTIONS,",
      "}));",
    ].join("\n"),
    "utf8",
  );
  const harnessDistPath = join(DIST, "mcp", "harness-server.js");
  const codexDistPath = join(DIST, "mcp", "codex-server.js");
  const agyDistPath = join(DIST, "mcp", "antigravity-server.js");

  function runChild(disableAgyValue) {
    const childHome = mkdtempSync(join(tmpdir(), `pp-mcp-instructions-r16-home-${disableAgyValue}-`));
    cleanupDirs.push(childHome);
    const out = execFileSync(
      process.execPath,
      [childScriptPath, harnessDistPath, codexDistPath, agyDistPath],
      {
        env: { ...process.env, PP_HOME: childHome, PP_DISABLE_AGY: disableAgyValue },
        encoding: "utf8",
      },
    );
    return JSON.parse(out);
  }

  const withAgy = runChild("0");
  const withoutAgy = runChild("1");
  assert.deepEqual(withAgy, withoutAgy, "instructions must not vary with PP_DISABLE_AGY (R1.6: static, no runtime-state assembly)");
  assert.equal(withAgy.h, HARNESS_INSTRUCTIONS);
  assert.equal(withAgy.c, CODEX_INSTRUCTIONS);
  assert.equal(withAgy.a, AGY_INSTRUCTIONS);
});

// ─── §4.3.1 pp_harness required content (R1.11-R1.22, R1.30) ──────────────

test("R1.11: pp_harness instructions are navigational, not procedural — forbidden substrings absent, run.md present", () => {
  for (const forbidden of ["Step 1", "Step 2", "rubric_md", "missability"]) {
    assert.ok(!HARNESS_INSTRUCTIONS.includes(forbidden), `must not contain "${forbidden}"`);
  }
  assert.ok(HARNESS_INSTRUCTIONS.includes("run.md"), "must point at run.md rather than restating procedure");
});

function commaRunOfToolNames(text, toolNameSet) {
  const parts = text.split(",");
  let run = 0;
  for (const raw of parts) {
    const token = raw.trim().split(/\s+/).pop()?.replace(/[.:;)]+$/, "");
    if (token && toolNameSet.has(token)) {
      run++;
      if (run >= 4) return true;
    } else {
      run = 0;
    }
  }
  return false;
}

test("R1.12: no tool-total claim; no unbounded /\\d+ tools/ match; no 4+ comma-separated run of the surface's own tool names", () => {
  for (const { label, text } of ALL_INSTRUCTIONS) {
    assert.ok(!/\b\d{1,4}\s+tools\b/.test(text), `${label}: must not state a tool total`);
  }
  const harnessToolNames = new Set(describeHarnessSurface().map(t => t.name));
  assert.ok(
    !commaRunOfToolNames(HARNESS_INSTRUCTIONS, harnessToolNames),
    "pp_harness instructions must not enumerate 4+ tool names as a comma-separated run",
  );
});

test("R1.13: the six lifecycle entrypoints appear in the required relative order", () => {
  const order = ["start_run", "start_stage", "record_attempt", "record_verdict", "finalize_stage", "finalize_run"];
  let cursor = -1;
  for (const name of order) {
    const pos = HARNESS_INSTRUCTIONS.indexOf(name, cursor + 1);
    assert.ok(pos > cursor, `"${name}" must appear after the previous entrypoint in the chain (cursor=${cursor}, pos=${pos})`);
    cursor = pos;
  }
});

test("R1.14: gate_eligible_judges is named as the routing entrypoint and authoritative", () => {
  assert.ok(HARNESS_INSTRUCTIONS.includes("gate_eligible_judges"));
  assert.match(HARNESS_INSTRUCTIONS, /authoritative/i);
});

test("R1.15: cites JUDGE-1 + Article V, 'every gate', and embeds NO CONSTITUTION.md SHA", () => {
  assert.ok(HARNESS_INSTRUCTIONS.includes("JUDGE-1"));
  assert.ok(HARNESS_INSTRUCTIONS.includes("Article V"));
  assert.match(HARNESS_INSTRUCTIONS, /every gate/i);
  for (const forbidden of [/\b5df284cb\b/, /\b13b4fa18\b/, /\b2f40cda6\b/, /\bSHA\b/i, /CONSTITUTION\.md[^\n]{0,40}\b[0-9a-f]{8,40}\b/i]) {
    assert.ok(!forbidden.test(HARNESS_INSTRUCTIONS), `must not match ${forbidden}`);
  }
});

test("R1.16: same-vendor verdict is supplementary and can never close a stage (JUDGE-2)", () => {
  assert.ok(HARNESS_INSTRUCTIONS.includes("JUDGE-2"));
  assert.match(HARNESS_INSTRUCTIONS, /never close/i);
});

test("R1.17: JUDGE-1a override channels require judge_model_source + judge_override_reason, never inferred from prose", () => {
  assert.ok(HARNESS_INSTRUCTIONS.includes("JUDGE-1a"));
  assert.ok(HARNESS_INSTRUCTIONS.includes("judge_model_source"));
  assert.ok(HARNESS_INSTRUCTIONS.includes("judge_override_reason"));
  assert.match(HARNESS_INSTRUCTIONS, /never inferred/i);
});

test("R1.18: escalate and model are mutually exclusive (pp_harness)", () => {
  assert.match(HARNESS_INSTRUCTIONS, /mutually exclusive/i);
  assert.ok(HARNESS_INSTRUCTIONS.includes("escalate"));
  assert.ok(HARNESS_INSTRUCTIONS.includes("model"));
});

test("R1.19: tool-discovery / search instruction present", () => {
  assert.match(HARNESS_INSTRUCTIONS, /search/i);
});

test("R1.21: hook-adapter namespace carve-out is a pattern, not a name list", () => {
  assert.match(HARNESS_INSTRUCTIONS, /hook_/);
  assert.match(HARNESS_INSTRUCTIONS, /not (called |invoked )?(directly|by you)/i);
  const hookAdapterNames = describeHarnessSurface().map(t => t.name).filter(n => n.startsWith("hook_"));
  for (const name of hookAdapterNames) {
    assert.ok(!HARNESS_INSTRUCTIONS.includes(name), `must not spell out adapter name "${name}" in full`);
  }
});

// ─── AC-15 / R1.22 / F-13 — hook_ prefix reservation ──────────────────────
// Phase L (#53) registers ~26 hook_<event>_<name> adapters and flips this
// assertion to "every adapter begins with hook_". Until then, zero tools may
// use the prefix.
test("AC-15/R1.22: zero pp_harness tools begin with 'hook_' at this merge (Phase L / #53 flips this)", () => {
  const surface = describeHarnessSurface();
  const hookPrefixed = surface.filter(t => t.name.startsWith("hook_"));
  assert.deepEqual(hookPrefixed.map(t => t.name), [], "no tool may use the reserved hook_ prefix before Phase L (#53)");
});

// ─── R3.14 — no transcribed count literals: the tool total is derived at
//     test time from BOTH the runtime surface AND an independent source count,
//     never a hardcoded integer.
test("R3.14: pp_harness tool total is derived at test time (runtime surface length == independently-counted source occurrences)", () => {
  const runtimeCount = describeHarnessSurface().length;
  const src = SRC_TEXT.harness;
  const arrayStart = src.indexOf("const TOOLS: ToolDef[] = [");
  assert.ok(arrayStart !== -1, "could not locate the TOOLS array literal in source for an independent count");
  const closeMatch = /\r?\n\];\r?\n/.exec(src.slice(arrayStart));
  assert.ok(closeMatch, "could not locate the TOOLS array's closing `];` in source for an independent count");
  const declEnd = arrayStart + closeMatch.index;
  const arrayBody = src.slice(arrayStart, declEnd);
  const sourceCount = (arrayBody.match(/^\s{4}name:\s*"/gm) ?? []).length;
  assert.ok(runtimeCount > 0, "describeToolSurface() must return a non-empty array");
  assert.equal(runtimeCount, sourceCount, "runtime TOOLS.length must match an independently-counted source occurrence of top-level `name:` entries");
});

// ─── R1.30 — governance-citation drift guard ──────────────────────────────
// Extract identifiers BY REGEX over the strings themselves (never a
// hand-maintained list), and assert each appears verbatim in the live
// CONSTITUTION.md, read from the repo root (never from PP_HOME).
function extractGovernanceIdentifiers(text) {
  const ids = new Set();
  for (const m of text.matchAll(/JUDGE-\d+[a-z]?/g)) ids.add(m[0]);
  for (const m of text.matchAll(/Article [IVXLCDM]+/g)) ids.add(m[0]);
  return ids;
}
function assertGovernanceAnchorsPresent(identifiers, constitutionText) {
  for (const id of identifiers) {
    if (!constitutionText.includes(id)) {
      throw new Error(
        `R1.30 governance-citation drift guard: identifier "${id}" is cited in an MCP instructions ` +
          `string but does NOT appear verbatim in CONSTITUTION.md. Re-read the amended article — this ` +
          `is not a literal to bump.`,
      );
    }
  }
}

const CONSTITUTION_TEXT = readFileSync(CONSTITUTION_PATH, "utf8");
const CITED_IDENTIFIERS = extractGovernanceIdentifiers(
  [HARNESS_INSTRUCTIONS, CODEX_INSTRUCTIONS, AGY_INSTRUCTIONS].join("\n"),
);

test("R1.30: at minimum JUDGE-1, JUDGE-1a, JUDGE-2, Article V are extracted from the instructions strings", () => {
  for (const required of ["JUDGE-1", "JUDGE-1a", "JUDGE-2", "Article V"]) {
    assert.ok(CITED_IDENTIFIERS.has(required), `expected to extract "${required}" from the instructions strings`);
  }
});

test("R1.30: every extracted governance identifier exists verbatim in the live CONSTITUTION.md", () => {
  assert.doesNotThrow(() => assertGovernanceAnchorsPresent(CITED_IDENTIFIERS, CONSTITUTION_TEXT));
});

test("R1.30 negative test: a fixture CONSTITUTION.md with JUDGE-2 renamed makes the guard fail, naming JUDGE-2", () => {
  // Renaming to text that does NOT contain "JUDGE-2" as a substring (unlike
  // e.g. "JUDGE-2-RENAMED", which would still satisfy `.includes("JUDGE-2")`
  // and make this negative test vacuous).
  const mutatedConstitution = CONSTITUTION_TEXT.replace(/JUDGE-2\b/g, "JUDGE-TWO-RENAMED");
  assert.ok(!mutatedConstitution.includes("JUDGE-2"),
    "sanity: mutation must actually remove the literal JUDGE-2 anchor as a substring");
  assert.throws(
    () => assertGovernanceAnchorsPresent(CITED_IDENTIFIERS, mutatedConstitution),
    /JUDGE-2/,
    "renaming JUDGE-2 in the (fixture) CONSTITUTION.md must make the drift guard fail, naming JUDGE-2",
  );
});

// ─── §4.5 pp_codex / pp_agy bridge content (R1.24-R1.29, R1.31) ───────────

const BRIDGES = [
  { label: "pp_codex", text: CODEX_INSTRUCTIONS },
  { label: "pp_agy", text: AGY_INSTRUCTIONS },
];

test("R1.24: both bridges state generate is deprecated and must not be used for stage generation", () => {
  for (const { label, text } of BRIDGES) {
    assert.match(text, /deprecat/i, `${label}: must match /deprecat/i`);
    assert.ok(text.includes("generate"), `${label}: must mention generate`);
  }
});

test("R1.25: both bridges state model/escalate mutual exclusivity, override_reason, never silently replaced", () => {
  for (const { label, text } of BRIDGES) {
    assert.match(text, /mutually exclusive/i, `${label}`);
    assert.ok(text.includes("override_reason"), `${label}: must mention override_reason`);
    assert.match(text, /never silently replaced/i, `${label}`);
  }
});

test("R1.26: both bridges state a bridge error is never a verdict", () => {
  for (const { label, text } of BRIDGES) {
    assert.match(text, /never a verdict/i, `${label}`);
  }
});

test("R1.27: AGY_INSTRUCTIONS asserts fresh-conversation isolation and model_reported_by_cli", () => {
  assert.match(AGY_INSTRUCTIONS, /fresh conversation/i);
  assert.ok(AGY_INSTRUCTIONS.includes("model_reported_by_cli"));
});

test("R1.28: CODEX_INSTRUCTIONS carries the caller-actionable 'every call' directive and never claims statelessness / describes resume", () => {
  assert.match(CODEX_INSTRUCTIONS, /every call/i);
  for (const forbidden of [/stateless/i, /independent critique/i, /resumes?\s+(a\s+)?(prior|previous)/i, /--resume/, /--continue/]) {
    assert.ok(!forbidden.test(CODEX_INSTRUCTIONS), `CODEX_INSTRUCTIONS must not match ${forbidden}`);
  }
});

test("R1.31: AGY_INSTRUCTIONS' annotation site names commit 6206f19 as the provenance of the isolation claim", () => {
  const idx = SRC_TEXT.agy.indexOf("export const AGY_INSTRUCTIONS");
  assert.ok(idx !== -1, "could not locate AGY_INSTRUCTIONS declaration in source");
  const precedingComment = SRC_TEXT.agy.slice(Math.max(0, idx - 1200), idx);
  assert.match(precedingComment, /6206f19/, "the code comment above AGY_INSTRUCTIONS must name commit 6206f19");
});

// ─── AC-7 — "documented limit" laundering guard ────────────────────────────
//
// REVISION 2 (judge finding HIGH-1). Revision 1 used the regex
// /documented (truncation )?limit/gi. The phrase actually written in the
// production comments is "NOT a documented PLATFORM limit"
// (harness-server.ts:576-577, codex-server.ts:671), so that regex matched
// ZERO bytes in all four scanned files: it passed because it missed, not
// because anything was exempt. Revision 1's comment also claimed
// codex-server.ts was exempt while the scan list included it — code and
// comment disagreed.
//
// The fix, deliberately chosen over "narrow the regex until it misses the
// negation":
//   (1) BROADEN the regex to the family of phrasings a laundering claim would
//       actually use — `documented [platform|truncation] limit`.
//   (2) Add ONE explicit, named allowance — HONEST_NEGATION — for the
//       negated form ("NOT a documented ... limit"), the same shape of
//       named-allowance escape hatch this campaign already uses for
//       PENDING_WIRING. The allowance keys on the NEGATION, not on the
//       filename, so it cannot be widened into a blanket file exemption.
//   (3) Assert the regex matched at least one occurrence somewhere in the
//       scanned corpus (ALLOWED or not). This is the anti-vacuity tripwire:
//       if the production phrasing is reworded and the regex stops matching,
//       THIS assertion goes red instead of the guard silently becoming a
//       no-op again. That is the specific failure mode of revision 1.
// Every scanned file is scanned with no file-level exemption; the only
// exclusion is this test file's own prose, which must spell out the forbidden
// phrase in order to test for it (the same reason the production
// guard-test-author comments spell it out).
//
// The proximity window is 400 chars, not 200: the honest negations live in a
// comment block above a `export const *_INSTRUCTIONS` declaration, and 400
// chars is what it takes to actually reach that declaration from the middle
// of the block. A wider window means MORE prose is subject to the rule, so
// this is a strengthening — and it is what makes the allowance load-bearing
// for both production files rather than only for codex-server.ts.
const DOC_LIMIT_RE = /documented\s+(?:platform\s+|truncation\s+)?limit/gi;
const HONEST_NEGATION_RE = /\bnot\s+a\s+$/i;
const DOC_LIMIT_PROXIMITY_CHARS = 400;

/**
 * Flatten comment scaffolding BEFORE matching, so a claim is detected even
 * when the phrase is wrapped across two comment lines. This is not cosmetic:
 * the honest negation in codex-server.ts is written as
 *   "(U-1, not a documented platform\n// limit)."
 * and a regex applied to the raw text cannot match across the `// `, so the
 * first attempt at this fix STILL let a mutated laundering claim through
 * (verified by mutation — see the report for this stage). Collapsing
 * newline + leading `//`/`*` + indentation into a single space makes the
 * regex, the HONEST_NEGATION lookback, and the proximity window all operate
 * on one flat line of prose. All offsets below are therefore in NORMALIZED
 * space; a snippet is included in the violation message so the reader can
 * still locate the line.
 */
export function normalizeCommentProse(text) {
  return text.replace(/[\r\n]+[ \t]*(?:\/\/+|\*)?[ \t]*/g, " ");
}

export function findDocLimitViolations(fileName, rawText) {
  const text = normalizeCommentProse(rawText);
  const violations = [];
  let matchCount = 0;
  for (const m of text.matchAll(DOC_LIMIT_RE)) {
    matchCount++;
    const lookback = text.slice(Math.max(0, m.index - 40), m.index);
    if (HONEST_NEGATION_RE.test(lookback)) continue; // ALLOWANCE: HONEST_NEGATION
    const windowStart = Math.max(0, m.index - DOC_LIMIT_PROXIMITY_CHARS);
    const windowEnd = Math.min(text.length, m.index + m[0].length + DOC_LIMIT_PROXIMITY_CHARS);
    if (/instructions/i.test(text.slice(windowStart, windowEnd))) {
      const snippet = text.slice(Math.max(0, m.index - 80), Math.min(text.length, m.index + m[0].length + 20));
      violations.push(
        `${fileName}: found "${m[0]}" within ${DOC_LIMIT_PROXIMITY_CHARS} chars of "instructions", and it is ` +
          `NOT the allowed negated form — this phase must never describe the 2048-byte budget as a ` +
          `documented platform limit (U-1, R1.7). Context: ...${snippet}...`,
      );
    }
  }
  return { violations, matchCount };
}

test("AC-7: no un-negated 'documented [platform|truncation] limit' claim near 'instructions' in any file this phase touches", () => {
  const filesToScan = {
    "harness-server.ts": SRC_TEXT.harness,
    "codex-server.ts": SRC_TEXT.codex,
    "antigravity-server.ts": SRC_TEXT.agy,
    "fixtures/run-fixture.mjs": readFileSync(join(__dirname, "fixtures", "run-fixture.mjs"), "utf8"),
  };
  const allViolations = [];
  let totalMatches = 0;
  for (const [fname, text] of Object.entries(filesToScan)) {
    const { violations, matchCount } = findDocLimitViolations(fname, text);
    allViolations.push(...violations);
    totalMatches += matchCount;
  }
  // Anti-vacuity tripwire — see the block comment above. A zero-match scan
  // means DOC_LIMIT_RE no longer matches the production phrasing, which is
  // exactly how revision 1's version of this guard became a no-op.
  assert.ok(
    totalMatches > 0,
    "AC-7 anti-vacuity: DOC_LIMIT_RE matched nothing in any scanned file. The guard is only meaningful " +
      "if it matches the real prose (currently the honest 'NOT a documented platform limit' negations in " +
      "harness-server.ts and codex-server.ts). Re-check the regex against the current comment wording " +
      "before assuming this is a pass.",
  );
  assert.deepEqual(allViolations, [], allViolations.join("\n"));
});

test("AC-7 negative test: an un-negated claim near 'instructions' IS reported, and the negated form is NOT", () => {
  const claim = "// The HARNESS_INSTRUCTIONS budget of 2048 bytes is a documented platform limit.";
  const { violations, matchCount } = findDocLimitViolations("synthetic.ts", claim);
  assert.equal(matchCount, 1, "the synthetic laundering claim must be matched by DOC_LIMIT_RE");
  assert.equal(violations.length, 1, "an un-negated claim adjacent to 'instructions' must be reported");
  assert.match(violations[0], /documented platform limit/);

  const negated = "// The HARNESS_INSTRUCTIONS budget of 2048 bytes is NOT a documented platform limit.";
  const negatedResult = findDocLimitViolations("synthetic.ts", negated);
  assert.equal(negatedResult.matchCount, 1, "the negated form must still be MATCHED (proving the regex is not narrowed to miss it)");
  assert.deepEqual(negatedResult.violations, [], "the negated form must be excused by the HONEST_NEGATION allowance, not by a regex miss");

  // Split across comment lines, as in harness-server.ts:576-577.
  const splitNegated = "// budget for the instructions string is self-imposed, NOT a\n// documented platform limit (U-1).";
  const splitResult = findDocLimitViolations("synthetic.ts", splitNegated);
  assert.equal(splitResult.matchCount, 1);
  assert.deepEqual(splitResult.violations, [], "the negation must be recognized across a comment-line break");

  // The case that defeated the FIRST attempt at this fix: the claim itself
  // wrapped across a comment-line break ("documented platform" / "// limit").
  // A regex applied to raw file text cannot match this, so the guard passed
  // on a genuinely laundering comment. Normalization is what closes it.
  const splitClaim = "// The HARNESS_INSTRUCTIONS budget of 2048 bytes is a documented platform\n// limit, per the docs.";
  const splitClaimResult = findDocLimitViolations("synthetic.ts", splitClaim);
  assert.equal(splitClaimResult.matchCount, 1, "a claim wrapped across a comment-line break must still be MATCHED");
  assert.equal(splitClaimResult.violations.length, 1, "a wrapped, un-negated claim must be reported — this is the case that defeated the first fix attempt");
});

// ═══════════════════════════════════════════════════════════════════════
// Group 2 — the hard assertion: measured payload vs declared ceiling
//
// UNITS: everything in this group is in CHARACTERS, matching the unit the
// annotation key itself names (`anthropic/maxResultSizeChars`). See the
// UNITS note in the file header.
// ═══════════════════════════════════════════════════════════════════════

const { buildFixture, assertClearsFloor, OVERSIZE_FIXTURE_OPTS, PHASE_A_BASELINE_GET_RUN_CHARS, FIXTURE_FLOOR_CHARS } =
  await import(pathToFileURL(join(__dirname, "fixtures", "run-fixture.mjs")).href);

// ─── R3.5 — single named constant, citation adjacent, never inlined ──────
// R2.6 / U-2: verified 2026-09-06 at code.claude.com/docs/en/mcp by the
// /pp:run driver (spec.md U-2). Verbatim facts confirmed on that page:
//   (a) `_meta["anthropic/maxResultSizeChars"]` is set "in the tool's
//       tools/list response entry";
//   (b) Claude Code "limits output to 25,000 tokens by default";
//   (c) the annotated value raises the threshold "up to a hard ceiling of
//       500,000 characters".
// Note (c)'s unit: CHARACTERS. That is why this whole group measures
// `serialized.length` and never `Buffer.byteLength`.
// This test-strategist pass has no live web-fetch tool and could not
// independently re-fetch the page; the figure below carries forward the
// citation already recorded at the get_run annotation site
// (daemon/src/mcp/harness-server.ts:753-769) and in the spec. R2.6 requires
// re-confirmation at merge/implementation time regardless — a platform
// constant can change after a spec (or this test) is written.
const DOCUMENTED_MAX_RESULT_SIZE_CHARS = 500000;

function roundUpTo50k(n) {
  return Math.ceil(n / 50000) * 50000;
}

// ─── R3.11 — the single named, exported helper used by BOTH the positive
//     and negative case. Not restated inline anywhere else in this file.
//     Both arguments are CHARACTER counts (revision 2 / MED-1): the caller
//     passes `fixture.getRunChars`, never `fixture.getRunBytes`.
export function assertUnderCeiling(toolName, payloadChars, ceilingChars) {
  if (!(payloadChars > 0) || !Number.isInteger(payloadChars)) {
    throw new Error(`assertUnderCeiling: payloadChars for "${toolName}" must be a positive integer, got ${payloadChars}`);
  }
  if (payloadChars > ceilingChars) {
    throw new Error(
      `assertUnderCeiling: "${toolName}"'s measured payload is ${payloadChars} chars, which EXCEEDS ` +
        `its declared ceiling of ${ceilingChars} chars.`,
    );
  }
}

// Memoized fixture accessors. Each fixture is built at most once per process,
// and every subtest that needs one awaits the accessor — so no subtest
// depends on another subtest having run first (which matters now that these
// are real node:test cases rather than sequential calls in one function).
let _floorFixture = null;
async function floorFixture() {
  if (!_floorFixture) _floorFixture = await buildFixture();
  return _floorFixture;
}
let _oversizeFixture = null;
async function oversizeFixture() {
  if (!_oversizeFixture) _oversizeFixture = await buildFixture(OVERSIZE_FIXTURE_OPTS);
  return _oversizeFixture;
}

test("R3.9: fixture builder produces byte-identical getRun/replay payloads across two consecutive builds", async () => {
  const first = await floorFixture();
  const second = await buildFixture();
  assert.equal(second.getRunChars, first.getRunChars, "two consecutive builds must serialize getRun identically");
  assert.equal(second.getRunSerialized, first.getRunSerialized, "getRun serialized text must be byte-identical across builds");
  assert.equal(second.replaySerialized, first.replaySerialized, "replay serialized text must be byte-identical across builds");
  console.log(
    `  [R3.9] getRun: ${first.getRunChars} chars (${first.getRunBytes} bytes UTF-8); ` +
      `replay: ${first.replayChars} chars (${first.replayBytes} bytes UTF-8); ratio: ${first.ratio.toFixed(4)}`,
  );
});

test("R3.10: fixture self-check clears the 150,000-char floor before any ceiling assertion runs", async () => {
  const fx = await floorFixture();
  assert.ok(FIXTURE_FLOOR_CHARS === 150000, "FIXTURE_FLOOR_CHARS must be the documented R3.10 floor");
  assert.ok(PHASE_A_BASELINE_GET_RUN_CHARS === 137255, "PHASE_A_BASELINE_GET_RUN_CHARS must carry its provenance value");
  assert.ok(FIXTURE_FLOOR_CHARS > PHASE_A_BASELINE_GET_RUN_CHARS, "the floor must be strictly greater than the baseline");
  assert.doesNotThrow(() => assertClearsFloor(fx), "the floor fixture must clear FIXTURE_FLOOR_CHARS");
});

// ─── R2.7 — derivation rule, recomputed at test time from a provenance-
//     carrying measurement constant, never asserted as a bare literal ─────
const derivedGetRunCeilingChars = Math.min(
  DOCUMENTED_MAX_RESULT_SIZE_CHARS,
  roundUpTo50k(2 * PHASE_A_BASELINE_GET_RUN_CHARS),
);

test("R2.7: get_run's declared ceiling equals min(DOCUMENTED_MAX, roundUpTo50k(2 * baseline)) recomputed at test time", () => {
  assert.equal(derivedGetRunCeilingChars, 300000, "the R2.7 formula must derive 300000 from the current baseline constant");
  const getRunEntry = describeHarnessSurface().find(t => t.name === "get_run");
  assert.ok(getRunEntry, "get_run must exist in the pp_harness surface");
  assert.ok(getRunEntry._meta, "get_run must declare _meta");
  assert.equal(
    getRunEntry._meta["anthropic/maxResultSizeChars"],
    derivedGetRunCeilingChars,
    "get_run's declared ceiling must equal the R2.7-derived value, not an independently-transcribed literal",
  );
});

// ─── R2.2 / R2.4 / R2.4a — the wire projection, via describeToolSurface() ─
//
// KNOWN LIMITATION (recorded, out of this stage's fence): harness-server.ts
// holds TWO parallel copies of the `if (t.meta) entry._meta = t.meta;`
// projection — one in describeToolSurface() (:1413-1420) and one in the
// ListTools handler (:1430-1440). These assertions therefore prove a
// faithful MIRROR of the wire, not the wire itself; a change to the handler
// alone would not be caught. De-duplicating them (having the handler call
// describeToolSurface() and add inputSchema) is a PRODUCTION change and is
// filed separately by the driver.
test("R2.2/R2.4: exactly {get_run} carries _meta on the pp_harness wire projection; no tool emits _meta: {}", () => {
  const surface = describeHarnessSurface();
  const declaring = surface.filter(t => Object.hasOwn(t, "_meta")).map(t => t.name);
  assert.deepEqual(new Set(declaring), new Set(["get_run"]), "the set of tools carrying _meta must be exactly { get_run }");
  for (const t of surface) {
    if (Object.hasOwn(t, "_meta")) {
      assert.ok(t._meta && Object.keys(t._meta).length > 0, `${t.name}: _meta key must never be emitted as an empty object`);
    }
  }
});

test("R2.4: replay's descriptor has NO _meta key at all (Object.hasOwn, not a truthiness check)", () => {
  const replayEntry = describeHarnessSurface().find(t => t.name === "replay");
  assert.ok(replayEntry, "replay must exist in the pp_harness surface");
  assert.ok(!Object.hasOwn(replayEntry, "_meta"), "replay must not carry an _meta key, present or absent-but-falsy");
  assert.ok(!("_meta" in replayEntry), "replay must not carry an _meta key ('in' check)");
});

test("R2.3: pp_codex / pp_agy surfaces never carry _meta on any tool", () => {
  for (const surface of [describeCodexSurface(), describeAgySurface()]) {
    for (const t of surface) {
      assert.ok(!Object.hasOwn(t, "_meta"), `${t.name}: pp_codex/pp_agy must never carry _meta plumbing (R2.3)`);
    }
  }
});

test("R2.8: the declared ceiling is a positive integer <= DOCUMENTED_MAX_RESULT_SIZE_CHARS", () => {
  assert.ok(Number.isInteger(derivedGetRunCeilingChars) && derivedGetRunCeilingChars > 0);
  assert.ok(derivedGetRunCeilingChars <= DOCUMENTED_MAX_RESULT_SIZE_CHARS);
});

// ─── R3.7 — the hard positive assertion, through the shared helper ────────
// CHARS on both sides (MED-1): getRunChars vs derivedGetRunCeilingChars.
test("R3.7: the floor fixture's measured getRun payload (chars) is under get_run's declared char ceiling (via assertUnderCeiling)", async () => {
  const fx = await floorFixture();
  assert.doesNotThrow(() =>
    assertUnderCeiling("get_run", fx.getRunChars, derivedGetRunCeilingChars),
  );
});

// ─── R3.11 — the negative test: the SAME helper MUST throw on an
//     over-ceiling fixture, naming the tool + measured size + ceiling ─────
test("R3.11: assertUnderCeiling THROWS on an over-ceiling get_run payload, naming the tool, size, and ceiling", async () => {
  const over = await oversizeFixture();
  assert.ok(
    over.getRunChars > derivedGetRunCeilingChars,
    `fixture-construction sanity: oversize fixture (${over.getRunChars} chars) must exceed the ceiling (${derivedGetRunCeilingChars} chars) — ` +
      `if this fails, OVERSIZE_FIXTURE_OPTS in run-fixture.mjs needs a larger critiqueMdChars`,
  );
  assert.throws(
    () => assertUnderCeiling("get_run", over.getRunChars, derivedGetRunCeilingChars),
    (err) => {
      assert.match(err.message, /get_run/);
      assert.match(err.message, new RegExp(String(over.getRunChars)));
      assert.match(err.message, new RegExp(String(derivedGetRunCeilingChars)));
      return true;
    },
    "assertUnderCeiling must throw for an over-ceiling payload, naming the tool and both measured size and ceiling",
  );
});

// ─── R3.11 control: prove the negative test is not vacuous — a helper with
//     the comparison removed would NOT catch the same defect. This is a
//     belt-and-suspenders in-file control; the implementer additionally
//     performs and records a real one-line mutation of assertUnderCeiling
//     itself (see PR description / final report), since that is the
//     mutation R3.11 actually asks for.
test("R3.11 control: a neutered comparator (comparison removed) does NOT throw on the same over-ceiling payload — proves the real helper's throw is load-bearing", async () => {
  const over = await oversizeFixture();
  function neuteredAssertUnderCeiling(_toolName, _payloadChars, _ceilingChars) {
    // comparison intentionally removed
  }
  assert.doesNotThrow(() => neuteredAssertUnderCeiling("get_run", over.getRunChars, derivedGetRunCeilingChars));
});

// ─── R3.7a — replay non-annotation tripwire (chars) ───────────────────────
test("R3.7a: buildReplayBundle over the same worst-case fixture serializes under 100,000 chars (replay non-annotation tripwire, R2.4a)", async () => {
  const fx = await floorFixture();
  const REPLAY_TRIPWIRE_CHARS = 100000;
  if (fx.replayChars >= REPLAY_TRIPWIRE_CHARS) {
    throw new Error(
      `R3.7a tripwire: replay's serialized payload (${fx.replayChars} chars) has reached the ` +
        `${REPLAY_TRIPWIRE_CHARS}-char tripwire (~25,000-token default cap at 4 chars/token). This does ` +
        `NOT mean raise the threshold — it means the R2.4a non-annotation ruling for 'replay' must be ` +
        `deliberately revisited (measure again; consider annotating replay if the cap is genuinely approached).`,
    );
  }
  console.log(`  [R3.7a] replay: ${fx.replayChars} chars (< ${REPLAY_TRIPWIRE_CHARS}); ` +
    `replay/get_run char ratio: ${(fx.replayChars / fx.getRunChars).toFixed(4)}`);
});

// ─── R3.8 — serialization path: no hand-rolled JSON.stringify in the
//     measurement path of this test or the fixture ─────────────────────────
test("R3.8: neither this test file nor the fixture hand-rolls JSON.stringify in the MEASUREMENT path", () => {
  const testSrc = readFileSync(__filename, "utf8");
  const fixtureSrc = readFileSync(join(__dirname, "fixtures", "run-fixture.mjs"), "utf8");
  // The fixture legitimately calls JSON.stringify ONCE, for a fixture row's
  // score_json column value (test data content, not the measurement path).
  // This test file legitimately embeds a JSON.stringify call inside the R1.6
  // child-process helper script string (used to compare instructions text
  // across two processes — nothing to do with getRun/replay size
  // measurement). Neither is the forbidden "hand-rolled measurement"
  // pattern R3.8 guards against: this test never itself serializes a
  // getRun/replay result — buildFixture() does that, exclusively via
  // jsonContent (dist/mcp/helpers.js).
  assert.match(fixtureSrc, /jsonContent/, "run-fixture.mjs must obtain jsonContent from dist/mcp/helpers.js");
  assert.ok(!/from\s+["'`].*helpers\.js["'`][\s\S]{0,80}JSON\.stringify/.test(fixtureSrc),
    "run-fixture.mjs must not re-implement jsonContent's serialization alongside importing it");
  for (const forbidden of [/JSON\.stringify\(\s*getRun/, /JSON\.stringify\(\s*(await\s+)?buildReplayBundle/, /JSON\.stringify\(\s*getRunResult/, /JSON\.stringify\(\s*replayResult/]) {
    assert.ok(!forbidden.test(testSrc), `mcp-instructions.unit.mjs must not hand-roll JSON.stringify on a getRun/replay result (matched ${forbidden})`);
    assert.ok(!forbidden.test(fixtureSrc), `run-fixture.mjs must not hand-roll JSON.stringify on a getRun/replay result (matched ${forbidden})`);
  }
});

// ─── R3.12 — group 2 cleanliness ───────────────────────────────────────────
test("R3.12: group 2 wrote nothing to the repo working tree or any .harness/ directory", () => {
  // The only filesystem writes group 2 performs are (a) SQLite under PP_HOME
  // (a mkdtemp dir, removed by the teardown subtest below) and (b) the R1.6
  // scratch script under its own mkdtemp dir (also removed there). Prove the
  // repo tree is untouched by checking git-visible state after this point
  // matches before (asserted operationally via the final `git status --short`
  // check the harness performs outside this file); here we assert the
  // structural precondition — PP_HOME itself is NOT inside REPO_ROOT, and
  // neither is any other scratch dir this file created.
  assert.ok(!PP_HOME.toLowerCase().startsWith(REPO_ROOT.toLowerCase()), "PP_HOME must not be inside the repo working tree");
  for (const d of cleanupDirs) {
    assert.ok(!d.toLowerCase().startsWith(REPO_ROOT.toLowerCase()), `scratch dir ${d} must not be inside the repo working tree`);
  }
});

// ─── Teardown — MUST be the last registered subtest ────────────────────────
//
// REVISION 2 (judge finding MED-2). The SQLite handle opened by
// buildFixture() via dist/db/database.js was never closed, so on Windows the
// file stayed locked, `rmSync` on PP_HOME threw EBUSY/EPERM, and revision
// 1's empty `catch {}` swallowed it — the temp-dir leak was invisible by
// construction. Now: close the handle first (closeDb() is idempotent), then
// remove each dir, and ASSERT that every removal succeeded. A cleanup
// failure is a visible, attributable test failure.
test("teardown: SQLite handle closed and every scratch dir removed (no silent temp-dir leak)", () => {
  closeDb();
  const errors = [];
  for (const d of cleanupDirs) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch (err) {
      errors.push(`${d}: ${err.message}`);
    }
    if (existsSync(d)) errors.push(`${d}: still exists after rmSync`);
  }
  const wallMs = Date.now() - SUITE_STARTED_AT;
  console.log(`  [R3.13] wall time: ${wallMs}ms`);
  if (wallMs >= 55000) {
    console.error(
      `  [R3.13 warning] wall time ${wallMs}ms is close to the 60,000ms single-file timeout; ` +
        `fixture generation should be made cheaper, not the timeout raised.`,
    );
  }
  assert.deepEqual(errors, [], `temp-dir cleanup failed (surfaced, not swallowed):\n${errors.join("\n")}`);
});
