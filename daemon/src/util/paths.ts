import { homedir } from "node:os";
import { join } from "node:path";
import { mkdirSync } from "node:fs";

export const HOME = homedir();
export const ROOT_DIR = join(HOME, ".pair-programmer");
export const DB_PATH = join(ROOT_DIR, "state.db");
export const LOG_DIR = join(ROOT_DIR, "logs");
export const SANDBOX_DIR = join(ROOT_DIR, "sandboxes");
export const PRICES_PATH = join(ROOT_DIR, "prices.json");
export const PID_LOCK = join(ROOT_DIR, "daemon.lock");

export function ensureDirs(): void {
  for (const d of [ROOT_DIR, LOG_DIR, SANDBOX_DIR]) {
    mkdirSync(d, { recursive: true });
  }
}

export function projectArtifactDir(projectPath: string, runId: string): string {
  return join(projectPath, ".harness", runId);
}

export function projectLockPath(projectPath: string): string {
  return join(projectPath, ".harness", ".lock");
}
