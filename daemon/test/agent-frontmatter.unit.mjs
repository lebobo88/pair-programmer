/**
 * agent-frontmatter.unit.mjs
 *
 * Guard for Phase G of the cc-standards-alignment campaign (GitHub #48, epic
 * #42; run_CvKoIWhSC8XV, stage_iKKZhb933R). There is no spec artifact for
 * this phase -- the driving prompt (reproduced in the run's stage notes) IS
 * the spec, and this file is written directly against it.
 *
 * WHAT THIS GUARDS: `.claude/agents/*.md` frontmatter against the 17
 * documented Claude Code subagent frontmatter fields (code.claude.com/docs/
 * en/sub-agents.md, verified verbatim by the driver -- not re-derived here):
 * `name`, `description`, `tools`, `disallowedTools`, `model`,
 * `permissionMode`, `maxTurns`, `skills`, `mcpServers`, `hooks`, `memory`,
 * `background`, `effort`, `isolation`, `color`, `initialPrompt`,
 * `experimental`. Specifically:
 *
 *   1. every `color:` is one of the 8 documented values, and every agent has one
 *   2. every `effort:` is one of the 5 documented values, at exactly the
 *      named policy set (5 `low`, 2 `high`), absent elsewhere
 *   3. `maxTurns` appears on exactly {triage, profile-loader}, and by name on
 *      NOTHING in the author/judge/engineer sets (a turn cap there can
 *      truncate a valid Reflexion retry into a partial output)
 *   4. no frontmatter key outside the documented 17 (plus the one named,
 *      pre-existing, non-Claude exception below) -- a typo is silently
 *      ignored by the platform, which is the worst failure mode
 *   5. the model-invocation-blocking frontmatter key (see item 5 below)
 *      appears in no skill and no agent (it also
 *      prevents subagent skill-preload, which would break Phase F's
 *      `skills:` preload)
 *   6. every `skills:` member resolves to a real `.claude/skills/<name>/SKILL.md`
 *      bundle
 *   7. the generator (`enumerateAgentSources`, `scripts/sync-copilot-assets.mjs`)
 *      finds a nested agent and throws on a cross-directory basename collision,
 *      before any write
 *
 * PRE-EXISTING NON-DOCUMENTED KEY (found while writing this guard, reported
 * to the driver, NOT fixed here -- `.claude/` is off-limits for this stage):
 * `.claude/agents/pair-programmer-orchestrator.md` carries a `copilot-model:`
 * frontmatter key. It is not one of the 17 documented Claude Code fields --
 * it is intentionally non-standard, consumed only by
 * `scripts/sync-copilot-assets.mjs`'s `renderAgent()` to select a GitHub
 * Copilot CLI catalog model for that mirror, and the source file carries an
 * in-line comment explaining why it must never be swept with the Codex
 * model pins. Item 4 below allow-lists exactly this one key, on exactly this
 * one agent, and asserts (not merely hopes) that the allowance does not
 * quietly spread to any other agent -- so a future agent picking up
 * `copilot-model:` by copy-paste, or picking up any OTHER undocumented key,
 * still fails loudly.
 *
 * ANTI-STALL TEST RULE (AGENTS.md): self-contained -- no live daemon, no MCP
 * peer, no network, no database. Reads real repo markdown plus drives the
 * real `enumerateAgentSources` (now exported from `scripts/sync-copilot-assets.mjs`
 * for this purpose, per this stage's authorisation) against temp-directory
 * fixtures. All writes this file performs target `mkdtempSync(join(tmpdir(), ...))`
 * directories, removed in a `finally` block; nothing here ever writes under
 * `.claude/`, `.github/`, `docs/`, or `scripts/`.
 *
 * SELF-REFERENCE SAFETY: the one forbidden literal this file scans for
 * (the model-invocation-blocking frontmatter key) is assembled at runtime from fragments, none
 * of which is itself the forbidden value, and this file's own source is
 * scanned to prove the assembled literal does not appear in it contiguously
 * -- following the exact pattern already shipped in
 * `daemon/test/skill-discovery.unit.mjs` and `daemon/test/no-dangling-pointers.unit.mjs`.
 *
 * COUNT DISCIPLINE: no agent/skill count is transcribed. The agent set and
 * its size are derived from `enumerateAgentSources()` against the real
 * `.claude/agents/` tree; the author-name and judge-name lists below are
 * POLICY sets (which named agents must never carry `maxTurns`), not counts,
 * and every name in them is independently asserted to resolve to a real
 * agent file so the list cannot rot into a no-op silently.
 */

import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { enumerateAgentSources } from "../../scripts/sync-copilot-assets.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = join(__dirname, "..", "..");

const CLAUDE_DIR = join(REPO_ROOT, ".claude");
const CLAUDE_AGENTS_DIR = join(CLAUDE_DIR, "agents");
const CLAUDE_SKILLS_DIR = join(CLAUDE_DIR, "skills");

