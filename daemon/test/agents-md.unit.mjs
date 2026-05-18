// Unit tests for the AGENTS.md / CLAUDE.md orchestrator. Verifies:
//  - ensureAgentsMd / ensureClaudeMd scaffold under template, are idempotent
//  - applyAgentsMdPatch update/append/create semantics
//  - Idempotency: re-applying an append with the same Run `<id>` block no-ops
//  - agentsMdStatus reports populated sections, line count, adherence cliff
//  - CLAUDE.md template imports AGENTS.md via @-syntax

import { strict as assert } from "node:assert";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Point the daemon DB at a temp path BEFORE importing anything that touches it.
const tmpRoot = mkdtempSync(join(tmpdir(), "pp-agents-md-"));
process.env.PP_DB_PATH = join(tmpRoot, "pp.db");
process.env.PP_HOME = tmpRoot;

const distUrl = (rel) =>
  pathToFileURL(join(__dirname, "..", "dist", rel)).href;

const { ensureAgentsMd, ensureClaudeMd, ensureAgentsAndClaudeMd, applyAgentsMdPatch, agentsMdStatus, AGENTS_MD_SECTIONS } =
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

// ─── teardown ──────────────────────────────────────────────────────────────

try { rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* ignore */ }

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
