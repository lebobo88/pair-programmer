/**
 * hook-executive-suite.unit.mjs
 *
 * `enforce-active-run` lets ExecutiveSuite agents (agent_type prefixed exactly
 * "executive-suite:", the plugin namespace) write without an active run: their
 * writes are reports and briefs, not code. Rob's decision, 2026-11-08.
 * Everything else stays gated, and the other PreToolUse hooks still apply.
 *
 * ANTI-STALL: self-contained. Temp ledger, CLI hook entry point, no daemon.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { setIsolatedProcessEnv, isolatedChildEnv } from "./fixtures/isolated-env.mjs";

const DIST = join(dirname(fileURLToPath(import.meta.url)), "..", "dist");
const { ppHome, ppDbPath } = setIsolatedProcessEnv({ prefix: "pp-hook-exec-suite-" });

// A cwd no run owns (empty temp ledger), and a path outside .harness/.claude.
const CWD = "H:\pp-exec-suite-fixture";
const FILE = "H:/pp-exec-suite-fixture/reports/brief.md";

function runHook(name, payload) {
  const env = isolatedChildEnv({ ppHome, ppDbPath }).env;
  delete env.PP_ALLOW_AD_HOC;
  delete env.PP_ALLOW_DESTRUCTIVE;
  const stdout = execFileSync(process.execPath, [join(DIST, "index.js"), "hook", "PreToolUse", name], {
    input: JSON.stringify(payload),
    encoding: "utf8",
    env,
  });
  const raw = stdout.trim();
  return { denied: raw ? JSON.parse(raw)?.hookSpecificOutput?.permissionDecision === "deny" : false, raw };
}

const write = (agentType) => {
  const p = { tool_name: "Write", tool_input: { file_path: FILE }, cwd: CWD };
  if (agentType !== undefined) p.agent_type = agentType;
  return runHook("enforce-active-run", p);
};

describe("enforce-active-run and ExecutiveSuite agents", () => {
  test("executive-suite:boardroom with no active run is ALLOWED", () => {
    const r = write("executive-suite:boardroom");
    assert.equal(r.denied, false, `ExecutiveSuite write must pass; got ${r.raw}`);
  });

  test("the camelCase agentType spelling is honoured too", () => {
    const r = runHook("enforce-active-run", {
      tool_name: "Edit", tool_input: { file_path: FILE }, cwd: CWD, agentType: "executive-suite:cfo",
    });
    assert.equal(r.denied, false, `got ${r.raw}`);
  });

  for (const [label, agentType] of [["engineer", "engineer"], ["absent agent_type", undefined], ["empty agent_type", ""]]) {
    test(`${label} with no active run is still BLOCKED`, () => {
      const r = write(agentType);
      assert.equal(r.denied, true, `must stay gated; got ${r.raw || "(allowed)"}`);
      assert.match(r.raw, /no active run owns this edit/);
    });
  }

  for (const lookalike of [
    "executive-suitex:boardroom",
    "my-executive-suite:cfo",
    "EXECUTIVE-SUITE:ceo",
    "executive-suite",
  ]) {
    test(`lookalike "${lookalike}" is still BLOCKED`, () => {
      const r = write(lookalike);
      assert.equal(r.denied, true, `must stay gated; got ${r.raw || "(allowed)"}`);
      assert.match(r.raw, /no active run owns this edit/);
    });
  }

  test("block-destructive-shell still blocks a destructive command from an ExecutiveSuite agent", () => {
    const command = ["rm", "-rf", "/"].join(" ");
    const r = runHook("block-destructive-shell", {
      tool_name: "Bash", tool_input: { command }, cwd: CWD, agent_type: "executive-suite:boardroom",
    });
    assert.equal(r.denied, true, `destructive shell must stay blocked; got ${r.raw || "(allowed)"}`);
    assert.match(r.raw, /destructive-shell blocked/);
  });
});
