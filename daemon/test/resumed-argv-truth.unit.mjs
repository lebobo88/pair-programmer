// ─── `resumed` argv-truthfulness regressions — agy (R1.11) + codex (R1.19) ──
//
// GitHub #43 (Phase A of epic #42). Covers Change 1a (antigravity-server.ts)
// and Change 1b (codex-server.ts): both bridges' `resumed` field must
// describe the invocation's ACTUAL argv, not a proxy for project history.
//
// SEAM DESIGN — why this file is more than a thin wrapper around `_invoke`:
//
//   `agyCritique`'s / `codexCritique`'s `_invoke` DI seam REPLACES the real
//   `agyGenerate` / `codexGenerate` call entirely. That seam is perfect for
//   asserting what genArgs a critique call WOULD resolve to (see
//   codex-escalation.unit.mjs), but it is the WRONG seam for this file: the
//   `didResume` / `cliArgs.includes("--resume")` logic under test lives
//   INSIDE `agyGenerate`/`codexGenerate`, downstream of where `_invoke` would
//   have intercepted. Using `_invoke` here would only prove that our test
//   double agrees with itself.
//
//   Instead this file lets the REAL `agyGenerate`/`codexGenerate` run for
//   real — including the REAL `buildCodexExecArgs` and the REAL session
//   lookup (`getSession`/`setSession` against a temp, isolated SQLite DB,
//   the same pattern `codex-escalation.unit.mjs` and friends use) — and
//   substitutes only the actual OS-level subprocess call, via Node's
//   `node:test` module-mock loader (`mock.module`, `--experimental-test-
//   module-mocks`). That flag is NOT needed for the top-level `node --test`
//   invocation of THIS file: it spawns a throwaway child `node` process
//   (inside a temp directory nested under `daemon/` so package resolution
//   still finds `daemon/node_modules`) that does the mocking-based run, and
//   this file only parses the child's stdout and asserts on it with plain
//   `node:assert`. No live `agy`/`codex` binary, no network, and no MCP peer
//   are ever touched — the child process fakes the MCP SDK's `Server`/
//   `StdioServerTransport` (agy path only — needed to reach the unexported
//   "generate" tool handler, since `agyCritique` unconditionally forces
//   `fresh_session: true` and therefore can never exercise R1.5/R1.6) and
//   `daemon/dist/mcp/cli-runner.js`'s `runCliWithRetry` (both paths — this is
//   what would otherwise spawn the real vendor CLI).
//
// Codex needs no MCP-server faking: `codexCritique`'s `_invoke` is UNSET in
// every call below, so the real `codexGenerate` (and the real
// `buildCodexExecArgs`) runs; only `runCliWithRetry` is mocked.

import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DAEMON_ROOT = join(__dirname, "..");

