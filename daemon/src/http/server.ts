/**
 * Read-only HTTP control plane on 127.0.0.1:7878. Exposes a small set of
 * GET endpoints for cross-session queries (a future dashboard or
 * pp:status from a separate Claude Code session). No writes — write paths
 * stay on the MCP stdio surface.
 *
 * Idle-shutdown: auto-stops after 10 minutes of no requests. Started
 * lazily by `pp-daemon serve`; nothing else spawns it.
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { listRuns, getRun, budgetStatus } from "../orchestrator/runs.js";
import { masterPlanStatus } from "../orchestrator/master-plan.js";
import { buildReplayBundle } from "../orchestrator/replay.js";
import { log } from "../util/logger.js";

const PORT = 7878;
const HOST = "127.0.0.1";
const IDLE_TIMEOUT_MS = 10 * 60 * 1000;

let lastActivity = Date.now();

function send(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body, null, 2);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(text, "utf8"),
    "x-pp-daemon": "0.1.0",
  });
  res.end(text);
}

function notFound(res: ServerResponse): void {
  send(res, 404, { error: "not_found" });
}

export async function runHttpServer(): Promise<void> {
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    lastActivity = Date.now();
    const url = new URL(req.url ?? "/", `http://${HOST}:${PORT}`);

    if (req.method !== "GET") return send(res, 405, { error: "method_not_allowed" });

    try {
      if (url.pathname === "/healthz") {
        return send(res, 200, { ok: true, ts: new Date().toISOString() });
      }
      if (url.pathname === "/runs") {
        const project = url.searchParams.get("project_path") ?? undefined;
        const status = url.searchParams.get("status") as "pending" | "running" | "surfaced" | "complete" | "crashed" | "aborted" | null;
        const limit = Number(url.searchParams.get("limit") ?? "50");
        return send(res, 200, listRuns({ project_path: project, status: status ?? undefined, limit }));
      }
      const runMatch = /^\/runs\/(run_[\w-]+)$/.exec(url.pathname);
      if (runMatch) return send(res, 200, getRun(runMatch[1]!));
      const replayMatch = /^\/runs\/(run_[\w-]+)\/replay$/.exec(url.pathname);
      if (replayMatch) {
        const bundle = buildReplayBundle(replayMatch[1]!);
        return bundle ? send(res, 200, bundle) : send(res, 404, { error: "run_not_found" });
      }
      if (url.pathname === "/budgets") {
        const scope = url.searchParams.get("scope") ?? undefined;
        return send(res, 200, budgetStatus(scope));
      }
      if (url.pathname === "/master-plan") {
        const project = url.searchParams.get("project_path");
        if (!project) return send(res, 400, { error: "project_path required" });
        return send(res, 200, masterPlanStatus(project));
      }
      return notFound(res);
    } catch (err) {
      log.error({ err, url: req.url }, "http handler crashed");
      return send(res, 500, { error: "internal", message: err instanceof Error ? err.message : String(err) });
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.listen(PORT, HOST, () => {
      log.info(`pp-daemon HTTP control plane on http://${HOST}:${PORT}`);
      console.log(`pp-daemon HTTP control plane on http://${HOST}:${PORT}`);
      resolve();
    });
    server.once("error", reject);
  });

  // Idle-shutdown timer
  const idleTimer = setInterval(() => {
    if (Date.now() - lastActivity > IDLE_TIMEOUT_MS) {
      log.info("HTTP server idle; shutting down");
      clearInterval(idleTimer);
      server.close(() => process.exit(0));
    }
  }, 60 * 1000);
}
