// J8 — team yaml `judge:` overrides (model / reasoning_effort / escalate) and
// the loud-validation contract for getTeam.
//
// Covers:
//  - a valid judge override block loads and round-trips onto the TeamSpec
//  - judge.model outside the vendor allow-list is rejected, and the message
//    names the stage, the id, AND the allow-list
//  - judge.reasoning_effort outside JUDGE_REASONING_EFFORTS is rejected
//  - agy + reasoning_effort "xhigh" is rejected (vendor serves low|medium|high)
//  - judge.model together with judge.escalate:true is rejected (ambiguous)
//  - judge.tier typos are rejected (previously unvalidated)
//  - judge.escalate non-boolean is rejected
//  - a BROKEN PROJECT yaml named like a builtin (bug-fix-team) THROWS with
//    origin "project" instead of silently falling through to the builtin
//  - a YAML *parse* failure still falls through (tolerated, warned)
//  - listTeams does not throw on a bad file
//  - every shipped .claude/teams/*.yaml still loads through getTeam
//
// Self-contained: no daemon, no MCP, no live LLM calls.

import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readdirSync } from "node:fs";

const SUITE_DIR = mkdtempSync(join(tmpdir(), "pp-team-judge-"));
mkdirSync(join(SUITE_DIR, ".pair-programmer"), { recursive: true });
process.env.PP_HOME = SUITE_DIR;
process.env.EIGHTS_SKIP_AUDIT_CHECK = "1";

// HERMETICITY: teams.js computes USER_TEAMS_DIR from homedir() at module-load
// time and resolution order is project → user → builtin. On a machine with a
// pp user-scope install, ~/.claude/teams would shadow the builtin copies and
// make the fallthrough assertions meaningless. Point homedir() at an empty
// temp dir BEFORE teams.js is imported (all imports below are lazy).
const FAKE_HOME = join(SUITE_DIR, "fake-home");
mkdirSync(join(FAKE_HOME, ".claude", "teams"), { recursive: true });
process.env.HOME = FAKE_HOME;
process.env.USERPROFILE = FAKE_HOME;

const __dirname = dirname(fileURLToPath(import.meta.url));
const DIST = join(__dirname, "..", "dist");
const REPO_ROOT = join(__dirname, "..", "..");
const importDist = (rel) => import(pathToFileURL(join(DIST, rel)).href);