// ─── Scaffolding parsers (test helpers, NOT the logic under test) ─────────
// Mirrors the flat-frontmatter algorithm scripts/sync-copilot-assets.mjs
// uses internally (splitFrontmatter / parseFlatFrontmatter -- neither is
// exported, and every agent frontmatter block in this repo is a flat
// `key: value` list with `#`-prefixed comment lines, never nested YAML, so a
// flat parser is a faithful read, not a simplification of the real shape).

function splitFrontmatterLocal(content) {
  if (!content.startsWith("---\n")) return { frontmatter: "", body: content };
  const end = content.indexOf("\n---\n", 4);
  if (end === -1) return { frontmatter: "", body: content };
  return { frontmatter: content.slice(4, end), body: content.slice(end + 5) };
}

/** Returns { data, keys } -- `data` maps key -> value (last-wins, matching
 * the real generator), `keys` is the deduplicated, in-order list of raw
 * top-level keys actually present (comment lines and blank lines excluded). */
function parseFlatFrontmatterLocal(frontmatter) {
  const data = {};
  const keys = [];
  const malformed = [];
  const indented = [];
  for (const rawLine of frontmatter.split("\n")) {
    if (!rawLine.trim() || rawLine.trim().startsWith("#")) continue;

    // MED-3 / LOW-1 (Phase G judge): this loop used to `rawLine.trim()` and
    // then `continue` on any line the key regex did not match. Both halves
    // were wrong in opposite directions. Trimming PROMOTED an indented line
    // to a top-level key; skipping a non-match silently DROPPED
    // `max_turns : 5` (space before the colon) and `effort=high`, so the
    // unknown-key check never saw them -- which is precisely the "the
    // platform ignores your typo and the field looks set" failure mode that
    // check exists to catch. Both are now surfaced to the caller.
    if (/^\s/.test(rawLine)) {
      indented.push(rawLine);
      continue;
    }
    const match = rawLine.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!match) {
      malformed.push(rawLine);
      continue;
    }
    if (!(match[1] in data)) keys.push(match[1]);
    data[match[1]] = match[2];
  }
  return { data, keys, malformed, indented };
}

function readAgentFrontmatter(sourcePath) {
  const content = readFileSync(sourcePath, "utf8").replace(/\r\n/g, "\n");
  const { frontmatter } = splitFrontmatterLocal(content);
  return parseFlatFrontmatterLocal(frontmatter);
}

