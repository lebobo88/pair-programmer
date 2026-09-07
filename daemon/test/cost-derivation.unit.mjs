// Phase H (GitHub #49, epic #42) — GitHub #58: pricing not applied, and
// vendor critique spend has no ingestion path.
//
// R15: recordAttempt derives cost_usd when the caller omits it; an explicit
// 0 is respected verbatim (the undefined-vs-0 distinction is the whole of
// this bug — §1.5/D1 of spec.md).
// R16/R16a: cost-tally persists instead of only console.log'ing, and never
// double-counts against recordAttempt's own tally.
// R17/D4: computeCost applies the same isPriceEntry guard
// mergeMissingBundledRates already uses, so a hit inside `_pricing_notes`
// (model-id-shaped keys holding STRING values) returns 0, never NaN — and
// the fix is independent of JSON key order, not merely masked by it.
// R28: exactly one writer tallies a given vendor call's spend, on every
// path, not only the `direct_cli` backstop.
//
// ANTI-STALL TEST RULE: self-contained, temp SQLite via PP_HOME, imports
// from dist/, no live daemon, no MCP peer, no network.

import { strict as assert } from "node:assert";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";

/** Recursive *.md finder — avoids node:fs globSync (Node 22+ only; this
 * project targets Node 20+ per AGENTS.md). */
function findMarkdownFiles(dir) {
  const out = [];
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...findMarkdownFiles(full));
    else if (entry.isFile() && entry.name.endsWith(".md")) out.push(full);
  }
  return out;
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const DIST = join(__dirname, "..", "dist");
const SRC = join(__dirname, "..", "src");
const REPO_ROOT = join(__dirname, "..", "..");
const INDEX_JS = join(DIST, "index.js");

const SUITE_DIR = mkdtempSync(join(tmpdir(), "pp-cost-derivation-"));
mkdirSync(join(SUITE_DIR, ".pair-programmer"), { recursive: true });
process.env.PP_HOME = SUITE_DIR;
process.env.EIGHTS_SKIP_AUDIT_CHECK = "1";

const importDist = (relPath) => import(pathToFileURL(join(DIST, relPath)).href);

const { db } = await importDist("db/database.js");
const { recordAttempt, budgetStatus } = await importDist("orchestrator/runs.js");
const { computeCost } = await importDist("util/prices.js");
const { writeExecutionEvent, tallySuccessSpend, deriveCallKey } = await importDist("orchestrator/execution-events.js");

let passed = 0;
let failed = 0;
const failures = [];

function it(label, fn) {
  try {
    fn();
    passed++;
    console.log(`✓ ${label}`);
  } catch (err) {
    failed++;
    failures.push(label);
    console.error(`✗ ${label}`);
    console.error(`  ${err.stack ?? err.message}`);
  }
}

let seq = 0;
function freshId(prefix) {
  seq += 1;
  return `${prefix}_${Date.now().toString(36)}${seq}${randomBytes(3).toString("hex")}`;
}

function seedRunAndStage() {
  const runId = freshId("run");
  const project = mkdtempSync(join(tmpdir(), "pp-cost-proj-"));
  db()
    .prepare(`INSERT INTO runs(id, project_path, request_text, mode, status, started_at) VALUES (?, ?, ?, 'single', 'running', ?)`)
    .run(runId, project, "(cost-derivation fixture)", new Date().toISOString());
  const stageId = freshId("stage");
  db()
    .prepare(`INSERT INTO stages(id, run_id, kind, gate_type, status, started_at) VALUES (?, ?, 'code', 'code_style', 'open', ?)`)
    .run(stageId, runId, new Date().toISOString());
  return { runId, stageId, project };
}

function runHookChild(event, name, payload, extraEnv = {}) {
  return spawnSync(process.execPath, [INDEX_JS, "hook", event, name], {
    input: JSON.stringify(payload ?? {}),
    env: { ...process.env, PP_HOME: SUITE_DIR, EIGHTS_SKIP_AUDIT_CHECK: "1", ...extraEnv },
    encoding: "utf8",
    timeout: 20_000,
  });
}

// ═══════════════════════════════════════════════════════════════════════
// R15/AC-H37-H40 — recordAttempt derives cost; explicit 0 respected
// ═══════════════════════════════════════════════════════════════════════

