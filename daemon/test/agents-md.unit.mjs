// Unit tests for the AGENTS.md / CLAUDE.md orchestrator. Verifies:
//  - ensureAgentsMd / ensureClaudeMd scaffold under template, are idempotent
//  - applyAgentsMdPatch update/append/create semantics
//  - Idempotency: re-applying an append with the same Run `<id>` block no-ops
//  - agentsMdStatus reports populated sections, line count, adherence cliff
//  - CLAUDE.md template imports AGENTS.md via @-syntax

import { strict as assert } from "node:assert";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Point the daemon DB at a temp path BEFORE importing anything that touches it.
const tmpRoot = mkdtempSync(join(tmpdir(), "pp-agents-md-"));
process.env.PP_DB_PATH = join(tmpRoot, "pp.db");
process.env.PP_HOME = tmpRoot;

const distUrl = (rel) =>
  pathToFileURL(join(__dirname, "..", "dist", rel)).href;

const { ensureAgentsMd, ensureClaudeMd, ensureAgentsAndClaudeMd, applyAgentsMdPatch, agentsMdStatus, allSectionBodies, AGENTS_MD_SECTIONS } =
  await import(distUrl("orchestrator/agents-md.js"));
const { db } = await import(distUrl("db/database.js"));

// Insert a fake run so the FK in agents_md_patches is satisfied.
function seedRun(runId) {
  db()
    .prepare(
      `INSERT INTO runs(id, project_path, request_text, mode, status, started_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(runId, tmpRoot, "test", "single", "running", new Date().toISOString());
}

let pass = 0;
let fail = 0;
function it(label, fn) {
  try {
    fn();
    pass++;
    console.log(`✓ ${label}`);
  } catch (err) {
    fail++;
    console.error(`✗ ${label}`);
    console.error(`  ${err.stack || err.message}`);
  }
}

// ─── scaffold ──────────────────────────────────────────────────────────────

const projectA = mkdtempSync(join(tmpRoot, "projA-"));

it("ensureAgentsMd creates AGENTS.md when absent", () => {
  const r = ensureAgentsMd(projectA);
  assert.equal(r.created, true);
  assert.ok(existsSync(r.path));
  const text = readFileSync(r.path, "utf8");
  for (const section of AGENTS_MD_SECTIONS) {
    assert.ok(text.includes(`## ${section}`), `missing section: ${section}`);
  }
});

it("ensureAgentsMd is idempotent (created=false on second call)", () => {
  const r = ensureAgentsMd(projectA);
  assert.equal(r.created, false);
});

it("ensureClaudeMd writes a CLAUDE.md that imports AGENTS.md", () => {
  const r = ensureClaudeMd(projectA);
  assert.equal(r.created, true);
  const text = readFileSync(r.path, "utf8");
  assert.match(text, /^@AGENTS\.md/m, "CLAUDE.md must start the import on its own line");
});

it("ensureAgentsAndClaudeMd creates both in one call", () => {
  const projectB = mkdtempSync(join(tmpRoot, "projB-"));
  const r = ensureAgentsAndClaudeMd(projectB, { profile: "web-ui" });
  assert.equal(r.agents.created, true);
  assert.equal(r.claude.created, true);
  const text = readFileSync(r.agents.path, "utf8");
  assert.ok(text.includes("profile: `web-ui`"));
});

it("ensureAgentsMd seeds conventions + build_commands when provided", () => {
  const projectC = mkdtempSync(join(tmpRoot, "projC-"));
  ensureAgentsMd(projectC, {
    profile: "api-platform",
    build_commands: ["`pnpm install`", "`pnpm test`"],
    conventions: ["Use 2-space indentation"],
  });
  const text = readFileSync(join(projectC, "AGENTS.md"), "utf8");
  assert.ok(text.includes("`pnpm install`"));
  assert.ok(text.includes("Use 2-space indentation"));
});

// ─── patch ─────────────────────────────────────────────────────────────────

