/**
 * Distill PROJECT_MASTER.md sections 11–14 into AGENTS.md sections.
 *
 * This is a helper for the `agents-md-author` sub-agent. The agent decides
 * WHAT to write (it's a Claude task that condenses prose into 3-8 bullets);
 * this module decides WHERE it lands. The mapping is fixed:
 *
 *   PROJECT_MASTER.md §11 (Architecture)        → AGENTS.md "Project layout"
 *   PROJECT_MASTER.md §12 (Interfaces)          → AGENTS.md "Coding conventions"
 *   PROJECT_MASTER.md §13 (Engineering)         → AGENTS.md "Coding conventions"
 *   PROJECT_MASTER.md §14 (Security/compliance) → AGENTS.md "Do not"
 *
 * The author may also override the mapping per call (e.g. a refactor that
 * changes the build process should go to "Build and test commands" not
 * "Coding conventions"). The sync helper only enforces the section names
 * are canonical.
 */

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { AGENTS_MD_SECTIONS } from "./agents-md-template.js";

export const MASTER_PLAN_TO_AGENTS_MD: Record<string, string> = {
  "11. Architecture and technical strategy":          "Project layout",
  "12. Interfaces and contracts":                     "Coding conventions",
  "13. Engineering standards and delivery model":     "Coding conventions",
  "14. Security, privacy, and compliance":            "Do not",
};

/** Section headings in PROJECT_MASTER.md that trigger an AGENTS.md resync. */
export const MASTER_PLAN_SYNC_SECTIONS = Object.keys(MASTER_PLAN_TO_AGENTS_MD);

export function isAgentsMdSection(section: string): boolean {
  return AGENTS_MD_SECTIONS.includes(section);
}

export type DistillSource = {
  master_plan_section: string;
  body: string;
};

/**
 * Pull a section body out of PROJECT_MASTER.md by exact heading match.
 * Returns the raw body (trimmed) or null if the section / file is absent.
 */
export function readMasterPlanSection(projectPath: string, section: string): string | null {
  const path = join(projectPath, "PROJECT_MASTER.md");
  if (!existsSync(path)) return null;
  const doc = readFileSync(path, "utf8");
  const re = new RegExp(`^## ${escapeRe(section)}\\s*([\\s\\S]*?)(?=\\n## |\\n*$)`, "m");
  const m = re.exec(doc);
  if (!m) return null;
  const body = (m[1] ?? "").trim();
  if (!body || /^_To be populated/.test(body)) return null;
  return body;
}

/**
 * Build the set of {master_plan_section, body} pairs the author should
 * distill, given the list of sections that were patched this run.
 *
 * Filters to only the sync set (§11–14) and only sections that have actual
 * content (not the placeholder).
 */
export function gatherDistillSources(projectPath: string, patchedSections: string[]): DistillSource[] {
  const out: DistillSource[] = [];
  for (const section of patchedSections) {
    if (!(section in MASTER_PLAN_TO_AGENTS_MD)) continue;
    const body = readMasterPlanSection(projectPath, section);
    if (!body) continue;
    out.push({ master_plan_section: section, body });
  }
  return out;
}

/** Which AGENTS.md section should a given PROJECT_MASTER.md section sync into? */
export function targetAgentsMdSection(masterPlanSection: string): string | null {
  return MASTER_PLAN_TO_AGENTS_MD[masterPlanSection] ?? null;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