it("AC-H37: recordAttempt with tokens and NO cost_usd derives attempts.cost_usd via computeCost — computed, never transcribed", () => {
  const { stageId } = seedRunAndStage();
  const expected = computeCost("claude-sonnet-5", 1_000_000, 1_000_000);
  assert.ok(expected > 0, "sanity: claude-sonnet-5 must be a priced model for this assertion to be meaningful");
  const { attempt_id } = recordAttempt({
    stage_id: stageId, producer: "claude", model_id: "claude-sonnet-5",
    tokens_in: 1_000_000, tokens_out: 1_000_000,
  });
  const row = db().prepare(`SELECT cost_usd FROM attempts WHERE id = ?`).get(attempt_id);
  assert.equal(row.cost_usd, expected);
});

it("AC-H38: budgetStatus('run:<id>').cost_usd equals that same computed value and is strictly greater than 0", () => {
  const { runId, stageId } = seedRunAndStage();
  const expected = computeCost("claude-sonnet-5", 2_000_000, 500_000);
  recordAttempt({ stage_id: stageId, producer: "claude", model_id: "claude-sonnet-5", tokens_in: 2_000_000, tokens_out: 500_000 });
  const status = budgetStatus(`run:${runId}`);
  assert.ok(status, "a budgets row must exist for this run scope");
  assert.equal(status.cost_usd, expected);
  assert.ok(status.cost_usd > 0);
});

it("AC-H39: an explicit cost_usd:0 with positive tokens is stored as EXACTLY 0 (R15a — undefined vs 0 is the only signal)", () => {
  const { stageId } = seedRunAndStage();
  const { attempt_id } = recordAttempt({
    stage_id: stageId, producer: "claude", model_id: "claude-sonnet-5",
    tokens_in: 500_000, tokens_out: 500_000, cost_usd: 0,
  });
  const row = db().prepare(`SELECT cost_usd FROM attempts WHERE id = ?`).get(attempt_id);
  assert.equal(row.cost_usd, 0);
});

it("AC-H40: an unpriced model_id with positive tokens stores cost 0, not NaN", () => {
  const { stageId } = seedRunAndStage();
  const { attempt_id } = recordAttempt({
    stage_id: stageId, producer: "claude", model_id: "model-that-is-not-in-the-price-table",
    tokens_in: 1000, tokens_out: 1000,
  });
  const row = db().prepare(`SELECT cost_usd FROM attempts WHERE id = ?`).get(attempt_id);
  assert.equal(row.cost_usd, 0);
  assert.ok(!Number.isNaN(row.cost_usd));
});

it("AC-H-A5: recordAttempt given tokens and NO cost_usd produces a NON-ZERO budget row for a priced model — the assertion that would have failed before Phase H", () => {
  const { runId, stageId } = seedRunAndStage();
  recordAttempt({ stage_id: stageId, producer: "claude", model_id: "claude-opus-5", tokens_in: 100_000, tokens_out: 100_000 });
  const status = budgetStatus(`run:${runId}`);
  assert.ok(status && status.cost_usd > 0, "#58's first half: tokens accumulate; cost must NOT stay 0");
});

// ═══════════════════════════════════════════════════════════════════════
// R17/D4/AC-H41-H42 — computeCost skips non-vendor blocks, never NaN
// ═══════════════════════════════════════════════════════════════════════

it("AC-H41/D4: computeCost returns a finite, non-NaN number for every model-id-shaped key in prices.json's _pricing_notes block — iterated from the actually-parsed file, non-empty", () => {
  const pricesPath = join(REPO_ROOT, "daemon", "prices.json");
  const raw = JSON.parse(readFileSync(pricesPath, "utf8"));
  assert.ok(raw._pricing_notes && typeof raw._pricing_notes === "object", "_pricing_notes block must exist in the parsed file");
  const allNoteKeys = Object.keys(raw._pricing_notes);
  // Model-id-shaped: lowercase alnum/dot/dash, no wildcard "*", not a
  // leading-underscore prose key like _legacy_retained.
  const modelIdShaped = allNoteKeys.filter(k => /^[a-z][a-z0-9.-]*$/.test(k));
  const rejected = allNoteKeys.filter(k => !modelIdShaped.includes(k));
  assert.ok(modelIdShaped.length > 0, "R23: the iterated collection (model-id-shaped _pricing_notes keys) must be non-empty");
  // R27.1: this filter silently discards the wildcard/prose keys — assert
  // EXACTLY what it discards, and that the discard is deliberate, not
  // incidental. A new wildcard key added later without updating this list
  // fails loudly here instead of being silently absorbed.
  assert.deepEqual(
    rejected.slice().sort(),
    ["_legacy_retained", "gemini-3.7-flash-*", "gemini-3.8-flash-*"].slice().sort(),
    `the model-id-shaped filter must reject EXACTLY the wildcard/prose keys, got rejected=[${rejected.join(", ")}]`,
  );
  for (const modelId of modelIdShaped) {
    const result = computeCost(modelId, 1_000_000, 1_000_000);
    assert.equal(typeof result, "number", `computeCost("${modelId}", ...) must return a number`);
    assert.ok(!Number.isNaN(result), `computeCost("${modelId}", ...) must not be NaN — D4's exact latent finding`);
  }
});