const runId = "run_amd_test_001";
seedRun(runId);

it("applyAgentsMdPatch update overwrites the section body", () => {
  const r = applyAgentsMdPatch({
    run_id: runId,
    project_path: projectA,
    section: "Coding conventions",
    kind: "update",
    content_md: "- Use tabs, fight me.",
  });
  assert.equal(r.status, "applied");
  const text = readFileSync(join(projectA, "AGENTS.md"), "utf8");
  assert.ok(text.includes("Use tabs, fight me."));
});

it("applyAgentsMdPatch append concatenates after existing content", () => {
  const content = `Run \`${runId}\` touched section 11 (architecture).`;
  const r1 = applyAgentsMdPatch({
    run_id: runId,
    project_path: projectA,
    section: "Notes from the harness",
    kind: "append",
    content_md: content,
  });
  assert.equal(r1.status, "applied");
  // Second identical append → idempotent no-op.
  const r2 = applyAgentsMdPatch({
    run_id: runId,
    project_path: projectA,
    section: "Notes from the harness",
    kind: "append",
    content_md: content,
  });
  assert.equal(r2.status, "noop_already_applied");
  // The Run line should appear exactly once.
  const text = readFileSync(join(projectA, "AGENTS.md"), "utf8");
  const occurrences = text.split(`Run \`${runId}\``).length - 1;
  assert.equal(occurrences, 1, `expected 1 occurrence of run header, got ${occurrences}`);
});

// Regression guard for the idempotency defect: "Notes from the harness" is a
// history-class section, so the body is redirected to docs/agents-md-history.md
// and only a breadcrumb lands in AGENTS.md. Before the fix the guard inspected
// ONLY the AGENTS.md section body, which was always empty for this section, so
// re-appends were double-written to the history file forever.
it("append to a history-class section leaves a breadcrumb and does not double-write history", () => {
  const runId2 = "run_amd_test_hist";
  seedRun(runId2);
  const content = `Run \`${runId2}\` sealed \`dec_abc\` for the record.`;
  const r1 = applyAgentsMdPatch({
    run_id: runId2,
    project_path: projectA,
    section: "Notes from the harness",
    kind: "append",
    content_md: content,
  });
  assert.equal(r1.status, "applied");
  const historyPath = join(projectA, "docs", "agents-md-history.md");
  assert.ok(existsSync(historyPath), "history file should exist");
  const hist1 = readFileSync(historyPath, "utf8");
  assert.equal(hist1.split(`Run \`${runId2}\``).length - 1, 1, "history should carry the run header once");
  // Breadcrumb in AGENTS.md is what makes the guard reachable at all.
  const agents = readFileSync(join(projectA, "AGENTS.md"), "utf8");
  assert.ok(
    agents.includes(`Run \`${runId2}\``) && agents.includes("agents-md-history.md"),
    "AGENTS.md should carry a breadcrumb pointing at the history file",
  );
  // Second identical append: no-op, and history must NOT grow.
  const r2 = applyAgentsMdPatch({
    run_id: runId2,
    project_path: projectA,
    section: "Notes from the harness",
    kind: "append",
    content_md: content,
  });
  assert.equal(r2.status, "noop_already_applied");
  const hist2 = readFileSync(historyPath, "utf8");
  assert.equal(hist2, hist1, "history file must be byte-identical after a no-op re-append");
});

it("applyAgentsMdPatch create adds a new heading when missing", () => {
  const r = applyAgentsMdPatch({
    run_id: runId,
    project_path: projectA,
    section: "Coding conventions", // existing — this should also work
    kind: "create",
    content_md: "- Replaced via create kind.",
  });
  assert.equal(r.status, "applied");
});

// ─── status ────────────────────────────────────────────────────────────────

