import pino from "pino";
import { join } from "node:path";
import { LOG_DIR, ensureDirs } from "./paths.js";

ensureDirs();

const logFile = join(LOG_DIR, `pp-daemon-${new Date().toISOString().slice(0, 10)}.log`);

// Use synchronous destination so short-lived processes (hook scripts) don't
// crash on exit before the async sonic-boom buffer flushes. The volume is
// low enough that sync writes are fine.
export const log = pino(
  { level: process.env.PP_LOG_LEVEL ?? "info" },
  pino.destination({ dest: logFile, sync: true, mkdir: true })
);
