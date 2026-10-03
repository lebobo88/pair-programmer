/**
 * command-model-policy.unit.mjs — Phase M (GitHub #54, epic #42)
 *
 * Guards which `/pp:*` slash commands carry a `model:` override, and why.
 *
 * ── WHY THIS NEEDS A GUARD ──────────────────────────────────────────────────
 *
 * A `model:` line in a command's frontmatter is four words that silently change
 * which model runs, and its two failure modes are both quiet:
 *
 *   - **Copy-paste inheritance.** A new command created from `budget.md` as a
 *     template inherits `model: haiku` along with everything else. If that
 *     command dispatches work rather than rendering a table, the whole turn
 *     runs on Haiku — see the turn-scope note below.
 *   - **Silent conversion of an interpretive command.** Nothing about
 *     `/pp:status` announces that it renders a run tree and decides what to
 *     elide. Adding `model: haiku` to it would degrade output with no error.
 *
 * So the converted set is asserted here, exactly, and the held set is asserted
 * to have stayed held.
 *
 * ── THE TURN-SCOPE FACT THAT BOUNDS THE WHOLE PHASE ─────────────────────────
 *
 * Per the frontmatter reference, a command's `model` "applies for the rest of
 * the current turn and is not saved to settings; the session model resumes on
 * your next prompt". It is NOT scoped to the render. Anything else that happens
 * in the invoking turn also runs on the overridden model, which is why the rule
 * below is "one tool call and a table", not "read-only".
 *
 * ── AND WHY "READ-ONLY" WAS THE WRONG WORD ──────────────────────────────────
 *
 * The plan and issue #54 both called these "the eight read-only render
 * commands". Seven are. `/pp:master` calls `ensure_master_plan`, which WRITES
 * `PROJECT_MASTER.md` when absent — an idempotent scaffold whose template the
 * daemon owns, so a weaker model cannot corrupt it, but a write nonetheless.
 * The write-tool scan below is what surfaced that, and it is kept so the
 * description cannot drift back.
 *
 * ANTI-STALL: self-contained. Reads files, parses frontmatter. No daemon, no
 * MCP peer, no network, no SQLite.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  readFileSync as readFileSyncRaw,
  readdirSync,
  existsSync,
  mkdtempSync,
  writeFileSync,
  rmSync,
} from "node:fs";
import { join, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

// Tracked files arrive CRLF on any checkout with core.autocrlf=true (the
// Windows default). Normalize once, at the only place the bytes enter this
// file, so every scan below can assume LF. This SHADOWS the node:fs import
// deliberately: it covers every existing call site without editing any of
// them, and it means a new read has to go out of its way (via
// readFileSyncRaw) to bypass it.
//
// What actually breaks without this, established by running it: a pattern
// carrying an explicit \n (/^---\n/ on a frontmatter block) and .split("\n"),
// which leaves a trailing \r on every element. A bare /^heading$/m anchor is
// NOT affected -- CR is itself a LineTerminator in ECMAScript, so $ matches
// before it. Do not "fix" an anchor thinking that was the cause.
//
// Only \r\n is collapsed. A lone \r never comes out of a git checkout, and
// rewriting one would silently alter a literal carriage return inside a
// scanned source file, which some scans here assert on. Buffer reads (no
// encoding) pass through untouched.
//
// Proved by the "read boundary is line-ending agnostic" suite at the bottom of
// this file.
function readFileSync(p, enc) {
  const raw = readFileSyncRaw(p, enc);
  return typeof raw === "string" ? raw.replace(/\r\n/g, "\n") : raw;
}

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const CMD_DIR = join(REPO_ROOT, ".claude", "commands", "pp");
const MIRROR_DIR = join(REPO_ROOT, ".github", "commands", "pp");

/**
 * Commands that carry `model: haiku`. Each is one MCP call rendered as a fixed
 * table or list — the model formats and does nothing else.
 */
const CONVERTED = ["budget", "profile", "rubrics", "taxonomy", "teams"];

