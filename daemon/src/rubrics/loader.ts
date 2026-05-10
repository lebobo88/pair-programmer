/**
 * Rubric loader. The canonical source is the in-process registry
 * (`registry.ts`); `.claude/rubrics/*.md` mirrors are emitted by
 * `pp-daemon dump-rubrics` and serve as human-readable copies.
 *
 * This module re-exports the registry API plus a disk-fallback loader for
 * project-local rubric overrides at `<project>/.claude/rubrics/<id>.md`.
 */

import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { getRubric as registryGetRubric, listRubrics, type Rubric, RUBRICS } from "./registry.js";

export { listRubrics, RUBRICS };
export type { Rubric };

export type RubricSource = "registry" | "project-override";

export type LoadedRubric = Rubric & { source: RubricSource };

/**
 * Look up a rubric by id. Tries the in-process registry first; falls back
 * to a project-local override at `<projectPath>/.claude/rubrics/<bare-id>.md`
 * if `projectPath` is provided. Returns `null` if neither yields a rubric.
 *
 * Project overrides are loaded as plain markdown bodies (no frontmatter
 * parsing); the override's id is taken from the filename. Use this to
 * customize a rubric for one project without forking the registry.
 */
export function loadRubric(id: string, projectPath?: string): LoadedRubric | null {
  const fromRegistry = registryGetRubric(id);
  if (fromRegistry) return { ...fromRegistry, source: "registry" };

  if (!projectPath) return null;

  const bareId = id.replace(/@.*$/, "");
  const overridePath = resolve(projectPath, ".claude", "rubrics", `${bareId}.md`);
  if (!existsSync(overridePath)) return null;

  try {
    const md = readFileSync(overridePath, "utf8");
    return {
      id,
      kind: "custom",
      version: id.includes("@") ? id.split("@")[1]! : "0",
      title: bareId,
      source_url: overridePath,
      markdown: stripFrontmatter(md),
      schema_json: undefined,
      source: "project-override",
    };
  } catch {
    return null;
  }
}

function stripFrontmatter(md: string): string {
  if (!md.startsWith("---")) return md;
  const end = md.indexOf("\n---", 3);
  if (end < 0) return md;
  return md.slice(end + 4).replace(/^\n+/, "");
}