it("R25 falsifiability (direct, on the production symbol): computeCost returns 0 (not NaN) for a model_id that exists ONLY as a string-valued _pricing_notes entry with NO vendor-block counterpart — proves isPriceEntry, the REAL production guard, rejects the exact shape D4 describes, driven through a fresh child process rather than a hand-rolled `str.input` surrogate", () => {
  const noteOnlyHome = mkdtempSync(join(tmpdir(), "pp-cost-noteonly-"));
  mkdirSync(join(noteOnlyHome, ".pair-programmer"), { recursive: true });
  writeFileSync(
    join(noteOnlyHome, ".pair-programmer", "prices.json"),
    JSON.stringify({
      _pricing_notes: { "model-that-only-exists-as-a-note": "CONSERVATIVE PLACEHOLDER — no vendor block entry exists for this id" },
    }),
    "utf8",
  );
  const probe = `
    (async () => {
      const { pathToFileURL } = await import("node:url");
      const { computeCost } = await import(pathToFileURL(${JSON.stringify(join(DIST, "util", "prices.js"))}).href);
      process.stdout.write(String(computeCost("model-that-only-exists-as-a-note", 1000000, 1000000)));
    })();
  `;
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", probe], {
    env: { ...process.env, PP_HOME: noteOnlyHome, EIGHTS_SKIP_AUDIT_CHECK: "1" }, encoding: "utf8",
  });
  assert.equal(child.status, 0, `child failed: ${child.stderr}`);
  const result = Number(child.stdout);
  assert.ok(!Number.isNaN(result), "computeCost must not return NaN for a note-only string entry — D4's exact latent finding, proven on the real isPriceEntry guard");
  assert.equal(result, 0, "a note-only entry has no numeric rate, so cost must be exactly 0, not a guessed/derived number");
});

it("AC-H42: computeCost returns the VENDOR-BLOCK rate, not the notes-block string, for claude-opus-5 even when a hand-built table puts _pricing_notes BEFORE the vendor block — proves the fix is isPriceEntry, not JSON key order", () => {
  // Two child processes, each with its OWN PP_HOME (and therefore its own
  // freshly-seeded prices.json), so the module-level price cache in the
  // parent process is never touched by this test.
  const normalOrderHome = mkdtempSync(join(tmpdir(), "pp-cost-normal-"));
  mkdirSync(join(normalOrderHome, ".pair-programmer"), { recursive: true });
  writeFileSync(
    join(normalOrderHome, ".pair-programmer", "prices.json"),
    JSON.stringify({ anthropic: { "claude-opus-5": { input: 15, output: 75 } } }),
    "utf8",
  );

  const reversedOrderHome = mkdtempSync(join(tmpdir(), "pp-cost-reversed-"));
  mkdirSync(join(reversedOrderHome, ".pair-programmer"), { recursive: true });
  // _pricing_notes appears FIRST in the object — JSON.parse preserves
  // insertion order for string keys, so Object.keys(table) yields
  // _pricing_notes before anthropic here.
  writeFileSync(
    join(reversedOrderHome, ".pair-programmer", "prices.json"),
    JSON.stringify({
      _pricing_notes: { "claude-opus-5": "CONSERVATIVE PLACEHOLDER — reversed-order fixture" },
      anthropic: { "claude-opus-5": { input: 15, output: 75 } },
    }),
    "utf8",
  );

  const probe = `
    (async () => {
      const { pathToFileURL } = await import("node:url");
      const { computeCost } = await import(pathToFileURL(${JSON.stringify(join(DIST, "util", "prices.js"))}).href);
      process.stdout.write(String(computeCost("claude-opus-5", 1000000, 1000000)));
    })();
  `;
  const normalChild = spawnSync(process.execPath, ["--input-type=module", "-e", probe], {
    env: { ...process.env, PP_HOME: normalOrderHome, EIGHTS_SKIP_AUDIT_CHECK: "1" }, encoding: "utf8",
  });
  const reversedChild = spawnSync(process.execPath, ["--input-type=module", "-e", probe], {
    env: { ...process.env, PP_HOME: reversedOrderHome, EIGHTS_SKIP_AUDIT_CHECK: "1" }, encoding: "utf8",
  });
  assert.equal(normalChild.status, 0, `normal-order child failed: ${normalChild.stderr}`);
  assert.equal(reversedChild.status, 0, `reversed-order child failed: ${reversedChild.stderr}`);

  const normalResult = Number(normalChild.stdout);
  const reversedResult = Number(reversedChild.stdout);
  assert.ok(!Number.isNaN(normalResult) && normalResult > 0, "normal-order lookup must succeed");
  assert.ok(!Number.isNaN(reversedResult), "reversed-order lookup must not be NaN — this is the key-order-independence proof");
  assert.equal(reversedResult, normalResult, "the reversed-key-order table must produce the IDENTICAL rate — proves isPriceEntry, not key order, is what fixed D4");
});

