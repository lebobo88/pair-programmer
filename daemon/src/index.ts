#!/usr/bin/env node
import { runHarnessMcpServer } from "./mcp/harness-server.js";
import { runCodexMcpServer } from "./mcp/codex-server.js";
import { runGeminiMcpServer } from "./mcp/gemini-server.js";
import { runHookDispatcher } from "./hooks/dispatcher.js";
import { runJanitor } from "./orchestrator/janitor.js";
import { runHttpServer } from "./http/server.js";
import { buildReplayBundle } from "./orchestrator/replay.js";
import { doctor } from "./orchestrator/runs.js";
import { dumpRubrics } from "./rubrics/dump.js";
import { listActiveLocks } from "./util/lock.js";
import { log } from "./util/logger.js";

// P3: proactively release every project lock this daemon process is
// holding when it receives SIGTERM/SIGINT. Without this, a killed daemon
// (Claude Code session ending mid-run is the canonical case) leaves
// <project>/.harness/.lock stranded until the janitor's TTL reaps it,
// blocking the next /pp:run for up to 30 minutes. Best-effort — if the
// release itself throws we still exit, because at this point we're done.
let shuttingDown = false;
function releaseAllLocksAndExit(signal: NodeJS.Signals): void {
  if (shuttingDown) return;
  shuttingDown = true;
  const locks = listActiveLocks();
  log.info({ signal, lock_count: locks.length }, "shutdown: releasing project locks");
  for (const lock of locks) {
    try { lock.release(); }
    catch (err) { log.warn({ err, project_path: lock.projectPath }, "shutdown: lock.release failed"); }
  }
  process.exit(0);
}
process.on("SIGTERM", () => releaseAllLocksAndExit("SIGTERM"));
process.on("SIGINT",  () => releaseAllLocksAndExit("SIGINT"));

const USAGE = `pp-daemon — Pair Programmer harness daemon

Usage:
  pp-daemon mcp                 Run the harness MCP server on stdio (registered as "pp_harness").
  pp-daemon mcp-codex           Run the Codex CLI MCP wrapper on stdio (registered as "pp_codex").
  pp-daemon mcp-gemini          Run the Gemini CLI MCP wrapper on stdio (registered as "pp_gemini").
  pp-daemon doctor              Print a JSON health check (CLI versions, DB, vendor matrix).
  pp-daemon hook <event> <name> Run a hook handler (Claude Code hooks call this).
  pp-daemon janitor             Mark stale runs crashed; sweep stale candidate worktrees.
  pp-daemon replay <run_id>     Print a replay bundle for a past run (prompts + versions + hashes).
  pp-daemon dump-rubrics [dir]  Regenerate .claude/rubrics/<id>.md mirrors from the in-process registry.
  pp-daemon serve               Read-only HTTP control plane on 127.0.0.1:7878 (idle-shutdown 10m).
  pp-daemon --help              Print this help.
`;

async function main() {
  const cmd = process.argv[2];
  switch (cmd) {
    case "mcp":
      await runHarnessMcpServer();
      return;
    case "mcp-codex":
      await runCodexMcpServer();
      return;
    case "mcp-gemini":
      await runGeminiMcpServer();
      return;
    case "doctor": {
      const report = await doctor();
      process.stdout.write(JSON.stringify(report, null, 2) + "\n");
      return;
    }
    case "hook":
      await runHookDispatcher(process.argv.slice(3));
      return;
    case "serve":
      try { runJanitor(); } catch (err) { log.warn({ err }, "janitor failed during serve start"); }
      await runHttpServer();
      return;
    case "janitor": {
      const out = runJanitor();
      process.stdout.write(JSON.stringify(out, null, 2) + "\n");
      return;
    }
    case "replay": {
      const runId = process.argv[3];
      if (!runId) {
        process.stderr.write("usage: pp-daemon replay <run_id>\n");
        process.exit(2);
      }
      const bundle = buildReplayBundle(runId);
      if (!bundle) {
        process.stderr.write(`run ${runId} not found\n`);
        process.exit(2);
      }
      process.stdout.write(JSON.stringify(bundle, null, 2) + "\n");
      return;
    }
    case "dump-rubrics": {
      const targetDir = process.argv[3];
      const out = dumpRubrics(targetDir);
      process.stdout.write(JSON.stringify(out, null, 2) + "\n");
      return;
    }
    case "--help":
    case "-h":
    case undefined:
      process.stdout.write(USAGE);
      return;
    default:
      process.stderr.write(`unknown command: ${cmd}\n${USAGE}`);
      process.exit(2);
  }
}

main().catch(err => {
  log.fatal({ err }, "daemon crashed");
  process.stderr.write(`fatal: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
