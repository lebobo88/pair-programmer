// Unit tests for Fable-5 tier support.
//
// Covers:
//  - isClaudeTier("fable") === true  (map-based, not hardcoded)
//  - CLAUDE_TIER_MODELS.fable === "claude-fable-5"
//  - TIER_ORDER does NOT include "fable"  (fable is off-ladder, no auto-escalation)
//  - shiftTier("opus", 1) === "opus"    (clamps, does NOT reach fable)
//  - shiftTier("opus", 5) === "opus"    (large delta still clamps at opus)
//  - shiftTier("fable", 1) === "fable"  (defensive guard: off-ladder tier unchanged)
//  - shiftTier("fable", -1) === "fable" (same guard, negative delta)
//  - validateTeamSpec accepts a stage with model_tier: "fable"
//  - validateTeamSpec still rejects an unknown tier ("ultra")
//  - deep-reasoning-team.yaml parses, generator tier is fable, judge is NOT fable
//
// Self-contained: no daemon, no MCP, no live LLM calls.

import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import assert from "node:assert/strict";

const SUITE_DIR = mkdtempSync(join(tmpdir(), "pp-fable-tier-"));
mkdirSync(join(SUITE_DIR, ".pair-programmer"), { recursive: true });
process.env.PP_HOME = SUITE_DIR;
process.env.EIGHTS_SKIP_AUDIT_CHECK = "1";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DIST = join(__dirname, "..", "dist");
const importDist = (relPath) => import(pathToFileURL(join(DIST, relPath)).href);

let passed = 0;
let failed = 0;

function record(name, fn) {
  return fn().then(
    () => { console.log(`✓ ${name}`); passed++; },
    (err) => { console.error(`✗ ${name}\n  ${err.message}`); failed++; },
  );
}

await record("isClaudeTier('fable') === true (map-based check)", async () => {
  const { isClaudeTier } = await importDist("config.js");
  assert.equal(isClaudeTier("fable"), true, "fable is a valid ClaudeTier");
});

await record("isClaudeTier still works for existing tiers", async () => {
  const { isClaudeTier } = await importDist("config.js");
  assert.equal(isClaudeTier("opus"), true);
  assert.equal(isClaudeTier("sonnet"), true);
  assert.equal(isClaudeTier("haiku"), true);
  assert.equal(isClaudeTier("ultra"), false, "unknown tier returns false");
  assert.equal(isClaudeTier(""), false, "empty string returns false");
});

await record("isClaudeTier rejects prototype-chain junk (Object.hasOwn guard)", async () => {
  const { isClaudeTier } = await importDist("config.js");
  // `in` operator accepts prototype-chain keys on plain objects; Object.hasOwn must not.
  assert.equal(isClaudeTier("__proto__"), false,
    "'__proto__' must not pass isClaudeTier — prototype pollution vector");
  assert.equal(isClaudeTier("constructor"), false,
    "'constructor' must not pass isClaudeTier");
  assert.equal(isClaudeTier("toString"), false,
    "'toString' must not pass isClaudeTier");
  assert.equal(isClaudeTier("hasOwnProperty"), false,
    "'hasOwnProperty' must not pass isClaudeTier");
  // Sanity: fable still passes after the guard.
  assert.equal(isClaudeTier("fable"), true, "fable must still pass after Object.hasOwn fix");
});

await record("CLAUDE_TIER_MODELS.fable === 'claude-fable-5'", async () => {
  const { CLAUDE_TIER_MODELS } = await importDist("config.js");
  assert.equal(CLAUDE_TIER_MODELS.fable, "claude-fable-5",
    `expected 'claude-fable-5', got '${CLAUDE_TIER_MODELS.fable}'`);
});

await record("COPILOT_CLAUDE_TIER_MODELS.fable === 'claude-fable-5'", async () => {
  const { COPILOT_CLAUDE_TIER_MODELS } = await importDist("config.js");
  assert.equal(COPILOT_CLAUDE_TIER_MODELS.fable, "claude-fable-5",
    `expected 'claude-fable-5', got '${COPILOT_CLAUDE_TIER_MODELS.fable}'`);
});

await record("TIER_ORDER does NOT contain 'fable' (off-ladder, no auto-escalation)", async () => {
  const { TIER_ORDER } = await importDist("config.js");
  assert.ok(!TIER_ORDER.includes("fable"),
    `TIER_ORDER must not contain 'fable': [${TIER_ORDER.join(",")}]`);
  // Ladder must still be the standard three.
  assert.deepEqual([...TIER_ORDER], ["haiku", "sonnet", "opus"],
    "ladder must remain exactly haiku → sonnet → opus");
});

await record("shiftTier('opus', 1) === 'opus' (clamps at top, does NOT reach fable)", async () => {
  const { shiftTier } = await importDist("config.js");
  assert.equal(shiftTier("opus", 1), "opus",
    "shiftTier up from opus must stay at opus, never jump to fable");
});

await record("shiftTier('opus', 5) === 'opus' (large delta still clamps at opus)", async () => {
  const { shiftTier } = await importDist("config.js");
  assert.equal(shiftTier("opus", 5), "opus");
});