let passed = 0;
let failed = 0;
function record(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  pass  ${name}`);
  } catch (err) {
    failed++;
    console.error(`  FAIL  ${name}\n         ${err.message}`);
  }
}

// ─── Child script: runs under `--experimental-test-module-mocks` ─────────
//
// Emits ONE line of JSON to stdout: { cases: [{ label, ...assertions-worth
// -of-data }] }. All assertions on the DATA happen back in this (parent)
// process with plain node:assert, so a broken assertion produces a normal,
// readable diff — the child's only job is to produce ground truth by running
// the real production code paths.
const CHILD_SCRIPT = String.raw`
import { mock } from "node:test";
import { pathToFileURL } from "node:url";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const cliRunnerPath = join(process.cwd(), "dist/mcp/cli-runner.js");
const realCliRunner = await import(pathToFileURL(cliRunnerPath).href);

let capturedCliArgs = null;
let cliKind = null; // set per-call so the canned stdout matches the caller's parser

function agyCannedStdout() {
  return JSON.stringify({
    event: "result",
    result: { status: "SUCCESS", response: "ok", usage: { input_tokens: 1, output_tokens: 1 } },
  });
}
function codexCannedStdout() {
  return JSON.stringify({
    type: "item.completed",
    item: { text: JSON.stringify({ outcome: "pass", critique_md: "ok", score_entries: [] }) },
  });
}

mock.module(pathToFileURL(cliRunnerPath).href, {
  namedExports: {
    ...realCliRunner,
    runCliWithRetry: async (opts) => {
      capturedCliArgs = opts.cliArgs;
      return {
        stdout: cliKind === "codex" ? codexCannedStdout() : agyCannedStdout(),
        stderr: "",
        exit_code: 0,
        wall_ms: 1,
        attempts: [{ exit_code: 0, stderr_tail: "", wall_ms: 1 }],
      };
    },
  },
});

// ─── Fake MCP SDK Server/Transport (agy path only) ───────────────────────
// Needed to reach the unexported "generate" tool handler (agyGenerate),
// bypassing agyCritique's hardcoded fresh_session:true. setRequestHandler
// stores handlers keyed by the REAL (unmocked) schema object identity
// imported from @modelcontextprotocol/sdk/types.js, so lookups below are
// exact regardless of registration order.
let fakeServerInstances = [];
class FakeServer {
  constructor() { this.handlers = new Map(); fakeServerInstances.push(this); }
  setRequestHandler(schema, handler) { this.handlers.set(schema, handler); }
  async connect() { return; }
}
class FakeTransport {}
mock.module("@modelcontextprotocol/sdk/server/index.js", { namedExports: { Server: FakeServer } });
mock.module("@modelcontextprotocol/sdk/server/stdio.js", { namedExports: { StdioServerTransport: FakeTransport } });

const suiteDir = mkdtempSync(join(tmpdir(), "pp-resumed-argv-"));
process.env.PP_HOME = suiteDir;
process.env.EIGHTS_SKIP_AUDIT_CHECK = "1";

const { CallToolRequestSchema } = await import("@modelcontextprotocol/sdk/types.js");
const sessions = await import(pathToFileURL(join(process.cwd(), "dist/orchestrator/sub-cli-sessions.js")).href);
const antigravity = await import(pathToFileURL(join(process.cwd(), "dist/mcp/antigravity-server.js")).href);
await antigravity.runAntigravityMcpServer();
const agyServer = fakeServerInstances[0];
const agyCallHandler = agyServer.handlers.get(CallToolRequestSchema);

const { codexCritique } = await import(pathToFileURL(join(process.cwd(), "dist/mcp/codex-server.js")).href);

async function invokeAgyGenerate(cwd, freshSession) {
  cliKind = "agy";
  capturedCliArgs = null;
  const args = { prompt: "hi", cwd };
  if (freshSession !== undefined) args.fresh_session = freshSession;
  const result = await agyCallHandler({ params: { name: "generate", arguments: args } });
  const parsed = JSON.parse(result.content[0].text);
  return { resumed: parsed.resumed, cliArgs: capturedCliArgs ?? [] };
}

async function invokeCodexCritique(cwd) {
  cliKind = "codex";
  capturedCliArgs = null;
  const result = await codexCritique(
    { artifact_text: "fn foo(){}", rubric_md: "check it", cwd, output_schema: { type: "object" } },
    {},
  );
  return { resumed: result.resumed, cliArgs: capturedCliArgs ?? [] };
}

const cases = [];

// ── AGY three-way truth table (R1.4 / R1.5 / R1.6) + the 4th quadrant ────
{
  const cwd = mkdtempSync(join(tmpdir(), "pp-agy-r14-"));
  sessions.setSession(cwd, "agy", "continue");
  const r = await invokeAgyGenerate(cwd, true); // fresh_session:true, existing:true -> R1.4
  cases.push({ label: "agy R1.4 fresh_session=true existing=true", ...r });
}
{
  const cwd = mkdtempSync(join(tmpdir(), "pp-agy-r15-"));
  const r = await invokeAgyGenerate(cwd, undefined); // fresh_session unset, existing:false -> R1.5
  cases.push({ label: "agy R1.5 fresh_session=unset existing=false", ...r });
}
{
  const cwd = mkdtempSync(join(tmpdir(), "pp-agy-r16-"));
  sessions.setSession(cwd, "agy", "continue");
  const r = await invokeAgyGenerate(cwd, undefined); // fresh_session unset, existing:true -> R1.6
  cases.push({ label: "agy R1.6 fresh_session=unset existing=true", ...r });
}
{
  const cwd = mkdtempSync(join(tmpdir(), "pp-agy-r14b-"));
  const r = await invokeAgyGenerate(cwd, true); // fresh_session:true, existing:false -> completes 2x2 grid
  cases.push({ label: "agy fresh_session=true existing=false", ...r });
}

// ── CODEX two states (AC-11c / AC-11d) ────────────────────────────────────
{
  const cwd = mkdtempSync(join(tmpdir(), "pp-codex-noexist-"));
  const r = await invokeCodexCritique(cwd); // no prior session -> AC-11c
  cases.push({ label: "codex AC-11c no prior session", ...r });
}
{
  const cwd = mkdtempSync(join(tmpdir(), "pp-codex-exist-"));
  sessions.setSession(cwd, "codex", "sess-abc-123");
  const r = await invokeCodexCritique(cwd); // prior session present -> AC-11d
  cases.push({ label: "codex AC-11d prior session present", ...r, expectedSessionId: "sess-abc-123" });
}

process.stdout.write(JSON.stringify({ cases }));
`;

// ─── Spawn the child in a temp dir under daemon/ so node_modules resolves ──
let scratchDir;
let childCases = null;
let childError = null;
try {
  // The scratch dir MUST live under daemon/ — do not "tidy" this into tmpdir().
  // The child script bare-imports `@modelcontextprotocol/sdk` (to fake Server /
  // StdioServerTransport). Bare specifiers resolve by walking up from the
  // IMPORTING FILE's directory looking for node_modules, not from cwd — so a
  // child in the OS temp dir dies with ERR_MODULE_NOT_FOUND no matter what cwd
  // execFileSync is given. Its `dist/` imports are cwd-relative and would
  // survive the move; the SDK import is what pins it here.
  // Cleanup is the rmSync in the finally block below.
  scratchDir = mkdtempSync(join(DAEMON_ROOT, ".pp-test-tmp-"));
  const childPath = join(scratchDir, "child.mjs");
  writeFileSync(childPath, CHILD_SCRIPT, "utf8");
  const stdout = execFileSync(
    process.execPath,
    ["--experimental-test-module-mocks", childPath],
    { cwd: DAEMON_ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 30_000 },
  );
  const lastLine = stdout.trim().split("\n").filter(Boolean).pop();
  childCases = JSON.parse(lastLine).cases;
} catch (err) {
  childError = err;
} finally {
  if (scratchDir) rmSync(scratchDir, { recursive: true, force: true });
}

record("the child harness ran without error (real agyGenerate/codexGenerate/buildCodexExecArgs executed, no live CLI, no network, no MCP peer)", () => {
  if (childError) {
    const detail = childError.stderr ? childError.stderr.toString() : childError.message;
    throw new Error(`child harness failed: ${detail}`);
  }
  assert.ok(Array.isArray(childCases) && childCases.length === 6, `expected 6 recorded cases, got ${childCases?.length}`);
});

function findCase(label) {
  const c = childCases?.find(c => c.label === label);
  if (!c) throw new Error(`case not recorded: ${label} (harness may have failed — see the harness-ran check above)`);
  return c;
}

// ─── AC-3/R1.4 — fresh_session:true + existing:true → resumed=false, no --continue ──
record("AC-3/R1.4: agy fresh_session=true + existing session → resumed=false and cliArgs omits --continue", () => {
  const c = findCase("agy R1.4 fresh_session=true existing=true");
  assert.equal(c.resumed, false);
  assert.ok(!c.cliArgs.includes("--continue"));
});

// ─── AC-4/R1.5 — fresh_session unset + no existing → resumed=false, no --continue ──
record("AC-4/R1.5: agy fresh_session unset + no existing session → resumed=false and cliArgs omits --continue", () => {
  const c = findCase("agy R1.5 fresh_session=unset existing=false");
  assert.equal(c.resumed, false);
  assert.ok(!c.cliArgs.includes("--continue"));
});

// ─── AC-5/R1.6 — fresh_session unset + existing → resumed=true, --continue present ──
record("AC-5/R1.6: agy fresh_session unset + existing session → resumed=true and cliArgs contains --continue", () => {
  const c = findCase("agy R1.6 fresh_session=unset existing=true");
  assert.equal(c.resumed, true);
  assert.ok(c.cliArgs.includes("--continue"));
});

record("agy fresh_session=true + no existing session → resumed=false and cliArgs omits --continue (completes the 2x2 grid)", () => {
  const c = findCase("agy fresh_session=true existing=false");
  assert.equal(c.resumed, false);
  assert.ok(!c.cliArgs.includes("--continue"));
});

// ─── AC-6 — result.resumed === cliArgs.includes("--continue") for every agy case ──
record("AC-6: result.resumed === cliArgs.includes(\"--continue\") holds for every recorded agy case", () => {
  for (const label of [
    "agy R1.4 fresh_session=true existing=true",
    "agy R1.5 fresh_session=unset existing=false",
    "agy R1.6 fresh_session=unset existing=true",
    "agy fresh_session=true existing=false",
  ]) {
    const c = findCase(label);
    assert.equal(c.resumed, c.cliArgs.includes("--continue"), `mismatch for ${label}`);
  }
});

// ─── AC-7 — the ONLY (existing, fresh_session) pair producing --continue is (truthy, falsy) ──
record("AC-7: --continue appears in cliArgs for exactly one of the four (existing, fresh_session) combinations", () => {
  const withContinue = childCases
    .filter(c => c.label.startsWith("agy"))
    .filter(c => c.cliArgs.includes("--continue"))
    .map(c => c.label);
  assert.deepEqual(withContinue, ["agy R1.6 fresh_session=unset existing=true"],
    "exactly (existing truthy, fresh_session falsy) may produce --continue");
});

// ─── AC-11c — codex, no prior session → no --resume, resumed=false ────────
record("AC-11c/R1.19: codex with no prior session → cliArgs omits --resume and resumed=false", () => {
  const c = findCase("codex AC-11c no prior session");
  assert.equal(c.resumed, false);
  assert.ok(!c.cliArgs.includes("--resume"));
});

// ─── AC-11d — codex, prior session present → --resume <id>, resumed=true ──
record("AC-11d/R1.19: codex with a prior session → cliArgs contains --resume followed by that session_id and resumed=true", () => {
  const c = findCase("codex AC-11d prior session present");
  assert.equal(c.resumed, true);
  const idx = c.cliArgs.indexOf("--resume");
  assert.notEqual(idx, -1, "--resume must be present in cliArgs");
  assert.equal(c.cliArgs[idx + 1], "sess-abc-123", "--resume must be followed by the stored session_id");
});

// ─── AC-11e — result.resumed === cliArgs.includes("--resume") for both codex states ──
record("AC-11e/R1.19: result.resumed === cliArgs.includes(\"--resume\") holds for both codex states — the presently-accidental equivalence is now enforced", () => {
  for (const label of ["codex AC-11c no prior session", "codex AC-11d prior session present"]) {
    const c = findCase(label);
    assert.equal(c.resumed, c.cliArgs.includes("--resume"), `mismatch for ${label}`);
  }
});

// ─── R1.3/R1.14 — the forbidden proxy expression must not survive ─────────
record("R1.3: `resumed: !!existing` does not appear in antigravity-server.ts", () => {
  const src = readFileSync(join(DAEMON_ROOT, "src", "mcp", "antigravity-server.ts"), "utf8");
  assert.ok(!/resumed:\s*!!existing/.test(src), "the proxy expression must have been replaced by the argv-derived local");
});
record("R1.14: `resumed: !!existing` does not appear in codex-server.ts", () => {
  const src = readFileSync(join(DAEMON_ROOT, "src", "mcp", "codex-server.ts"), "utf8");
  assert.ok(!/resumed:\s*!!existing/.test(src), "the proxy expression must have been replaced by the cliArgs-derived value");
});

// ─── Summary ────────────────────────────────────────────────────────────
console.log();
console.log(`${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
