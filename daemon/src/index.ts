#!/usr/bin/env node
import { runHarnessMcpServer } from "./mcp/harness-server.js";
import { runCodexMcpServer } from "./mcp/codex-server.js";
import { runAntigravityMcpServer } from "./mcp/antigravity-server.js";
import { runHookDispatcher } from "./hooks/dispatcher.js";
import { runJanitor } from "./orchestrator/janitor.js";
import { runHttpServer } from "./http/server.js";
import { buildReplayBundle } from "./orchestrator/replay.js";
import { doctor } from "./orchestrator/runs.js";
import { dumpRubrics } from "./rubrics/dump.js";
import { log } from "./util/logger.js";
import { shutdownAndExit } from "./util/shutdown.js";

// PP-RS-3: SIGTERM/SIGINT now delegate to the shared shutdownAndExit helper
// which also aborts in-flight CLI child processes before releasing locks.
// PP-RS-4: unhandledRejection/uncaughtException crash handlers use the same
// idempotent helper — the shuttingDown guard prevents double-run if multiple
// signals or error events fire within the same tick.
// All handlers use `void` because shutdownAndExit is async; the guard prevents
// re-entry so concurrent calls are safe.
process.on("SIGTERM", () => void shutdownAndExit("SIGTERM"));
process.on("SIGINT",  () => void shutdownAndExit("SIGINT"));
process.on("unhandledRejection", (reason) => {
  log.error({ reason: String(reason) }, "unhandledRejection — releasing locks");
  void shutdownAndExit("unhandledRejection", { exitCode: 1 });
});
process.on("uncaughtException", (err) => {
  log.error({ err: String(err) }, "uncaughtException — releasing locks");
  void shutdownAndExit("uncaughtException", { exitCode: 1 });
});

const USAGE = `pp-daemon — Pair Programmer harness daemon

Usage:
  pp-daemon mcp                 Run the harness MCP server on stdio (registered as "pp_harness").
  pp-daemon mcp-codex           Run the Codex CLI MCP wrapper on stdio (registered as "pp_codex").
  pp-daemon mcp-agy             Run the Antigravity CLI MCP wrapper on stdio (registered as "pp_agy").
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
    case "mcp-agy":
      await runAntigravityMcpServer();
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
  // PP-RS-4 issue 4: route through shutdownAndExit so locks are released and
  // in-flight children are aborted before process.exit (previously bypassed).
  log.fatal({ err }, "daemon crashed");
  process.stderr.write(`fatal: ${err instanceof Error ? err.message : String(err)}\n`);
  void shutdownAndExit("main_rejection", { exitCode: 1 });
});