it("agentsMdStatus reports populated sections and line count", () => {
  const s = agentsMdStatus(projectA);
  assert.equal(s.agents_md.exists, true);
  assert.equal(s.claude_md.exists, true);
  assert.equal(s.claude_md.imports_agents_md, true);
  assert.ok(s.agents_md.line_count > 0);
  const conventions = s.agents_md.sections.find(x => x.section === "Coding conventions");
  assert.ok(conventions, "Coding conventions section should be in status");
  assert.equal(conventions.populated, true);
});

it("agentsMdStatus flags over_adherence_cliff when AGENTS.md exceeds 200 lines", () => {
  const projectD = mkdtempSync(join(tmpRoot, "projD-"));
  ensureAgentsMd(projectD);
  // Pad with 250 lines via append to one of the canonical sections.
  const padding = Array.from({ length: 250 }, (_, i) => `- line ${i}`).join("\n");
  writeFileSync(
    join(projectD, "AGENTS.md"),
    readFileSync(join(projectD, "AGENTS.md"), "utf8") + "\n" + padding,
  );
  const s = agentsMdStatus(projectD);
  assert.equal(s.agents_md.over_adherence_cliff, true);
});

it("agentsMdStatus on a project without AGENTS.md returns exists=false", () => {
  const projectE = mkdtempSync(join(tmpRoot, "projE-"));
  const s = agentsMdStatus(projectE);
  assert.equal(s.agents_md.exists, false);
  assert.equal(s.claude_md.exists, false);
  assert.equal(s.agents_md.line_count, null);
});


// Regression guard for the run-id PREFIX collision in runHeaderRe().
//
// The idempotency guard matches a `Run <id>` header. Without a trailing
// non-identifier boundary, a short run id is a prefix of a longer one, so
// `run_ab` matches inside `run_abcd` and a legitimately NEW append from
// run_abcd is silently suppressed as an already-applied no-op. That is a
// data-loss bug, not a cosmetic one: the second run genuinely never records
// its contribution. Flagged by a cross-vendor judge on run_tYE0v6WrwFWs.
it("append from a prefix-colliding run id is NOT swallowed as a no-op", () => {
  const projP = mkdtempSync(join(tmpRoot, "proj-prefix-"));
  ensureAgentsMd(projP);
  const shortId = "run_ab";
  const longId = "run_abcd";   // shortId is a strict prefix of longId
  seedRun(shortId);
  seedRun(longId);

  const BT = String.fromCharCode(96);   // backtick, written without an escape
  const NL = String.fromCharCode(10);   // newline, written without an escape
  const patch = (runId) => ({
    run_id: runId,
    project_path: projP,
    section: "Notes from the harness",
    kind: "append",
    content_md: ["Run " + BT + runId + BT, "", "- did a thing.", ""].join(NL),
  });

  assert.equal(applyAgentsMdPatch(patch(shortId)).status, "applied");
  // identical re-append must still no-op (the behaviour the boundary must not break)
  assert.equal(applyAgentsMdPatch(patch(shortId)).status, "noop_already_applied");
  // the LONGER id must be treated as a distinct run, not swallowed by the prefix
  assert.equal(
    applyAgentsMdPatch(patch(longId)).status,
    "applied",
    "run_abcd must apply even though run_ab is already recorded — a prefix match " +
      "here silently discards the longer run's contribution",
  );
});