function makeTempDir(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

// ─── Real, filesystem-derived agent set ────────────────────────────────────
// enumerateAgentSources() is the REAL generator function (Phase G export),
// driven against the real .claude/agents/ tree. This is also, incidentally,
// a live proof that the real tree has no basename collision today (it would
// throw here if it did).
const realAgentSources = enumerateAgentSources(CLAUDE_AGENTS_DIR);
const realAgentRecords = realAgentSources.map(({ file, sourcePath }) => {
  const base = file.replace(/\.md$/, "");
  const { data, keys } = readAgentFrontmatter(sourcePath);
  return { base, sourcePath, data, keys };
});
const realAgentBasenames = new Set(realAgentRecords.map((r) => r.base));

function setDiff(a, b) {
  return [...a].filter((x) => !b.has(x)).sort();
}

// ═══════════════════════════════════════════════════════════════════════
// Non-emptiness sanity: the real tree actually has agents to check
// ═══════════════════════════════════════════════════════════════════════
describe("sanity: the real .claude/agents/ tree is non-empty", () => {
  it("enumerateAgentSources(.claude/agents) returns at least one agent", () => {
    assert.ok(realAgentSources.length > 0, "derived zero agents -- every assertion below would pass vacuously");
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Item 1 -- color: one of the 8 documented values, present on every agent
// ═══════════════════════════════════════════════════════════════════════
const DOCUMENTED_COLORS = new Set(["red", "blue", "green", "yellow", "purple", "orange", "pink", "cyan"]);

function isDocumentedColor(value) {
  return typeof value === "string" && DOCUMENTED_COLORS.has(value.trim());
}

describe("item 1: every agent's color: is one of the 8 documented values", () => {
  it("at least one agent record exists before iterating", () => {
    assert.ok(realAgentRecords.length > 0);
  });

  for (const { base, data } of realAgentRecords) {
    it(`${base}: has a color and it is documented`, () => {
      assert.ok(typeof data.color === "string" && data.color.trim().length > 0, `${base} has no color: field`);
      assert.ok(isDocumentedColor(data.color), `${base} has undocumented color "${data.color}"`);
    });
  }

  it(`exactly ${realAgentRecords.length} of ${realAgentRecords.length} agents carry a documented color (derived tally, not transcribed)`, () => {
    const withColor = realAgentRecords.filter((r) => isDocumentedColor(r.data.color));
    assert.equal(withColor.length, realAgentRecords.length, `${realAgentRecords.length - withColor.length} agent(s) missing/undocumented color`);
  });

  it("falsifiability: a fixture with color: magenta is rejected by isDocumentedColor()", () => {
    assert.equal(isDocumentedColor("magenta"), false, "magenta is not one of the 8 documented colors and must be rejected");
  });

  it("falsifiability: a fixture with a real documented color (cyan) is accepted by isDocumentedColor()", () => {
    assert.equal(isDocumentedColor("cyan"), true);
  });

  it("falsifiability: a missing color field is rejected", () => {
    assert.equal(isDocumentedColor(undefined), false);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Item 2 -- effort: exactly the named 5-low/2-high policy set, and every
// observed value is one of the 5 documented effort levels
// ═══════════════════════════════════════════════════════════════════════
const DOCUMENTED_EFFORT_VALUES = new Set(["low", "medium", "high", "xhigh", "max"]);
const EXPECTED_EFFORT_LOW = new Set(["triage", "profile-loader", "taxonomy-mapper", "run-finalizer", "missability-inspector"]);
const EXPECTED_EFFORT_HIGH = new Set(["judge-cross-vendor", "security-reviewer"]);

function isDocumentedEffort(value) {
  return typeof value === "string" && DOCUMENTED_EFFORT_VALUES.has(value.trim());
}

describe("item 2: effort: is exactly the named policy set, and every value is documented", () => {
  it("every name in the low/high policy sets resolves to a real agent file (list cannot rot silently)", () => {
    for (const name of [...EXPECTED_EFFORT_LOW, ...EXPECTED_EFFORT_HIGH]) {
      assert.ok(realAgentBasenames.has(name), `policy set names "${name}" but no such agent file exists under .claude/agents/`);
    }
  });

  const actualLow = new Set(realAgentRecords.filter((r) => r.data.effort === "low").map((r) => r.base));
  const actualHigh = new Set(realAgentRecords.filter((r) => r.data.effort === "high").map((r) => r.base));
  const actualAnyEffort = realAgentRecords.filter((r) => "effort" in r.data);

  it("actual effort:low set equals the expected 5-name policy set exactly", () => {
    assert.deepEqual(setDiff(EXPECTED_EFFORT_LOW, actualLow), [], "missing effort:low");
    assert.deepEqual(setDiff(actualLow, EXPECTED_EFFORT_LOW), [], "unexpectedly carries effort:low");
  });

  it("actual effort:high set equals the expected 2-name policy set exactly", () => {
    assert.deepEqual(setDiff(EXPECTED_EFFORT_HIGH, actualHigh), [], "missing effort:high");
    assert.deepEqual(setDiff(actualHigh, EXPECTED_EFFORT_HIGH), [], "unexpectedly carries effort:high");
  });

  it("no agent outside the 7-name policy set carries an effort: key at all", () => {
    const unexpected = actualAnyEffort
      .filter((r) => !EXPECTED_EFFORT_LOW.has(r.base) && !EXPECTED_EFFORT_HIGH.has(r.base))
      .map((r) => r.base);
    assert.deepEqual(unexpected, [], `agent(s) with an undocumented-in-policy effort key: ${unexpected.join(", ")}`);
    assert.equal(actualAnyEffort.length, EXPECTED_EFFORT_LOW.size + EXPECTED_EFFORT_HIGH.size, "total effort-bearing agent count must equal the derived policy-set size, not a transcribed number");
  });

  it("every observed effort: value is one of the 5 documented levels", () => {
    const offenders = actualAnyEffort.filter((r) => !isDocumentedEffort(r.data.effort)).map((r) => `${r.base}=${r.data.effort}`);
    assert.deepEqual(offenders, [], `undocumented effort value(s): ${offenders.join(", ")}`);
  });

  it("falsifiability: an undocumented effort value (extreme) is rejected by isDocumentedEffort()", () => {
    assert.equal(isDocumentedEffort("extreme"), false);
  });

  it("falsifiability: a documented effort value (xhigh) is accepted by isDocumentedEffort()", () => {
    assert.equal(isDocumentedEffort("xhigh"), true);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Item 3 -- maxTurns: exactly {triage, profile-loader}; absent by name on
// engineer, every author, and every judge
// ═══════════════════════════════════════════════════════════════════════
const EXPECTED_MAXTURNS = new Set(["triage", "profile-loader"]);

// Judges share a naming convention (`judge-*`), so this set is DERIVED from
// the filesystem, not transcribed.
const derivedJudgeNames = new Set(realAgentRecords.filter((r) => r.base.startsWith("judge-")).map((r) => r.base));

// Authors do not share one naming convention (architect, api-designer,
// data-modeler, test-strategist, discovery-researcher have no common
// suffix), so this list is unavoidably literal -- but every entry is
// asserted below to resolve to a real agent file, so a rename or removal
// fails loudly here rather than silently narrowing the coverage.
const AUTHOR_NAMES = [
  "spec-author",
  "test-strategist",
  "docs-author",
  "architect",
  "api-designer",
  "data-modeler",
  "discovery-researcher",
  "governance-author",
  "ops-author",
  "strategy-author",
  "ai-controls-author",
  "agents-md-author",
];

function hasMaxTurns(record) {
  return "maxTurns" in record.data;
}

describe("item 3: maxTurns appears on exactly {triage, profile-loader}, and by name on nothing else that matters", () => {
  it("derivedJudgeNames is non-empty (the judge-* naming convention actually matched something)", () => {
    assert.ok(derivedJudgeNames.size > 0, "derived zero judge-* agents -- the naming convention assumption is wrong");
  });

  it("every AUTHOR_NAMES entry resolves to a real agent file", () => {
    for (const name of AUTHOR_NAMES) {
      assert.ok(realAgentBasenames.has(name), `AUTHOR_NAMES lists "${name}" but no such agent file exists -- the list has rotted`);
    }
    assert.ok(realAgentBasenames.has("engineer"), `"engineer" must resolve to a real agent file`);
  });

  it("the actual maxTurns-bearing agent set equals {triage, profile-loader} exactly", () => {
    const actual = new Set(realAgentRecords.filter(hasMaxTurns).map((r) => r.base));
    assert.deepEqual(setDiff(EXPECTED_MAXTURNS, actual), [], "missing maxTurns");
    assert.deepEqual(setDiff(actual, EXPECTED_MAXTURNS), [], "unexpectedly carries maxTurns");
  });

  const protectedNames = new Set(["engineer", ...AUTHOR_NAMES, ...derivedJudgeNames]);

  it(`the protected set (engineer + ${AUTHOR_NAMES.length} authors + ${derivedJudgeNames.size} judges) does not overlap the maxTurns policy set`, () => {
    // No protected name (engineer, any author, any judge) may itself be one
    // of the two maxTurns-carrying agents -- a contradiction in the policy
    // sets themselves, not just a per-agent assertion below.
    const overlap = [...protectedNames].filter((n) => EXPECTED_MAXTURNS.has(n));
    assert.deepEqual(overlap, [], "a protected agent name is also in the maxTurns policy set -- contradiction in the policy sets themselves");
  });

  for (const name of protectedNames) {
    it(`${name}: carries no maxTurns key`, () => {
      const record = realAgentRecords.find((r) => r.base === name);
      assert.ok(record, `no agent record found for "${name}"`);
      assert.equal(hasMaxTurns(record), false, `${name} unexpectedly carries maxTurns -- a turn cap here can truncate a valid Reflexion retry into a partial output`);
    });
  }

  it("falsifiability: hasMaxTurns() flags a fixture record that carries maxTurns", () => {
    assert.equal(hasMaxTurns({ data: { maxTurns: "6" } }), true);
  });

  it("falsifiability: hasMaxTurns() does not flag a fixture record without maxTurns", () => {
    assert.equal(hasMaxTurns({ data: { color: "blue" } }), false);
  });

  it("falsifiability: engineer.md's REAL frontmatter, with a synthetic maxTurns line spliced in, is flagged by the same parser+check used above", () => {
    const engineerRecord = realAgentRecords.find((r) => r.base === "engineer");
    assert.ok(engineerRecord, "engineer agent record must exist for this fixture");
    const realContent = readFileSync(engineerRecord.sourcePath, "utf8").replace(/\r\n/g, "\n");
    const { frontmatter, body } = splitFrontmatterLocal(realContent);
    const mutatedFrontmatter = `${frontmatter}\nmaxTurns: 5`;
    const mutatedContent = `---\n${mutatedFrontmatter}\n---\n${body}`;
    const { frontmatter: parsedBack } = splitFrontmatterLocal(mutatedContent);
    const { data: mutatedData } = parseFlatFrontmatterLocal(parsedBack);
    assert.equal(hasMaxTurns({ data: mutatedData }), true, "a maxTurns line spliced into engineer's real frontmatter must be detected");
    // and the REAL unmutated file must NOT be flagged, proving this is not a
    // check that always returns true.
    assert.equal(hasMaxTurns(engineerRecord), false, "the real, unmutated engineer.md must not be flagged");
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Item 4 -- no frontmatter key outside the documented 17 (plus the one
// named, pre-existing, non-Claude exception)
// ═══════════════════════════════════════════════════════════════════════
const DOCUMENTED_AGENT_KEYS = new Set([
  "name", "description", "tools", "disallowedTools", "model", "permissionMode",
  "maxTurns", "skills", "mcpServers", "hooks", "memory", "background",
  "effort", "isolation", "color", "initialPrompt", "experimental",
]);

// See the file-header note: copilot-model is a deliberate, pre-existing,
// non-Claude field consumed only by scripts/sync-copilot-assets.mjs, and
// `.claude/` is off-limits to fix in this stage. Allow-listed ONLY on this
// one agent -- asserted below, not assumed.
const ALLOWED_NONSTANDARD_KEYS_BY_AGENT = { "pair-programmer-orchestrator": new Set(["copilot-model"]) };

function unknownKeysFor(record) {
  const allowed = ALLOWED_NONSTANDARD_KEYS_BY_AGENT[record.base] || new Set();
  return record.keys.filter((k) => !DOCUMENTED_AGENT_KEYS.has(k) && !allowed.has(k));
}

describe("item 4: no frontmatter key outside the documented 17 (+ the one named exception)", () => {
  it("at least one agent record exists before iterating", () => {
    assert.ok(realAgentRecords.length > 0);
  });

  for (const record of realAgentRecords) {
    it(`${record.base}: every frontmatter key is documented (or the one named exception)`, () => {
      const offenders = unknownKeysFor(record);
      assert.deepEqual(offenders, [], `undocumented key(s) in ${record.base}: ${offenders.join(", ")}`);
    });
  }

  it("the copilot-model allowance does not quietly spread to any other agent", () => {
    const spread = realAgentRecords
      .filter((r) => r.base !== "pair-programmer-orchestrator")
      .filter((r) => r.keys.includes("copilot-model"))
      .map((r) => r.base);
    assert.deepEqual(spread, [], `copilot-model found on unexpected agent(s): ${spread.join(", ")}`);
  });

  it("pair-programmer-orchestrator does carry copilot-model (the allowance target actually exists, proving the allow-list is not dead code)", () => {
    const record = realAgentRecords.find((r) => r.base === "pair-programmer-orchestrator");
    assert.ok(record, "pair-programmer-orchestrator agent must exist");
    assert.ok(record.keys.includes("copilot-model"), "expected copilot-model on pair-programmer-orchestrator -- if this fails, the allow-list is now dead and should be removed");
  });

  it("falsifiability: a misspelled key (maxturns, lowercase) is flagged as unknown by unknownKeysFor()", () => {
    const fixture = { base: "some-agent", keys: ["name", "maxturns"] };
    assert.deepEqual(unknownKeysFor(fixture), ["maxturns"]);
  });

  it("falsifiability: a misspelled key (effort_level) is flagged as unknown by unknownKeysFor()", () => {
    const fixture = { base: "some-agent", keys: ["name", "effort_level"] };
    assert.deepEqual(unknownKeysFor(fixture), ["effort_level"]);
  });

  it("falsifiability (negative): every one of the 17 documented keys individually passes unknownKeysFor()", () => {
    const fixture = { base: "some-agent", keys: [...DOCUMENTED_AGENT_KEYS] };
    assert.deepEqual(unknownKeysFor(fixture), []);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Item 5 -- the model-invocation-blocking key appears in no skill and no agent
// ═══════════════════════════════════════════════════════════════════════
// Assembled from fragments, none of which is itself the forbidden value, so
// this file's own source text cannot satisfy the pattern it searches for.
const FORBIDDEN_INVOCATION_KEY = ["disable", "-model-", "invocation"].join("");

function sourceLacksForbiddenLiteral(src) {
  return !src.includes(FORBIDDEN_INVOCATION_KEY);
}

function skillBundleSourcePaths(skillsDir) {
  const paths = [];
  for (const entry of readdirSync(skillsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const skillPath = join(skillsDir, entry.name, "SKILL.md");
    if (existsSync(skillPath)) paths.push(skillPath);
  }
  return paths;
}

describe("item 5: the model-invocation-blocking key appears in no agent and no skill", () => {
  const skillPaths = skillBundleSourcePaths(CLAUDE_SKILLS_DIR);

  it("at least one agent and one skill bundle exist before scanning", () => {
    assert.ok(realAgentRecords.length > 0);
    assert.ok(skillPaths.length > 0);
  });

  it(`the ${FORBIDDEN_INVOCATION_KEY} key does not appear in any real agent's raw source`, () => {
    const offenders = realAgentRecords
      .filter((r) => readFileSync(r.sourcePath, "utf8").includes(FORBIDDEN_INVOCATION_KEY))
      .map((r) => r.base);
    assert.deepEqual(offenders, [], `forbidden key found in agent(s): ${offenders.join(", ")}`);
  });

  it(`the ${FORBIDDEN_INVOCATION_KEY} key does not appear in any real skill bundle's raw source`, () => {
    const offenders = skillPaths.filter((p) => readFileSync(p, "utf8").includes(FORBIDDEN_INVOCATION_KEY));
    assert.deepEqual(offenders, [], `forbidden key found in skill bundle(s): ${offenders.join(", ")}`);
  });

  it("self-reference safety: this file's own source does not contain the forbidden key contiguously", () => {
    const src = readFileSync(__filename, "utf8");
    assert.ok(sourceLacksForbiddenLiteral(src), "the forbidden key must not appear contiguously in this file's own source");
  });

  it("mutation control (falsifiability): a fixture agent carrying the forbidden key IS caught by the real scan logic", () => {
    const tmp = makeTempDir("pp-forbidden-key-agent-");
    try {
      const fixturePath = join(tmp, "bad-agent.md");
      writeFileSync(fixturePath, `---\nname: bad-agent\n${FORBIDDEN_INVOCATION_KEY}: true\ndescription: x\ncolor: blue\n---\nbody\n`, "utf8");
      // MED-1 (Phase G judge): this used to be
      // `readFileSync(...).includes(FORBIDDEN_INVOCATION_KEY)`, which
      // re-implemented the scan and therefore tested node:fs and
      // String.includes rather than the predicate under test. It now drives
      // the real predicate, so a regression in `sourceLacksForbiddenLiteral`
      // turns this red instead of leaving it green.
      const clean = sourceLacksForbiddenLiteral(readFileSync(fixturePath, "utf8"));
      assert.equal(
        clean, false,
        "sourceLacksForbiddenLiteral() must report NOT-clean for a fixture that actually contains the forbidden key -- " +
        "if this passes, the predicate has stopped detecting it and every real-tree assertion built on it is vacuous",
      );
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("mutation control (negative): a synthetic clean source string is NOT flagged", () => {
    assert.equal(sourceLacksForbiddenLiteral("const fine = 'nothing forbidden here';"), true);
  });

  it("mutation control (falsifiability): a synthetic source string containing the literal fails sourceLacksForbiddenLiteral()", () => {
    assert.equal(sourceLacksForbiddenLiteral(`const oops = "${FORBIDDEN_INVOCATION_KEY}: true";`), false);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Item 6 -- every skills: member resolves to a real .claude/skills/<name>/SKILL.md
// ═══════════════════════════════════════════════════════════════════════
function resolveSkillBundle(skillsDir, name) {
  return existsSync(join(skillsDir, name, "SKILL.md"));
}

function parseSkillsField(value) {
  if (typeof value !== "string" || !value.trim()) return [];
  return value.split(",").map((s) => s.trim()).filter(Boolean);
}

describe("item 6: every agent skills: member resolves to a real skill bundle", () => {
  const agentsWithSkills = realAgentRecords.filter((r) => typeof r.data.skills === "string" && r.data.skills.trim().length > 0);

  it("at least one agent declares a skills: field (non-vacuity)", () => {
    assert.ok(agentsWithSkills.length > 0, "derived zero agents with a skills: field -- the assertions below would pass vacuously");
  });

  for (const record of agentsWithSkills) {
    const members = parseSkillsField(record.data.skills);
    it(`${record.base}: every skills: member (${members.join(", ")}) resolves to a real bundle`, () => {
      assert.ok(members.length > 0, `${record.base} declares skills: but parsed to zero members`);
      const missing = members.filter((m) => !resolveSkillBundle(CLAUDE_SKILLS_DIR, m));
      assert.deepEqual(missing, [], `${record.base} references nonexistent skill bundle(s): ${missing.join(", ")}`);
    });
  }

  it("falsifiability: resolveSkillBundle() is true for a real skill (design-discovery)", () => {
    assert.equal(resolveSkillBundle(CLAUDE_SKILLS_DIR, "design-discovery"), true);
  });

  it("falsifiability: resolveSkillBundle() is false for a fabricated skill name", () => {
    assert.equal(resolveSkillBundle(CLAUDE_SKILLS_DIR, "totally-nonexistent-skill-xyz"), false);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Item 7 -- enumerateAgentSources(): recursive discovery + basename
// collision throws, before any write. Drives the REAL exported function
// against temp-directory fixtures, per the stage's explicit authorisation
// to export it.
// ═══════════════════════════════════════════════════════════════════════
describe("item 7: enumerateAgentSources() discovers nested agents and throws on a cross-directory basename collision", () => {
  it("a nested agent (under a subdirectory) is found", () => {
    const tmp = makeTempDir("pp-agent-enum-nested-");
    try {
      const subdir = join(tmp, "sub", "deeper");
      mkdirSync(subdir, { recursive: true });
      writeFileSync(join(subdir, "nested-agent.md"), "---\nname: nested-agent\ncolor: blue\ndescription: x\n---\nbody\n", "utf8");
      writeFileSync(join(tmp, "top-agent.md"), "---\nname: top-agent\ncolor: blue\ndescription: x\n---\nbody\n", "utf8");

      const sources = enumerateAgentSources(tmp);
      const names = sources.map((s) => s.file).sort();
      assert.deepEqual(names, ["nested-agent.md", "top-agent.md"], "must find both the top-level and the nested agent");
      const nested = sources.find((s) => s.file === "nested-agent.md");
      assert.equal(nested.sourcePath, join(subdir, "nested-agent.md"), "subdirectory path must not affect discovery");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("an empty temp dir yields zero sources (the absence case, proven distinct from the nested-discovery case above)", () => {
    const tmp = makeTempDir("pp-agent-enum-empty-");
    try {
      assert.deepEqual(enumerateAgentSources(tmp), []);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("two agents sharing a basename across different subdirectories throws, naming both paths", () => {
    const tmp = makeTempDir("pp-agent-enum-collision-");
    try {
      const dirA = join(tmp, "dir-a");
      const dirB = join(tmp, "dir-b");
      mkdirSync(dirA, { recursive: true });
      mkdirSync(dirB, { recursive: true });
      writeFileSync(join(dirA, "dup.md"), "---\nname: dup\ncolor: blue\ndescription: first\n---\nbody\n", "utf8");
      writeFileSync(join(dirB, "dup.md"), "---\nname: dup\ncolor: blue\ndescription: second\n---\nbody\n", "utf8");

      // snapshot the fixture tree before the call, to prove the throw
      // happens before any write (enumerateAgentSources is a pure read, so
      // this should never change).
      const beforeA = readdirSync(dirA).sort();
      const beforeB = readdirSync(dirB).sort();

      assert.throws(
        () => enumerateAgentSources(tmp),
        (err) => err instanceof Error && err.message.includes("dup") && err.message.includes(dirA) && err.message.includes(dirB),
        "must throw naming the colliding basename and both source paths",
      );

      const afterA = readdirSync(dirA).sort();
      const afterB = readdirSync(dirB).sort();
      assert.deepEqual(afterA, beforeA, "the collision throw must not have written anything into dir-a");
      assert.deepEqual(afterB, beforeB, "the collision throw must not have written anything into dir-b");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("falsifiability (negative): two agents with DIFFERENT basenames in different subdirectories do NOT throw", () => {
    const tmp = makeTempDir("pp-agent-enum-no-collision-");
    try {
      const dirA = join(tmp, "dir-a");
      const dirB = join(tmp, "dir-b");
      mkdirSync(dirA, { recursive: true });
      mkdirSync(dirB, { recursive: true });
      writeFileSync(join(dirA, "alpha.md"), "---\nname: alpha\ncolor: blue\ndescription: x\n---\nbody\n", "utf8");
      writeFileSync(join(dirB, "beta.md"), "---\nname: beta\ncolor: blue\ndescription: x\n---\nbody\n", "utf8");
      assert.doesNotThrow(() => enumerateAgentSources(tmp));
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("the real .claude/agents/ tree itself has no basename collision (enumerateAgentSources already succeeded to build realAgentSources above)", () => {
    assert.equal(realAgentSources.length, realAgentBasenames.size, "a collision would have thrown before this file's top-level enumeration completed, so this is really just confirming that succeeded");
  });
});

// ═══════════════════════════════════════════════════════════════════════
// MED-3 / LOW-1 (Phase G judge) — the parser used to silently drop any line
// it could not match and to promote indented lines to top-level keys. Both
// let a typo through the unknown-key check while looking set to a reader,
// which is the worst failure mode the platform has here: it ignores the key
// and reports nothing. The parser now surfaces both, and these assertions
// are what make that surfacing load-bearing rather than decorative.
// ═══════════════════════════════════════════════════════════════════════
describe("frontmatter parsing is strict: no malformed or indented line is silently dropped", () => {
  it("no real agent frontmatter contains a malformed or indented line", () => {
    assert.ok(realAgentSources.length > 0, "derived zero agent sources -- the scan root is wrong and every assertion here would pass vacuously");
    const offenders = [];
    // JA-3 (docs judge): this destructured `name`, but enumerateAgentSources
    // returns `{ file, sourcePath }` -- so every offender label printed
    // "undefined:" and the message named no file. The assertion still fired;
    // it just could not tell you where to look, which is most of the value.
    for (const { file, sourcePath } of realAgentSources) {
      const label = file.replace(/\.md$/, "");
      const { malformed, indented } = readAgentFrontmatter(sourcePath);
      for (const line of malformed) offenders.push(`${label}: malformed ${JSON.stringify(line)}`);
      for (const line of indented) offenders.push(`${label}: indented ${JSON.stringify(line)}`);
    }
    assert.deepEqual(
      offenders, [],
      "frontmatter lines that are neither a comment nor a top-level `key: value`:\n  " + offenders.join("\n  ") +
      "\nClaude Code would ignore these, so the field looks set and does nothing. Fix the line, do not relax this check.",
    );
  });

  it("falsifiability: a space before the colon is reported as malformed, not skipped", () => {
    const { data, keys, malformed } = parseFlatFrontmatterLocal("name: a\nmax_turns : 5\ncolor: blue");
    assert.equal(data.max_turns, undefined, "a space before the colon is not a valid key -- it must not parse as one");
    assert.ok(!keys.includes("max_turns"), "and it must not appear in the key list");
    assert.deepEqual(malformed, ["max_turns : 5"], "it MUST be surfaced as malformed -- the old parser dropped it, which is how a typo stayed invisible");
  });

  it("falsifiability: an `=` instead of a `:` is reported as malformed", () => {
    const { malformed } = parseFlatFrontmatterLocal("name: a\neffort=high\ncolor: blue");
    assert.deepEqual(malformed, ["effort=high"]);
  });

  it("falsifiability: an indented line is reported as indented, NOT promoted to a top-level key", () => {
    const { data, keys, indented } = parseFlatFrontmatterLocal("name: a\n  effort: high\ncolor: blue");
    assert.equal(data.effort, undefined, "an indented line must not become a top-level key -- the old parser trimmed it and promoted it");
    assert.ok(!keys.includes("effort"), "and it must not appear in the key list");
    assert.deepEqual(indented, ["  effort: high"]);
  });

  it("a well-formed block yields neither malformed nor indented lines", () => {
    const { data, keys, malformed, indented } = parseFlatFrontmatterLocal("# a comment\nname: a\ncolor: blue\neffort: high");
    assert.deepEqual(malformed, [], "a clean block must report nothing malformed -- otherwise the check above is a false-positive generator");
    assert.deepEqual(indented, [], "a clean block must report nothing indented");
    assert.deepEqual(keys, ["name", "color", "effort"]);
    assert.equal(data.effort, "high");
  });
});

// ═══════════════════════════════════════════════════════════════════════
// A justifying comment that names a number MUST agree with the field it
// justifies. The driver raised triage's maxTurns from 4 to 6 on a judge
// finding and left the comment reading "maxTurns=4 ... 4 turns leaves
// margin" directly beneath `maxTurns: 6` — so the shipped justification
// contradicted the shipped value, and a reader trusting the comment would
// have reasoned from the wrong number. Caught by the docs-stage judge, not
// by any assertion, which is why this one exists.
// ═══════════════════════════════════════════════════════════════════════
describe("a frontmatter comment naming maxTurns=N agrees with the maxTurns value it sits beside", () => {
  /** Returns [{name, commented, actual}] for every agent whose frontmatter
   * comments mention `maxTurns=<n>`, paired with the real field value. */
  function commentedMaxTurns(sources) {
    const out = [];
    for (const { file, sourcePath, name } of sources) {
      const label = name || (file ? file.replace(/\.md$/, "") : sourcePath);
      const raw = readFileSync(sourcePath, "utf8").replace(/\r\n/g, "\n");
      const { frontmatter } = splitFrontmatterLocal(raw);
      const { data } = parseFlatFrontmatterLocal(frontmatter);
      for (const line of frontmatter.split("\n")) {
        if (!line.trim().startsWith("#")) continue;
        const m = line.match(/maxTurns\s*=\s*(\d+)/);
        if (!m) continue;
        out.push({ name: label, commented: Number(m[1]), actual: data.maxTurns === undefined ? undefined : Number(data.maxTurns) });
      }
    }
    return out;
  }

  it("every commented maxTurns=N matches the field, and at least one such comment exists", () => {
    assert.ok(realAgentSources.length > 0, "derived zero agent sources -- the scan root is wrong");
    const commented = commentedMaxTurns(realAgentSources);
    assert.ok(
      commented.length > 0,
      "no agent frontmatter comment mentions maxTurns=N, so this check iterated nothing and passed vacuously. " +
      "If the justifying comments were removed, remove this assertion too rather than leaving it green over an empty set.",
    );
    const mismatched = commented
      .filter((c) => c.commented !== c.actual)
      .map((c) => `${c.name}: comment says maxTurns=${c.commented}, field says ${c.actual}`);
    assert.deepEqual(
      mismatched, [],
      "a justifying comment disagrees with the value it justifies:\n  " + mismatched.join("\n  ") +
      "\nWhoever changes the number must change the reasoning with it -- a stale justification is worse than none, " +
      "because a reader will trust it.",
    );
  });

  it("falsifiability: a comment naming a different number than the field is reported", () => {
    const tmp = makeTempDir("pp-maxturns-comment-");
    try {
      const p2 = join(tmp, "skewed.md");
      writeFileSync(p2, ["---", "name: skewed", "description: x", "tools: Read", "color: blue", "maxTurns: 6", "# maxTurns=4: stale reasoning left behind", "---", "body", ""].join("\n"), "utf8");
      const found = commentedMaxTurns([{ name: "skewed", sourcePath: p2 }]);
      assert.deepEqual(found, [{ name: "skewed", commented: 4, actual: 6 }], "the skew must be detected, with both numbers reported");
      assert.notEqual(found[0].commented, found[0].actual, "and the two must compare unequal, which is what makes the real-tree assertion fire");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("falsifiability: a comment agreeing with the field is NOT reported", () => {
    const tmp = makeTempDir("pp-maxturns-comment-ok-");
    try {
      const p2 = join(tmp, "aligned.md");
      writeFileSync(p2, ["---", "name: aligned", "description: x", "tools: Read", "color: blue", "maxTurns: 6", "# maxTurns=6: reasoning that matches", "---", "body", ""].join("\n"), "utf8");
      const found = commentedMaxTurns([{ name: "aligned", sourcePath: p2 }]);
      assert.equal(found.length, 1, "the comment must still be found -- otherwise this proves nothing");
      assert.equal(found[0].commented, found[0].actual, "and it must compare equal, so a clean tree does not fire a false positive");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