/** Build a throwaway project dir containing .claude/teams/<name>.yaml. */
function projectWith(name, yamlText) {
  const project = mkdtempSync(join(tmpdir(), "pp-tj-proj-"));
  const dir = join(project, ".claude", "teams");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${name}.yaml`), yamlText, "utf8");
  return project;
}

function stageYaml(name, judgeInline) {
  return `name: ${name}
description: J8 fixture
stages:
  - kind: code
    gate_type: code_style
    generator: { agent: engineer, primary: claude }
    judge:     ${judgeInline}
`;
}

test("valid judge overrides load and round-trip onto the TeamSpec", async () => {
  const { getTeam } = await importDist("orchestrator/teams.js");
  const project = projectWith(
    "tj-valid",
    stageYaml("tj-valid", "{ tier: cross_vendor, model_pref: codex, model: gpt-5.6-sol, reasoning_effort: high }"),
  );
  try {
    const res = getTeam({ name: "tj-valid", project_path: project });
    assert.ok(res, "valid override yaml must load");
    assert.equal(res.origin, "project");
    assert.equal(res.team.stages[0].judge.model, "gpt-5.6-sol");
    assert.equal(res.team.stages[0].judge.reasoning_effort, "high");
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

test("escalate:true alone (no model) is a valid override", async () => {
  const { getTeam } = await importDist("orchestrator/teams.js");
  const project = projectWith(
    "tj-escalate",
    stageYaml("tj-escalate", "{ tier: cross_vendor, model_pref: agy, escalate: true }"),
  );
  try {
    const res = getTeam({ name: "tj-escalate", project_path: project });
    assert.ok(res);
    assert.equal(res.team.stages[0].judge.escalate, true);
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

test("judge.model outside the allow-list is rejected, message names stage + id + allow-list", async () => {
  const { getTeam } = await importDist("orchestrator/teams.js");
  const { JUDGE_MODEL_POLICY } = await importDist("config.js");
  const project = projectWith(
    "tj-bad-model",
    stageYaml("tj-bad-model", "{ tier: cross_vendor, model_pref: codex, model: gpt-4o-turbo }"),
  );
  try {
    assert.throws(
      () => getTeam({ name: "tj-bad-model", project_path: project }),
      (err) => {
        assert.equal(err.name, "TeamSpecValidationError", `unexpected error: ${err.message}`);
        assert.match(err.message, /stage "code"/, "message must name the stage");
        assert.match(err.message, /gt-4o-turbo|gpt-4o-turbo/, "message must name the rejected id");
        for (const allowed of JUDGE_MODEL_POLICY.codex.allowed_models) {
          assert.ok(err.message.includes(allowed), `message must list allow-listed model ${allowed}`);
        }
        return true;
      },
    );
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

test("an agy model under model_pref: codex is rejected (vendor-scoped allow-list)", async () => {
  const { getTeam } = await importDist("orchestrator/teams.js");
  const project = projectWith(
    "tj-wrong-vendor",
    stageYaml("tj-wrong-vendor", "{ tier: cross_vendor, model_pref: codex, model: gemini-3.8-flash-medium }"),
  );
  try {
    assert.throws(
      () => getTeam({ name: "tj-wrong-vendor", project_path: project }),
      /not an allowed codex judge model/,
    );
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

test("judge.reasoning_effort outside the vocabulary is rejected", async () => {
  const { getTeam } = await importDist("orchestrator/teams.js");
  const project = projectWith(
    "tj-bad-effort",
    stageYaml("tj-bad-effort", "{ tier: cross_vendor, model_pref: codex, reasoning_effort: extreme }"),
  );
  try {
    assert.throws(
      () => getTeam({ name: "tj-bad-effort", project_path: project }),
      (err) => {
        assert.equal(err.name, "TeamSpecValidationError");
        assert.match(err.message, /reasoning_effort/);
        assert.match(err.message, /low \| medium \| high \| xhigh/);
        return true;
      },
    );
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

test("agy + reasoning_effort 'xhigh' is rejected (agy allowed_efforts stops at high)", async () => {
  const { getTeam } = await importDist("orchestrator/teams.js");
  const project = projectWith(
    "tj-agy-xhigh",
    stageYaml("tj-agy-xhigh", "{ tier: cross_vendor, model_pref: agy, reasoning_effort: xhigh }"),
  );
  try {
    assert.throws(
      () => getTeam({ name: "tj-agy-xhigh", project_path: project }),
      /which agy does not serve/,
    );
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

test("judge.model together with escalate:true is rejected as ambiguous", async () => {
  const { getTeam } = await importDist("orchestrator/teams.js");
  const project = projectWith(
    "tj-both",
    stageYaml("tj-both", "{ tier: cross_vendor, model_pref: codex, model: gpt-5.6-luna, escalate: true }"),
  );
  try {
    assert.throws(
      () => getTeam({ name: "tj-both", project_path: project }),
      /ambiguous/i,
    );
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

test("judge.escalate must be a boolean", async () => {
  const { getTeam } = await importDist("orchestrator/teams.js");
  const project = projectWith(
    "tj-escalate-str",
    stageYaml("tj-escalate-str", '{ tier: cross_vendor, model_pref: codex, escalate: "yes" }'),
  );
  try {
    assert.throws(
      () => getTeam({ name: "tj-escalate-str", project_path: project }),
      /judge\.escalate=.*Must be a boolean/s,
    );
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

test("judge.tier typo is rejected (previously unvalidated)", async () => {
  const { getTeam } = await importDist("orchestrator/teams.js");
  const project = projectWith(
    "tj-bad-tier",
    stageYaml("tj-bad-tier", "{ tier: cross-vendor, model_pref: codex }"),
  );
  try {
    assert.throws(
      () => getTeam({ name: "tj-bad-tier", project_path: project }),
      (err) => {
        assert.equal(err.name, "TeamSpecValidationError");
        assert.match(err.message, /judge\.tier="cross-vendor"/);
        assert.match(err.message, /"cross_vendor" \| "same_vendor"/);
        return true;
      },
    );
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

test("a broken PROJECT yaml does NOT fall through to the builtin team of the same name", async () => {
  const { getTeam } = await importDist("orchestrator/teams.js");
  // Sanity: the builtin bug-fix-team must exist, otherwise this test is vacuous.
  const emptyProject = mkdtempSync(join(tmpdir(), "pp-tj-empty-"));
  try {
    const builtin = getTeam({ name: "bug-fix-team", project_path: emptyProject });
    assert.ok(builtin, "builtin bug-fix-team must resolve for this test to mean anything");
    assert.equal(builtin.origin, "builtin");
  } finally {
    rmSync(emptyProject, { recursive: true, force: true });
  }

  const project = projectWith(
    "bug-fix-team",
    stageYaml("bug-fix-team", "{ tier: cross_vendor, model_pref: codex, model: gpt-9000-imaginary }"),
  );
  try {
    assert.throws(
      () => getTeam({ name: "bug-fix-team", project_path: project }),
      (err) => {
        assert.equal(err.name, "TeamSpecValidationError");
        assert.match(err.message, /invalid project team yaml/, "message must name the origin");
        assert.ok(err.message.includes(project), "message must name the offending path");
        return true;
      },
      "a bad project yaml must throw, NOT silently return the builtin team",
    );
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

test("a YAML parse failure still falls through to the builtin", async () => {
  const { getTeam } = await importDist("orchestrator/teams.js");
  // Unbalanced flow mapping → YAML.parse throws (not a validation error).
  const project = projectWith(
    "bug-fix-team",
    "name: bug-fix-team\ndescription: broken\nstages: [ { kind: code\n",
  );
  try {
    const res = getTeam({ name: "bug-fix-team", project_path: project });
    assert.ok(res, "a parse failure must fall through, not throw");
    assert.equal(res.origin, "builtin", "resolution must continue to the builtin copy");
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

test("listTeams tolerates a bad file without throwing", async () => {
  const { listTeams } = await importDist("orchestrator/teams.js");
  const project = projectWith("tj-broken", "name: tj-broken\nstages: [ { kind:\n");
  try {
    const teams = listTeams({ project_path: project });
    assert.ok(Array.isArray(teams), "listTeams must return an array");
    assert.ok(teams.length > 0, "builtin teams must still be listed");
    assert.ok(!teams.some((t) => t.name === "tj-broken"), "the broken file must be skipped");
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

test("every shipped .claude/teams/*.yaml still loads through getTeam", async () => {
  const { getTeam } = await importDist("orchestrator/teams.js");
  const teamsDir = join(REPO_ROOT, ".claude", "teams");
  const files = readdirSync(teamsDir).filter((f) => /\.ya?ml$/.test(f));
  assert.ok(files.length > 0, "shipped teams dir must not be empty");
  const project = mkdtempSync(join(tmpdir(), "pp-tj-ship-"));
  try {
    for (const file of files) {
      const name = file.replace(/\.ya?ml$/, "");
      const res = getTeam({ name, project_path: project });
      assert.ok(res, `shipped team ${file} must resolve`);
      assert.equal(res.origin, "builtin", `shipped team ${file} must resolve as builtin`);
    }
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});