// ═══════════════════════════════════════════════════════════════════════
// R15d/AC-H43 — no agent mirror instructs a literal zero cost
// ═══════════════════════════════════════════════════════════════════════

/** Shared by AC-H43 and its R25 falsifiability companion — the SAME
 * function drives both, so the falsifiability case proves the scanner
 * itself, not String.prototype.includes on the poisoned buffer directly. */
function scanFilesForLiteral(files, literal) {
  const offenders = [];
  for (const f of files) {
    const text = readFileSync(f, "utf8");
    if (text.includes(literal)) offenders.push(f);
  }
  return offenders;
}

it("AC-H43: no .claude/agents/**/*.md file instructs passing a literal zero cost_usd (fragment-assembled; non-empty file collection)", () => {
  const agentsDir = join(REPO_ROOT, ".claude", "agents");
  const files = findMarkdownFiles(agentsDir);
  assert.ok(files.length > 0, "R23: the iterated file collection must be non-empty");
  // The literal phrase the pre-Phase-H contract text used, assembled from
  // fragments so this guard's own source doesn't contain it contiguously.
  const literal = "0 for " + "native " + "Claude " + "authoring";
  const offenders = scanFilesForLiteral(files, literal);
  assert.deepEqual(offenders, [], `file(s) still instruct a literal zero cost: ${offenders.join(", ")}`);
});

it("R25 falsifiability: the AC-H43 scanner DOES flag a synthetic file containing the forbidden phrase — routed through the SAME scanFilesForLiteral function AC-H43 uses, against a REAL file on disk, not a String.prototype.includes stand-in", () => {
  const literal = "0 for " + "native " + "Claude " + "authoring";
  const poisonDir = mkdtempSync(join(tmpdir(), "pp-cost-poison-agent-"));
  const poisonedFile = join(poisonDir, "poisoned.md");
  writeFileSync(poisonedFile, `pass cost_usd (${literal}) when recording.`, "utf8");
  const offenders = scanFilesForLiteral([poisonedFile], literal);
  assert.deepEqual(offenders, [poisonedFile], "the scanner must flag the synthetic file containing the forbidden phrase");
});

// ═══════════════════════════════════════════════════════════════════════
// R16/R16a/AC-H44 — cost-tally persists, delta-based, no double count
// ═══════════════════════════════════════════════════════════════════════

it("AC-H44: cost-tally driven with a direct_cli response carrying tokens+cost adds EXACTLY that cost once — captured pre-value, delta-based", () => {
  const { runId, project } = seedRunAndStage();
  const scope = `run:${runId}`;
  const before = budgetStatus(scope);
  const beforeCost = before ? before.cost_usd : 0;

  const res = runHookChild("PostToolUse", "cost-tally", {
    hook_event_name: "PostToolUse", tool_name: "mcp__pp_codex__critique", cwd: project, session_id: freshId("s"), prompt_id: freshId("p"),
    tool_response: { direct_cli: true, tokens_in: 10_000, tokens_out: 4_000, cost_usd: 0.42, model: "gpt-5.6-terra" },
  });
  assert.equal(res.status, 0, `cost-tally child must exit 0: ${res.stderr}`);

  const after = budgetStatus(scope);
  assert.ok(after, "a budgets row must now exist for this run");
  assert.ok(Math.abs(after.cost_usd - (beforeCost + 0.42)) < 1e-9, `expected delta of exactly one call's cost (0.42), got ${after.cost_usd - beforeCost}`);
});

