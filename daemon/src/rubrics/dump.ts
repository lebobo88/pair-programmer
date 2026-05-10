/**
 * Dumps the in-process rubric registry to `.claude/rubrics/*.md` mirrors,
 * one file per rubric. The version (and full id with @suffix) is
 * preserved inside frontmatter so replays remain pinnable to the file.
 *
 * Filename convention: bare id without the @version suffix
 * (`wcag-2.2-aa.md`, not `wcag-2.2-aa@1.md`) when only one version of
 * that bare id exists in the registry. When multiple versions of the
 * same bare id ship (e.g. `web-runtime-validation@1` and `@2`), every
 * version of that bare id gets its full `<bare-id>@<version>.md`
 * filename so neither one overwrites the other. The rubric registry
 * remains the canonical source; these files are regenerated whenever
 * the registry changes via `pp-daemon dump-rubrics`. Project-local
 * overrides at `<project>/.claude/rubrics/<bare-id>.md` continue to be
 * bare-id keyed (a single override applies to every version of that
 * bare id) — see loader.ts.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { RUBRICS } from "./registry.js";

export function dumpRubrics(targetDir?: string): { wrote: string[] } {
  const dir = targetDir
    ? resolve(targetDir)
    : resolve(process.cwd(), ".claude", "rubrics");
  mkdirSync(dir, { recursive: true });

  // Count occurrences of each bare id so we know which need an @version
  // suffix to avoid filename collisions across versions.
  const bareCounts = new Map<string, number>();
  for (const r of RUBRICS) {
    const bareId = r.id.replace(/@.*$/, "");
    bareCounts.set(bareId, (bareCounts.get(bareId) ?? 0) + 1);
  }

  const wrote: string[] = [];
  for (const r of RUBRICS) {
    const bareId = r.id.replace(/@.*$/, "");
    const filename = (bareCounts.get(bareId) ?? 1) > 1
      ? `${bareId}@${r.version}.md`
      : `${bareId}.md`;
    const path = join(dir, filename);
    const frontmatter = [
      "---",
      `id: ${r.id}`,
      `bare_id: ${bareId}`,
      `kind: ${r.kind}`,
      `version: ${r.version}`,
      `title: ${escapeYaml(r.title)}`,
      `source_url: ${r.source_url}`,
      `generated_by: pp-daemon dump-rubrics`,
      `note: This file mirrors the registry in daemon/src/rubrics/registry.ts. Do not edit by hand — regenerate.`,
      "---",
      "",
    ].join("\n");
    writeFileSync(path, frontmatter + r.markdown + "\n", "utf8");
    wrote.push(path);
  }
  return { wrote };
}

function escapeYaml(s: string): string {
  if (/[:#\-?]/.test(s) || s.includes("'") || s.includes('"')) {
    return `"${s.replace(/"/g, '\\"')}"`;
  }
  return s;
}
