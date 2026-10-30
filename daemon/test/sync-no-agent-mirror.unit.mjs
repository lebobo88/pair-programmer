/**
 * Guard for pair-programmer #71 (Covenant TASK-038): scripts/sync-copilot-assets.mjs must
 * write nothing under .github/agents (Covenant owns it), while still writing the command,
 * skill and hook mirrors. Replaces nothing; it is the committed proof that step 1 of the
 * task asked for ("a fixture test"). Self-contained: the script is run on a temp copy
 * (it derives ROOT from its own location), never on the real tree.
 *
 * Falsifiability: agentsDirProblems()/mirrorsWritten() are the one pair of named functions
 * the real run and the red fixtures both call.
 */
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, cpSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import assert from "node:assert/strict";
import { test, describe } from "node:test";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

function listFiles(dir) {
  if (!existsSync(dir)) return [];
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...listFiles(p));
    else out.push(p);
  }
  return out.sort();
}

/** name -> content for every file under dir (relative names). */
function snapshot(dir) {
  return Object.fromEntries(listFiles(dir).map((p) => [p.slice(dir.length), readFileSync(p, "utf8")]));
}

/** Differences between two agents-dir snapshots; [] means untouched. */
function agentsDirProblems(before, after) {
  const problems = [];
  for (const k of Object.keys(after)) if (!(k in before)) problems.push(`created ${k}`);
  for (const k of Object.keys(before)) {
    if (!(k in after)) problems.push(`removed ${k}`);
    else if (before[k] !== after[k]) problems.push(`rewrote ${k}`);
  }
  return problems;
}

/** Counts of files the run produced in the three mirrors that must stay. */
function mirrorsWritten(tmp) {
  return {
    commands: listFiles(join(tmp, ".github", "commands")).length,
    skills: listFiles(join(tmp, ".github", "skills")).length,
    hooks: existsSync(join(tmp, "hooks.json")) && existsSync(join(tmp, ".github", "hooks", "pair-programmer.json")),
  };
}

describe("sync-copilot-assets writes nothing under .github/agents (#71)", () => {
  test("a real run on a temp copy leaves a pre-populated .github/agents byte-identical and still writes commands, skills and hooks", () => {
    const tmp = mkdtempSync(join(tmpdir(), "pp-sync-noagent-"));
    try {
      cpSync(join(ROOT, "scripts"), join(tmp, "scripts"), { recursive: true });
      for (const sub of ["commands", "skills", "settings.template.json", "hook-timeouts.json"]) {
        cpSync(join(ROOT, ".claude", sub), join(tmp, ".claude", sub), { recursive: true });
      }
      // Agent sources exist (the old script mirrored these); targets include a stale-looking
      // file with no source, which the old prune pass would have deleted.
      mkdirSync(join(tmp, ".claude", "agents"), { recursive: true });
      writeFileSync(join(tmp, ".claude", "agents", "alpha.md"), "---\nname: alpha\ndescription: x\n---\nbody\n");
      mkdirSync(join(tmp, ".github", "agents"), { recursive: true });
      writeFileSync(join(tmp, ".github", "agents", "alpha.agent.md"), "covenant output\n");
      writeFileSync(join(tmp, ".github", "agents", "orphan.agent.md"), "covenant output 2\n");

      const before = snapshot(join(tmp, ".github", "agents"));
      assert.ok(Object.keys(before).length === 2, "fixture must hold agent files or the check is vacuous");
      const run = spawnSync(process.execPath, [join(tmp, "scripts", "sync-copilot-assets.mjs")], { encoding: "utf8" });
      assert.equal(run.status, 0, run.stderr + run.stdout);
      assert.deepEqual(agentsDirProblems(before, snapshot(join(tmp, ".github", "agents"))), []);

      const written = mirrorsWritten(tmp);
      assert.ok(written.commands > 0 && written.skills > 0 && written.hooks, `commands/skills/hooks must still be written: ${JSON.stringify(written)}`);
      assert.doesNotMatch(run.stdout, /agents synced/, "summary must not report an agent count");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("falsifiability: agentsDirProblems() goes red on a created, rewritten and removed agent file, and is green on identical snapshots", () => {
    const base = { "/a.agent.md": "x", "/b.agent.md": "y" };
    assert.deepEqual(agentsDirProblems(base, { ...base }), []);
    assert.deepEqual(agentsDirProblems(base, { ...base, "/c.agent.md": "z" }), ["created /c.agent.md"]);
    assert.deepEqual(agentsDirProblems(base, { ...base, "/a.agent.md": "changed" }), ["rewrote /a.agent.md"]);
    const { "/b.agent.md": _gone, ...rest } = base;
    assert.deepEqual(agentsDirProblems(base, rest), ["removed /b.agent.md"]);
  });

  test("falsifiability: mirrorsWritten() reports nothing for an empty tree", () => {
    const tmp = mkdtempSync(join(tmpdir(), "pp-sync-empty-"));
    try {
      assert.deepEqual(mirrorsWritten(tmp), { commands: 0, skills: 0, hooks: false });
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