/**
 * Commands deliberately NOT converted, with the reason each. Issue #54 named
 * three as doing more than formatting and said to watch them; converting them
 * without running the output-equivalence check would assert an equivalence
 * nobody measured.
 */
const HELD = {
  status: "renders a run tree and decides what to elide — interpretive",
  checklist: "derives 15 pass/fail items across two tool calls — interpretive",
  master: "interpretive AND not read-only: calls ensure_master_plan, which writes PROJECT_MASTER.md",
};

/**
 * Harness tools a converted command is allowed to call: the ones that only
 * READ.
 *
 * ── AN ALLOWLIST, NOT A DENYLIST, AND THAT INVERSION IS THE POINT ───────────
 *
 * The first version of this file listed the ~31 tools that MUTATE and checked
 * that a converted command called none of them. A cross-vendor judge found the
 * list incomplete — `artifact_validate` persists rows, `analyze_autogenesis`
 * inserts proposals, `visual_regression_diff` writes a report, the three
 * `request_*` bridges emit envelopes, and Phase L's generated `hook_*` adapters
 * write SQLite. None are reachable from today's five converted commands, so
 * nothing was actually wrong in the tree; the GUARD was wrong, in the direction
 * that matters least visibly.
 *
 * Lengthening the denylist would have fixed those five omissions and left the
 * class intact: every new mutating tool added to `harness-server.ts` silently
 * widens the hole again, and nothing fails when it does. Inverting it closes
 * the class. **An unknown tool now fails the guard**, so the cost of forgetting
 * is a red test rather than a command that mutates state under a model the
 * operator did not choose.
 *
 * The price is that adding a genuinely read-only tool to a converted command
 * requires adding it here. That is the correct direction for the cost to fall.
 */
const READ_ONLY_TOOLS = [
  "budget_status",
  "completion_checklist",
  "constitution_status",
  "doctor",
  "gate_eligible_judges",
  "get_artifact_validation",
  "get_builtin_profile",
  "get_claude_tier_models",
  "get_copilot_claude_tier_models",
  "get_design_template",
  "get_forum",
  "get_profile",
  "get_rubric",
  "get_run",
  "get_stage_finalize_readiness",
  "get_tdd_check",
  "hydra_envelope_query",
  "list_design_templates",
  "list_evolution_proposals",
  "list_forums",
  "list_missability_checks",
  "list_prior_critiques",
  "list_profiles",
  "list_rubrics",
  "list_runs",
  "list_taxonomy_sections",
  "loop_ceiling_status",
  "master_plan_status",
  "replay",
  "team_get",
  "team_list",
  "triage_request",
];

/** Tool identifiers that indicate the command delegates work to a sub-agent. */
const DISPATCH_MARKERS = ["Task(", "Task tool", "subagent_type", "Agent tool", "mcp__pp_harness__start_best_of_stage"];

function readCommand(name) {
  const p = join(CMD_DIR, `${name}.md`);
  if (!existsSync(p)) return null;
  const src = readFileSync(p, "utf8");
  const m = src.match(/^---\n([\s\S]*?)\n---/);
  return { path: p, src, frontmatter: m ? m[1] : "", body: m ? src.slice(m[0].length) : src };
}

