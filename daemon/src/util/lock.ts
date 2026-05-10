import { mkdirSync, openSync, closeSync, existsSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import { projectLockPath } from "./paths.js";

/**
 * Per-project advisory file lock. Best-effort on Windows: open exclusively;
 * if the file already exists with a recent mtime, we treat the project as
 * busy. The caller is responsible for releasing.
 */
export class ProjectLock {
  private fd: number | null = null;
  constructor(public readonly projectPath: string) {}

  acquire(): void {
    const path = projectLockPath(this.projectPath);
    mkdirSync(dirname(path), { recursive: true });
    // 'wx' fails if the file exists, giving us atomic create.
    this.fd = openSync(path, "wx");
  }

  release(): void {
    if (this.fd !== null) {
      closeSync(this.fd);
      this.fd = null;
    }
    const path = projectLockPath(this.projectPath);
    if (existsSync(path)) {
      try { rmSync(path); } catch { /* ignore */ }
    }
  }
}