await record("shiftTier('fable', 1) === 'fable' (defensive no-op for off-ladder tier)", async () => {
  const { shiftTier } = await importDist("config.js");
  assert.equal(shiftTier("fable", 1), "fable",
    "off-ladder tier must be returned unchanged by shiftTier");
});

await record("shiftTier('fable', -1) === 'fable' (negative delta also a no-op)", async () => {
  const { shiftTier } = await importDist("config.js");
  assert.equal(shiftTier("fable", -1), "fable");
});

await record("shiftTier standard ladder still works correctly", async () => {
  const { shiftTier } = await importDist("config.js");
  assert.equal(shiftTier("haiku", 1), "sonnet");
  assert.equal(shiftTier("sonnet", 1), "opus");
  assert.equal(shiftTier("haiku", -1), "haiku", "clamps at bottom");
  assert.equal(shiftTier("sonnet", -1), "haiku");
});

await record("teams validateTeamSpec accepts model_tier='fable'", async () => {
  const { getTeam } = await importDist("orchestrator/teams.js");
  const project = mkdtempSync(join(tmpdir(), "pp-fable-proj-"));
  const projectTeamsDir = join(project, ".claude", "teams");
  mkdirSync(projectTeamsDir, { recursive: true });
  try {
    writeFileSync(
      join(projectTeamsDir, "test-fable-valid.yaml"),
      `name: test-fable-valid
description: test team with fable tier
stages:
  - kind: code
    gate_type: code_style
    generator: { agent: engineer, primary: claude, model_tier: fable }
    judge:     { tier: cross_vendor, model_pref: codex }
`,
      "utf8",
    );
    const result = getTeam({ name: "test-fable-valid", project_path: project });
    assert.ok(result !== null, "fable-tier team yaml must load without validation error");
    assert.equal(result.team.stages[0].generator.model_tier, "fable");
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

await record("teams validateTeamSpec still rejects unknown tier 'ultra'", async () => {
  const { getTeam } = await importDist("orchestrator/teams.js");
  const project = mkdtempSync(join(tmpdir(), "pp-fable-proj-"));
  const projectTeamsDir = join(project, ".claude", "teams");
  mkdirSync(projectTeamsDir, { recursive: true });
  try {
    writeFileSync(
      join(projectTeamsDir, "test-ultra-invalid.yaml"),
      `name: test-ultra-invalid
description: test team with invalid tier
stages:
  - kind: code
    gate_type: code_style
    generator: { agent: engineer, primary: claude, model_tier: ultra }
    judge:     { tier: cross_vendor }
`,
      "utf8",
    );
    const result = getTeam({ name: "test-ultra-invalid", project_path: project });
    // Validation throws → getTeam falls through → no user/builtin copy → null.
    assert.equal(result, null, "invalid tier 'ultra' must NOT silently load");
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

await record("deep-reasoning-team.yaml parses, generator tier is fable, judge is cross-vendor non-fable", async () => {
  const { getTeam } = await importDist("orchestrator/teams.js");
  const project = mkdtempSync(join(tmpdir(), "pp-fable-proj-"));
  try {
    const result = getTeam({ name: "deep-reasoning-team", project_path: project });
    assert.ok(result !== null, "deep-reasoning-team.yaml must resolve");
    assert.equal(result.origin, "builtin", "must resolve as builtin");
    // name field must match filename stem exactly — required for resolution + listing consistency.
    assert.equal(result.team.name, "deep-reasoning-team",
      `team name field must be 'deep-reasoning-team' (filename stem), got '${result.team.name}'`);

    // All generator stages must use fable tier.
    for (const stage of result.team.stages) {
      if (stage.generator) {
        assert.equal(stage.generator.model_tier, "fable",
          `stage '${stage.kind}' generator must use fable tier`);
      }
    }

    // Every judge in deep-reasoning-team MUST be cross_vendor — same_vendor is
    // not acceptable here because the generator is Fable (Claude) and JUDGE-1
    // mandates cross-vendor at security/spec/design/code gates. The team was
    // authored with cross_vendor on all stages; assert it strictly.
    for (const stage of result.team.stages) {
      if (stage.judge) {
        const modelPref = stage.judge.model_pref ?? "";
        assert.ok(
          !modelPref.includes("fable") && !modelPref.includes("claude"),
          `stage '${stage.kind}' judge model_pref '${modelPref}' must not be fable/claude`,
        );
        assert.equal(
          stage.judge.tier,
          "cross_vendor",
          `stage '${stage.kind}' judge tier must be 'cross_vendor', got '${stage.judge.tier}'`,
        );
      }
    }

    // Confirm a code stage exists with best_of_n_on_major_scope: 2.
    const codeStage = result.team.stages.find(s => s.kind === "code");
    assert.ok(codeStage, "code stage must exist");
    assert.equal(codeStage.best_of_n_on_major_scope, 2,
      "deep-reasoning-team code stage must use best_of_n=2 (cost control)");
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

console.log();
console.log(`${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