it("AC-H44 mutation-equivalent: replaying the SAME cost-tally call (same session/tool/prompt_id) a second time adds ZERO further delta — idempotent on call_key, not on direct_cli alone", () => {
  const { runId, project } = seedRunAndStage();
  const scope = `run:${runId}`;
  const sessionId = freshId("s-replay");
  const promptId = freshId("p-replay");
  const payload = {
    hook_event_name: "PostToolUse", tool_name: "mcp__pp_agy__critique", cwd: project, session_id: sessionId, prompt_id: promptId,
    tool_response: { direct_cli: true, tokens_in: 1000, tokens_out: 1000, cost_usd: 0.05, model: "gemini-3.8-flash-medium" },
  };
  runHookChild("PostToolUse", "cost-tally", payload);
  const afterFirst = budgetStatus(scope);
  runHookChild("PostToolUse", "cost-tally", payload); // byte-identical replay
  const afterSecond = budgetStatus(scope);
  assert.equal(afterSecond.cost_usd, afterFirst.cost_usd, "a replayed identical hook call must add zero additional delta");
});

// ═══════════════════════════════════════════════════════════════════════
// R28/AC-H-A9 — exactly one writer tallies a given vendor call's spend
// ═══════════════════════════════════════════════════════════════════════

it("R28/AC-H-A9: a vendor (codex/agy) call's spend, driven through BOTH cost-tally AND a subsequent record_attempt with the same tokens, tallies exactly ONE call's cost — not two", () => {
  const { runId, stageId, project } = seedRunAndStage();
  const scope = `run:${runId}`;
  const before = budgetStatus(scope);
  const beforeCost = before ? before.cost_usd : 0;

  // First writer: the cost-tally PostToolUse hook, observing the real
  // pp_codex tool-response envelope.
  const res = runHookChild("PostToolUse", "cost-tally", {
    hook_event_name: "PostToolUse", tool_name: "mcp__pp_codex__critique", cwd: project, session_id: freshId("s"), prompt_id: freshId("p"),
    tool_response: { tokens_in: 20_000, tokens_out: 8_000, cost_usd: 0.9, model: "gpt-5.6-terra" },
  });
  assert.equal(res.status, 0);
  const afterHook = budgetStatus(scope);
  assert.ok(afterHook && Math.abs(afterHook.cost_usd - (beforeCost + 0.9)) < 1e-9, "cost-tally must tally its own call");

  // Second writer: an agent-driven record_attempt for the SAME underlying
  // vendor call (producer="codex"), carrying the identical tokens.
  // R28.1/R28's producer-domain split: recordAttempt MUST skip its OWN
  // budget tally for producer "codex"/"agy", because cost-tally already
  // owns that spend — the two writers' domains are disjoint by producer.
  recordAttempt({ stage_id: stageId, producer: "codex", model_id: "gpt-5.6-terra", tokens_in: 20_000, tokens_out: 8_000, cost_usd: 0.9 });
  const afterBoth = budgetStatus(scope);
  assert.equal(
    afterBoth.cost_usd, afterHook.cost_usd,
    `record_attempt for a codex/agy producer must add ZERO further budget delta (cost-tally already owns it) — got delta ${afterBoth.cost_usd - afterHook.cost_usd}`,
  );

  // The attempts row itself still carries the real cost — R15's derivation
  // half is unaffected; only the BUDGET TALLY is skipped for vendor CLI
  // producers (R28's comment in runs.ts).
  const attemptRow = db().prepare(`SELECT cost_usd FROM attempts WHERE stage_id = ? ORDER BY created_at DESC LIMIT 1`).get(stageId);
  assert.equal(attemptRow.cost_usd, 0.9, "the attempts row must still carry the accurate cost even though the tally was skipped");
});

it("R28: a 'claude' producer's record_attempt spend IS tallied normally (cost-tally never observes a non-vendor-CLI call)", () => {
  const { runId, stageId } = seedRunAndStage();
  const scope = `run:${runId}`;
  const before = budgetStatus(scope);
  const beforeCost = before ? before.cost_usd : 0;
  recordAttempt({ stage_id: stageId, producer: "claude", model_id: "claude-sonnet-5", tokens_in: 10_000, tokens_out: 10_000 });
  const after = budgetStatus(scope);
  assert.ok(after.cost_usd > beforeCost, "a claude-producer attempt must still be tallied by recordAttempt itself");
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.error(`\nFAILED: ${failures.join(", ")}`);
}
process.exit(failed === 0 ? 0 : 1);