// Regression guard for the CROSS-SECTION false no-op in the history fallback.
//
// History-class appends are redirected to docs/agents-md-history.md. The
// idempotency guard used to match the run header against the ENTIRE history
// file, so a header recorded under one section suppressed a legitimately new
// append to a DIFFERENT section — silently discarding it. No run-id boundary
// can fix that, because the collision is cross-section. The guard now matches
// only the requested section, across all of its (repeated) blocks.
// Flagged by a cross-vendor judge on run_tYE0v6WrwFWs.
it("history fallback does not no-op across different sections", () => {
  const projX = mkdtempSync(join(tmpRoot, "proj-xsect-"));
  ensureAgentsMd(projX);
  const runId = "run_xsect";
  seedRun(runId);
  const BT = String.fromCharCode(96);
  const NL = String.fromCharCode(10);
  const body = ["### R1 (round one)", "", "Run " + BT + runId + BT, "", "- an entry.", ""].join(NL);

  // Both sections REDIRECT to history: the "### R1 (" prefix matches
  // HISTORY_CONTENT_RE. Note precisely what that does and does not mean --
  // the redirect runs, but the history-read FALLBACK does not: sectionBody()
  // is non-empty because the section ships with scaffolded prose, so the || in
  // applyAgentsMdPatch short-circuits before the read. What this guard proves
  // is that the redirect path keeps sections independent, not that the
  // fallback read was exercised. allSectionBodies is tested directly below.
  const first = applyAgentsMdPatch({
    run_id: runId, project_path: projX, section: "Notes from the harness",
    kind: "append", content_md: body,
  });
  assert.equal(first.status, "applied");

  // Same run id, DIFFERENT section: must apply, not be swallowed by the
  // header already present under the first section.
  const second = applyAgentsMdPatch({
    run_id: runId, project_path: projX, section: "Engineering Standards",
    kind: "append", content_md: body,
  });
  assert.equal(
    second.status,
    "applied",
    "an append to a different section must not be suppressed by a run header " +
      "recorded under an unrelated section",
  );

  // And the original section must still be idempotent.
  const repeat = applyAgentsMdPatch({
    run_id: runId, project_path: projX, section: "Notes from the harness",
    kind: "append", content_md: body,
  });
  assert.equal(repeat.status, "noop_already_applied");
});

// Direct unit tests for allSectionBodies().
//
// WHY DIRECT, not through applyAgentsMdPatch: the history fallback is reached
// only when sectionBody(AGENTS.md) is EMPTY. The scaffolded "Notes from the
// harness" section ships with boilerplate prose, so that conjunct is false in
// practice and the fallback is near-unreachable end-to-end -- idempotency really
// runs off the breadcrumb the redirect writes into AGENTS.md. An end-to-end
// assertion therefore cannot exercise this function, which is exactly why the
// previous version of this guard was inefficacious. Testing the helper directly
// is the honest way to pin its behaviour.
it("allSectionBodies isolates a section under both LF and CRLF", () => {
  const CR = String.fromCharCode(13);
  const LF = String.fromCharCode(10);
  for (const [label, eol] of [["LF", LF], ["CRLF", CR + LF]]) {
    const doc = ["## Alpha", "", "Run alpha-one", "", "## Beta", "", "Run beta-one", ""].join(eol);
    const alpha = allSectionBodies(doc, "Alpha");
    const beta = allSectionBodies(doc, "Beta");
    assert.ok(/Run alpha-one/.test(alpha), label + ": Alpha body not found");
    assert.ok(
      !/Run beta-one/.test(alpha),
      label + ": Alpha body leaked Beta content -- a cross-section match here causes a false no-op",
    );
    assert.ok(/Run beta-one/.test(beta), label + ": Beta body not found");
  }
});

// appendToHistory() writes a FRESH "## <section>" heading per entry, so the same
// section legitimately recurs. Returning only the first block would MISS a run
// header recorded in a later block and wrongly re-apply an applied patch.
it("allSectionBodies collects every repeated block for a section", () => {
  const LF = String.fromCharCode(10);
  const doc = [
    "## Notes", "", "Run one", "",
    "## Other", "", "noise", "",
    "## Notes", "", "Run two", "",
  ].join(LF);
  const body = allSectionBodies(doc, "Notes");
  assert.ok(/Run one/.test(body), "first block missing");
  assert.ok(/Run two/.test(body), "repeated block missing -- a later run header would be ignored");
  assert.ok(!/noise/.test(body), "unrelated section leaked in");
});

it("allSectionBodies returns empty for an absent section", () => {
  assert.equal(allSectionBodies("## A" + String.fromCharCode(10) + "x", "Missing"), "");
});


// ─── teardown ──────────────────────────────────────────────────────────────

try { rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* ignore */ }
console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
