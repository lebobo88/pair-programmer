// Unit tests for the missability check library.
//
// Covers:
//  - P5: hasAiProvenanceFrontmatter accepts an ADR with an `ai_provenance:`
//        YAML frontmatter block carrying at least generator + judge.
//
// Runs against the compiled dist/. Invoked by `npm test`.

import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import assert from "node:assert/strict";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DIST = join(__dirname, "..", "dist");
const importDist = (relPath) => import(pathToFileURL(join(DIST, relPath)).href);

async function testAiProvenanceFrontmatter() {
  const mod = await importDist("orchestrator/missability.js");
  const { hasAiProvenanceFrontmatter } = mod;
  assert.equal(typeof hasAiProvenanceFrontmatter, "function", "export present");

  // Happy path: block-mapping form.
  const adrBlock = [
    "---",
    "status: accepted",
    "ai_provenance:",
    "  generator: claude-opus-4-7",
    "  judge: gemini-3.1-pro-preview",
    "  borda_rank: 1",
    "---",
    "",
    "# ADR-0001 — Adopt Foo",
    "",
    "## Status",
    "accepted",
    "",
    "## Context",
    "Foo was identified as the right substrate after weighing alternatives.",
  ].join("\n");
  assert.equal(
    hasAiProvenanceFrontmatter(adrBlock),
    true,
    "block-mapping form with generator + judge + borda_rank passes",
  );

  // Happy path: inline mapping form.
  const adrInline = [
    "---",
    'ai_provenance: {generator: "claude-opus-4-7", judge: "gemini-3.1-pro-preview"}',
    "---",
    "body",
  ].join("\n");
  assert.equal(hasAiProvenanceFrontmatter(adrInline), true, "inline mapping form passes");

  // Negative: missing judge.
  const missingJudge = [
    "---",
    "ai_provenance:",
    "  generator: claude-opus-4-7",
    "---",
    "body",
  ].join("\n");
  assert.equal(hasAiProvenanceFrontmatter(missingJudge), false, "missing judge → false");

  // Negative: no frontmatter at all.
  assert.equal(hasAiProvenanceFrontmatter("# regular doc\n\nbody"), false, "no frontmatter → false");

  // Negative: frontmatter present but no ai_provenance.
  const noProv = "---\nstatus: accepted\n---\nbody";
  assert.equal(hasAiProvenanceFrontmatter(noProv), false, "frontmatter without ai_provenance → false");

  // Negative: empty input.
  assert.equal(hasAiProvenanceFrontmatter(""), false, "empty → false");
  assert.equal(hasAiProvenanceFrontmatter(null), false, "null → false");

  console.log("✓ hasAiProvenanceFrontmatter: block, inline, negatives all behave (P5)");
}

(async () => {
  try {
    await testAiProvenanceFrontmatter();
    console.log("✓ missability.unit.mjs: all assertions passed");
  } catch (err) {
    console.error("✗ missability.unit.mjs FAILED:", err);
    process.exit(1);
  }
})();
