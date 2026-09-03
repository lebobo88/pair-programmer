// Unit test for R3-tail post-mortem Fix 0.4: team-yaml best_of_n_on_major_scope.
//
// Covers:
//  - feature-team.yaml + bug-fix-team.yaml have the field on the code stage
//  - marketing-team.yaml exists with best_of_n_on_major_scope: 5
//  - validateTeamSpec rejects malformed values (non-int, out-of-range)

import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import assert from "node:assert/strict";

const SUITE_DIR = mkdtempSync(join(tmpdir(), "pp-team-bon-"));
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

await record("feature-team.yaml has best_of_n_on_major_scope=3 on code stage", async () => {
  const { getTeam } = await importDist("orchestrator/teams.js");
  // Use a non-project path so the built-in teams resolution kicks in. PP_HOME
  // only affects ROOT_DIR (where the SQLite DB lives), not team resolution.
  const project = mkdtempSync(join(tmpdir(), "pp-team-bon-proj-"));
  try {
    const result = getTeam({ name: "feature-team", project_path: project });
    assert.ok(result, "feature-team resolved");
    const codeStage = result.team.stages.find(s => s.kind === "code");
    assert.ok(codeStage, "code stage present");
    assert.equal(codeStage.best_of_n_on_major_scope, 3,
      `expected best_of_n_on_major_scope=3 on feature-team code stage, got ${codeStage.best_of_n_on_major_scope}`);
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

await record("bug-fix-team.yaml has best_of_n_on_major_scope=3 on code stage", async () => {
  const { getTeam } = await importDist("orchestrator/teams.js");
  const project = mkdtempSync(join(tmpdir(), "pp-team-bon-proj-"));
  try {
    const result = getTeam({ name: "bug-fix-team", project_path: project });
    assert.ok(result, "bug-fix-team resolved");
    const codeStage = result.team.stages.find(s => s.kind === "code");
    assert.ok(codeStage, "code stage present");
    assert.equal(codeStage.best_of_n_on_major_scope, 3);
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

await record("marketing-team.yaml has best_of_n_on_major_scope=5 on code stage", async () => {
  const { getTeam } = await importDist("orchestrator/teams.js");
  const project = mkdtempSync(join(tmpdir(), "pp-team-bon-proj-"));
  try {
    const result = getTeam({ name: "marketing-team", project_path: project });
    assert.ok(result, "marketing-team resolved");
    const codeStage = result.team.stages.find(s => s.kind === "code");
    assert.ok(codeStage, "code stage present");
    assert.equal(codeStage.best_of_n_on_major_scope, 5,
      "marketing-team's code stage should use 5-way fanout — seed diversity matters most here");
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

await record("malformed best_of_n_on_major_scope is rejected by validation", async () => {
  // Since #32 (J8), getTeam REFUSES to fall through on a malformed
  // project-scope override: it throws rather than resolving a different
  // team of the same name from user or built-in scope. Silent fallthrough
  // was the old behavior and is the bug this asserts against.
  const { getTeam } = await importDist("orchestrator/teams.js");
  const project = mkdtempSync(join(tmpdir(), "pp-team-bon-proj-"));
  const projectTeamsDir = join(project, ".claude", "teams");
  mkdirSync(projectTeamsDir, { recursive: true });
  try {
    writeFileSync(
      join(projectTeamsDir, "test-bad-bon.yaml"),
      `name: test-bad-bon
description: malformed BoN
stages:
  - kind: code
    gate_type: code_style
    generator: { agent: engineer, primary: claude }
    judge:     { tier: cross_vendor }
    best_of_n_on_major_scope: 99
`,
      "utf8",
    );
    assert.throws(
      () => getTeam({ name: "test-bad-bon", project_path: project }),
      (err) => {
        assert.match(
          String(err && err.message),
          /best_of_n_on_major_scope=99/,
          "the refusal must name the offending value",
        );
        assert.match(
          String(err && err.message),
          /Refusing to fall through to another scope/,
          "the refusal must state that no other scope will be substituted",
        );
        return true;
      },
      "malformed yaml must NOT silently load and must NOT fall through",
    );
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

console.log();
console.log(`${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