/** The `model:` value, ignoring YAML comment lines. */
function modelOf(frontmatter) {
  for (const line of frontmatter.split("\n")) {
    if (/^\s*#/.test(line)) continue;
    const m = line.match(/^model:\s*(\S+)/);
    if (m) return m[1];
  }
  return null;
}

function harnessToolsIn(src) {
  return [...new Set([...src.matchAll(/mcp__pp_harness__([a-z_]+)/g)].map(m => m[1]))];
}

/**
 * THE policy check, as one function.
 *
 * Returns `{ tools, notAllowed, dispatch }` for a command's source text.
 *
 * ── WHY THIS EXISTS AS A FUNCTION ───────────────────────────────────────────
 *
 * The first version of this file did the filtering inline in the real test AND
 * again inline in each falsification fixture. A cross-vendor judge caught that
 * four of six fixtures therefore "test JavaScript's `Array.prototype.filter` on
 * synthetic data" — delete the real test's logic and those four stay green. It
 * also caught that the surrounding prose claimed they drove the same functions,
 * which was true of two of them and not the rest.
 *
 * That is vacuity class 3, and this repo has now shipped it three times: in
 * Phase K's guard, in Phase L's, and here. The structural remedy is already
 * written into `AGENTS.md` — one named function, called by both paths — and this
 * is that remedy applied rather than restated.
 */
function commandPolicyViolations(src) {
  const tools = harnessToolsIn(src);
  return {
    tools,
    notAllowed: tools.filter(t => !READ_ONLY_TOOLS.includes(t)),
    dispatch: DISPATCH_MARKERS.filter(mk => src.includes(mk)),
  };
}

const ALL_COMMANDS = existsSync(CMD_DIR)
  ? readdirSync(CMD_DIR).filter(f => f.endsWith(".md")).map(f => basename(f, ".md"))
  : [];

describe("command model policy (Phase M, GitHub #54)", () => {
  test("the command directory is populated (non-vacuity)", () => {
    assert.ok(existsSync(CMD_DIR), `${CMD_DIR} not found`);
    assert.ok(
      ALL_COMMANDS.length >= 15,
      `only ${ALL_COMMANDS.length} pp commands found; every per-command assertion below would be ` +
        `checking almost nothing`,
    );
  });

  test("exactly the intended commands carry a model override", () => {
    const withModel = ALL_COMMANDS
      .map(n => ({ n, model: modelOf(readCommand(n).frontmatter) }))
      .filter(x => x.model !== null);

    assert.deepEqual(
      withModel.map(x => x.n).sort(),
      [...CONVERTED].sort(),
      "the set of pp commands declaring `model:` must be exactly the converted set. A command that " +
        "acquired one by copy-paste inherits it for the WHOLE invoking turn, not just its render.",
    );
    for (const { n, model } of withModel) {
      assert.equal(model, "haiku", `${n} declares model: ${model}; the phase converts to haiku only`);
    }
  });

  test("every converted command is one-tool-call-and-a-table: no writes, no Task dispatch", () => {
    let checked = 0;
    for (const name of CONVERTED) {
      const cmd = readCommand(name);
      assert.ok(cmd, `${name}.md is missing but listed as converted`);
      checked += 1;

      const { tools, notAllowed, dispatch } = commandPolicyViolations(cmd.src);
      assert.ok(
        tools.length > 0,
        `${name} references no pp_harness tool — either it is not a renderer, or this scan is broken ` +
          `and the write check below is inspecting nothing`,
      );

      assert.deepEqual(
        notAllowed,
        [],
        `${name} calls ${JSON.stringify(notAllowed)}, which is not on the read-only allowlist. A converted ` +
          `command must only read: the model override covers the rest of the turn, so a write performed ` +
          `under it is a write on a model the operator did not choose. If the tool genuinely only reads, ` +
          `add it to READ_ONLY_TOOLS deliberately — the allowlist fails closed on purpose.`,
      );

      assert.deepEqual(
        dispatch,
        [],
        `${name} appears to delegate work (${JSON.stringify(dispatch)}). The model override applies for ` +
          `the rest of the turn, so a command that dispatches must not carry one.`,
      );
    }
    assert.equal(checked, CONVERTED.length, "not every converted command was checked");
  });

  test("the held commands stayed held, each for a recorded reason", () => {
    let checked = 0;
    for (const [name, reason] of Object.entries(HELD)) {
      const cmd = readCommand(name);
      assert.ok(cmd, `${name}.md is missing but listed as held`);
      checked += 1;
      assert.equal(
        modelOf(cmd.frontmatter),
        null,
        `${name} acquired a model override. Issue #54 names it as doing more than formatting: ${reason}. ` +
          `Converting it asserts an output equivalence that has not been measured.`,
      );
      assert.ok(reason.length > 20, `${name}'s hold reason must state the reason, not restate the rule`);
    }
    assert.equal(checked, Object.keys(HELD).length, "not every held command was checked");
  });

  test("/pp:master really does write, which is why it is not in the converted set", () => {
    // Pins the classification error the plan and the issue both carried:
    // "the eight read-only render commands" was wrong for this one. If a future
    // change makes /pp:master genuinely read-only, this test fails and the
    // decision gets revisited deliberately rather than by drift.
    const cmd = readCommand("master");
    assert.ok(cmd, "master.md is missing");
    const tools = harnessToolsIn(cmd.src);
    assert.ok(
      tools.includes("ensure_master_plan"),
      "/pp:master no longer calls ensure_master_plan. The 'not read-only' rationale for holding it back " +
        "no longer applies — re-evaluate the hold rather than deleting this test.",
    );
    assert.equal(modelOf(cmd.frontmatter), null, "/pp:master must not carry a model override");
  });

  test("the Copilot mirror does NOT carry model:, and that is deliberate", () => {
    // `renderCommand` in scripts/sync-copilot-assets.mjs rebuilds mirror
    // frontmatter from an allowlist (name/description/argument-hint/
    // allowed-tools), so `model:` is dropped by construction. That is correct —
    // `model:` is a Claude Code frontmatter field and its meaning in the
    // Copilot runtime is unverified, exactly the assumption Phase L refused to
    // make about mcp_tool in hooks.json. Asserted so the divergence is a
    // recorded decision rather than a surprise to whoever next diffs the two.
    assert.ok(existsSync(MIRROR_DIR), `${MIRROR_DIR} not found — run scripts/sync-copilot-assets.mjs`);
    let checked = 0;
    for (const name of CONVERTED) {
      const p = join(MIRROR_DIR, `${name}.md`);
      assert.ok(existsSync(p), `mirror missing for ${name}`);
      const src = readFileSync(p, "utf8");
      const m = src.match(/^---\n([\s\S]*?)\n---/);
      assert.ok(m, `mirror for ${name} has no frontmatter`);
      checked += 1;
      assert.equal(
        modelOf(m[1]),
        null,
        `the Copilot mirror for ${name} carries model:, which the sync's frontmatter allowlist should ` +
          `have dropped. Its meaning in that runtime is unverified.`,
      );
      // The rationale must still reach the mirror, or a Copilot-side reader
      // sees a command that differs from its source with no explanation.
      assert.match(
        src,
        /Phase M \(issue #54\)/,
        `the mirror for ${name} lost the frontmatter rationale; the sync preserves YAML comments into the ` +
          `body precisely so the reasoning survives the frontmatter rebuild`,
      );
    }
    assert.equal(checked, CONVERTED.length, "not every mirror was checked");
  });

  test("READ_ONLY_TOOLS names no tool that mutates (spot-check against known writers)", () => {
    // The allowlist fails closed, so its own contents are the one place a
    // mistake still lets a write through. These are tools whose names read like
    // reads and which write — `ensure_*` is the trap that started this — plus
    // the ones the judge named. If any appears on the allowlist, the inversion
    // has been undone by someone adding a tool without checking it.
    const KNOWN_WRITERS = [
      "ensure_master_plan", "ensure_agents_md", "ensure_constitution", "ensure_run",
      "artifact_validate", "analyze_autogenesis", "visual_regression_diff", "visual_regression_capture",
      "request_strategic_framing", "request_brand_review", "request_visual_advisory",
      "record_attempt", "record_verdict", "archive_artifact", "janitor", "force_unlock",
    ];
    const leaked = KNOWN_WRITERS.filter(t => READ_ONLY_TOOLS.includes(t));
    assert.deepEqual(leaked, [], `READ_ONLY_TOOLS contains mutating tool(s): ${JSON.stringify(leaked)}`);
    assert.ok(READ_ONLY_TOOLS.length > 10, "the allowlist is suspiciously short — did it get truncated?");
    assert.ok(
      !READ_ONLY_TOOLS.some(t => t.startsWith("hook_")),
      "Phase L's generated hook_* adapters write SQLite and are invoked by the hook dispatcher, never by " +
        "a command; none may be allowlisted",
    );
  });

  // ── Falsification ───────────────────────────────────────────────────────
  //
  // The first version of this file had none, and the judge was right to call
  // that out: every other guard in this campaign proves it can go red. These
  // drive the SAME functions the real assertions use, on fixture text, so a
  // red fixture is evidence about the check rather than about JavaScript.
  describe("falsification", () => {
    test("modelOf reads a real value, ignores comments, and reports absence as null", () => {
      assert.equal(modelOf("description: x\nmodel: haiku\n"), "haiku");
      assert.equal(modelOf("description: x\n"), null, "absence must be null, not a default");
      assert.equal(
        modelOf("description: x\n# model: haiku is explained here\n"),
        null,
        "a commented model: line must NOT count — the frontmatter banner this phase adds discusses " +
          "`model:` at length, and counting that would flag every converted command's own rationale",
      );
      // An INDENTED `model:` is not a top-level YAML key, so it is not a model
      // override at all, and reporting it as absent is correct rather than a
      // miss. This fixture originally asserted the opposite and failed — the
      // function was right and the expectation was wrong, which is the useful
      // direction for a falsification test to fail in.
      assert.equal(
        modelOf("generator:\n  model: sonnet\n"),
        null,
        "an indented model: is a nested key, not a command-level override, and must not be read as one",
      );
    });

    test("harnessToolsIn finds tools and returns empty rather than throwing", () => {
      assert.deepEqual(harnessToolsIn("call `mcp__pp_harness__budget_status` then stop"), ["budget_status"]);
      assert.deepEqual(
        harnessToolsIn("mcp__pp_harness__get_run and mcp__pp_harness__get_run again"),
        ["get_run"],
        "duplicates must collapse",
      );
      assert.deepEqual(harnessToolsIn("no tools here"), []);
    });

    // These four now drive `commandPolicyViolations` — the same function the
    // real per-command test calls. Before, they filtered inline, so deleting
    // the real check would have left them green.
    test("a write tool in a converted command is caught by the allowlist", () => {
      const { notAllowed } = commandPolicyViolations("call `mcp__pp_harness__ensure_master_plan` to scaffold");
      assert.deepEqual(notAllowed, ["ensure_master_plan"], "the write must be reported as not allowed");
    });

    test("an UNKNOWN tool is caught too — the property a denylist could not have", () => {
      // The whole reason for inverting. A tool that does not exist yet, or one
      // added to harness-server.ts after this file was last touched, fails
      // closed instead of passing unnoticed.
      const { notAllowed } = commandPolicyViolations("call `mcp__pp_harness__some_future_tool` here");
      assert.deepEqual(
        notAllowed,
        ["some_future_tool"],
        "an unrecognised tool must fail the allowlist; under the old denylist it would have passed",
      );
    });

    test("a legitimate read-only command produces no finding (contrast case)", () => {
      // Without this, every assertion above could be passing because the filter
      // rejects everything.
      const v = commandPolicyViolations("call `mcp__pp_harness__budget_status` with $ARGUMENTS");
      assert.deepEqual(v.notAllowed, [], "a read-only tool must not be reported");
      assert.deepEqual(v.dispatch, [], "prose with no dispatch marker must not be reported");
      assert.deepEqual(v.tools, ["budget_status"], "the tool must actually have been found");
    });

    test("each dispatch marker is individually detectable through the real function", () => {
      for (const mk of DISPATCH_MARKERS) {
        const { dispatch } = commandPolicyViolations(`prose before ${mk} prose after`);
        assert.ok(dispatch.includes(mk), `dispatch marker ${mk} was not detected`);
      }
      const clean = commandPolicyViolations("a command that only renders a table");
      assert.deepEqual(clean.dispatch, [], "text with no marker must report none");
    });
  });

  test("the converted commands document the turn-scope of the override", () => {
    // The single most misunderstandable fact about this change: `model:` is not
    // scoped to the render. A future maintainer reading only the frontmatter
    // should not have to find the docs to learn that.
    for (const name of CONVERTED) {
      const cmd = readCommand(name);
      assert.match(
        cmd.frontmatter,
        /rest of the current turn/,
        `${name}'s frontmatter must state that the override applies for the rest of the turn, not just ` +
          `the render`,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// The read boundary is line-ending agnostic.
//
// This file scans tracked repo files. Git checks those out CRLF wherever
// core.autocrlf=true, the default on Windows, so a fresh clone delivers
// different bytes than a working tree whose files happen to have been written
// LF -- and an LF working file hashes to the same blob, so `git status` stays
// clean and nothing reveals the difference. Nineteen assertions across three
// guards passed for exactly that reason and failed on the next checkout.
//
// The two constructs that actually break are used here as the discriminator,
// each asserted in BOTH directions -- raw CRLF must fail it, normalized must
// pass it -- so "nothing survived" and "nothing needed to" stay
// distinguishable:
//
//   * a pattern with an explicit \n in it (/^---\n/), and
//   * .split("\n"), which leaves a trailing \r on every element.
//
// A bare /^heading$/m anchor is deliberately NOT used: CR is a LineTerminator
// in ECMAScript, so $ already matches before it and such an anchor would pass
// unnormalized -- a vacuous proof. Cross-vendor judge finding, agy
// gemini-3.8-flash-medium, MEDIUM, on the first version of this suite.
//
// Deleting the .replace in readFileSync turns three assertions here red.
// ---------------------------------------------------------------------------
describe("the read boundary is line-ending agnostic", () => {
  test("a CRLF file read through readFileSync arrives LF", () => {
    const dir = mkdtempSync(join(tmpdir(), "crlf-read-"));
    try {
      const f = join(dir, "sample.md");
      writeFileSync(f, "---\r\nmodel: haiku\r\n---\r\n\r\nbody\r\n", "utf8");

      // The fixture genuinely carries the condition being denied.
      const raw = readFileSyncRaw(f, "utf8");
      assert.ok(raw.includes("\r\n"), "fixture precondition: the file on disk must actually be CRLF");

      const text = readFileSync(f, "utf8");
      assert.ok(!text.includes("\r"), "readFileSync must strip CR from a CRLF file");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("an explicit-\\n pattern fails on the raw bytes and passes after normalization", () => {
    const dir = mkdtempSync(join(tmpdir(), "crlf-read-"));
    try {
      const f = join(dir, "sample.md");
      writeFileSync(f, "---\r\nmodel: haiku\r\n---\r\n\r\nbody\r\n", "utf8");
      const frontmatter = /^---\n([\s\S]*?)\n---/;

      assert.ok(
        !frontmatter.test(readFileSyncRaw(f, "utf8")),
        "the condition denied must be reachable: a \\n pattern must MISS the raw CRLF bytes",
      );
      assert.ok(
        frontmatter.test(readFileSync(f, "utf8")),
        "the same pattern must match once the read normalizes -- this is the defect the helper prevents",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('.split("\\n") leaves a trailing CR on the raw bytes and none after normalization', () => {
    const dir = mkdtempSync(join(tmpdir(), "crlf-read-"));
    try {
      const f = join(dir, "sample.md");
      writeFileSync(f, "---\r\nmodel: haiku\r\n---\r\n\r\nbody\r\n", "utf8");

      assert.equal(
        readFileSyncRaw(f, "utf8").split("\n")[1],
        "model: haiku\r",
        "the condition denied must be reachable: a raw split must strand a CR",
      );
      assert.equal(
        readFileSync(f, "utf8").split("\n")[1],
        "model: haiku",
        "a normalized split must yield the bare line",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a Buffer read (no encoding) is passed through untouched", () => {
    const dir = mkdtempSync(join(tmpdir(), "crlf-read-"));
    try {
      const f = join(dir, "sample.bin");
      writeFileSync(f, "a\r\nb\r\n", "utf8");
      const buf = readFileSync(f);
      assert.ok(Buffer.isBuffer(buf), "no encoding must still yield a Buffer");
      assert.equal(buf.toString("utf8"), "a\r\nb\r\n", "Buffer bytes must not be rewritten");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
