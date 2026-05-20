import { existsSync, mkdirSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { join, basename } from "node:path";
import { createHash } from "node:crypto";
import { nanoid } from "nanoid";
import { db, txImmediate } from "../db/database.js";
import { masterPlanTemplate, MASTER_PLAN_SECTIONS, COMPLETION_CHECKLIST } from "./taxonomy.js";

const MASTER_PLAN_NAME = "PROJECT_MASTER.md";

export function masterPlanPath(projectPath: string): string {
  return join(projectPath, MASTER_PLAN_NAME);
}

export function ensureMasterPlan(projectPath: string): { path: string; created: boolean } {
  const path = masterPlanPath(projectPath);
  if (existsSync(path)) return { path, created: false };
  mkdirSync(projectPath, { recursive: true });
  writeFileSync(path, masterPlanTemplate(basename(projectPath)), "utf8");
  return { path, created: true };
}

export type PatchKind = "create" | "update" | "append";

export type PatchInput = {
  run_id: string;
  project_path: string;
  section: string;          // canonical section header from MASTER_PLAN_SECTIONS
  kind: PatchKind;
  content_md: string;       // the new content for the section, replacing the placeholder or appending
};

export type ApplyMasterPlanPatchResult =
  | { patch_id: string; new_sha: string; prev_sha: string; status: "applied"; resolved_section: string }
  | { patch_id: string; new_sha: string; prev_sha: string; status: "noop_already_applied"; reason: string; resolved_section: string }
  | { patch_id: null; new_sha: string; prev_sha: string; status: "rejected_unknown_section"; reason: string; requested_section: string; available_sections: string[] };

/**
 * Resolve a caller-supplied section key to the canonical
 * MASTER_PLAN_SECTIONS entry, allowing short forms like "11" or
 * "architecture" to match "11. Architecture and technical strategy".
 * Returns null when nothing matches confidently.
 */
function resolveSectionName(input: string): string | null {
  const wanted = input.trim();
  if (!wanted) return null;
  // 1. Exact match wins.
  if (MASTER_PLAN_SECTIONS.includes(wanted)) return wanted;
  // 2. Leading-number match: "11" → "11. Architecture and technical strategy".
  const numMatch = /^(\d+)(?:\.|$)/.exec(wanted);
  if (numMatch) {
    const prefix = `${numMatch[1]}.`;
    const hit = MASTER_PLAN_SECTIONS.find(s => s.startsWith(prefix));
    if (hit) return hit;
  }
  // 3. Case-insensitive title-substring match (after stripping leading "N. ").
  const wantedNorm = wanted.toLowerCase().replace(/^\d+\.\s*/, "");
  if (wantedNorm.length >= 4) {
    const hits = MASTER_PLAN_SECTIONS.filter(s => s.toLowerCase().includes(wantedNorm));
    if (hits.length === 1) return hits[0]!;
  }
  return null;
}

export function applyMasterPlanPatch(input: PatchInput): ApplyMasterPlanPatchResult {
  const { path } = ensureMasterPlan(input.project_path);
  const prev = readFileSync(path, "utf8");
  const prevSha = createHash("sha256").update(prev).digest("hex");

  // Resolve to a canonical section header before doing any work. Without
  // this, callers passing "11" / "12" silently produce a brand-new
  // duplicate `## 11` block instead of patching the intended section, and
  // the harness ledger records a misleading "applied" status. Fail loudly
  // with an enumerated list of valid sections.
  const resolved = resolveSectionName(input.section);
  if (!resolved) {
    return {
      patch_id: null,
      new_sha: prevSha,
      prev_sha: prevSha,
      status: "rejected_unknown_section",
      requested_section: input.section,
      reason:
        `section '${input.section}' did not match any canonical PROJECT_MASTER.md section. ` +
        `Pass the full header (e.g. "11. Architecture and technical strategy") or a leading number.`,
      available_sections: [...MASTER_PLAN_SECTIONS],
    };
  }
  input = { ...input, section: resolved };

  // Idempotency: when kind=append, if the prior section body already
  // contains the run-id block we'd be writing, no-op. This prevents the
  // same run from appending duplicate blocks when both the master-plan-
  // patcher agent and finalize_run's auto-patcher run on the same finalize.
  // Detection key: a literal "Run `<run_id>`" header — runs are unique.
  if (input.kind === "append") {
    const existingBody = sectionBody(prev, input.section);
    if (existingBody) {
      const headerRe = new RegExp(`Run\\s*\`?${escapeRe(input.run_id)}\`?`, "m");
      const incomingHeaderRe = new RegExp(`Run\\s*\`?${escapeRe(input.run_id)}\`?`, "m");
      if (headerRe.test(existingBody) && incomingHeaderRe.test(input.content_md)) {
        const id = `mpp_${nanoid(10)}`;
        txImmediate(() => {
          db()
            .prepare(
              `INSERT INTO master_plan_patches(id, run_id, section, kind, prev_sha, new_sha, applied_at)
               VALUES (?, ?, ?, ?, ?, ?, ?)`
            )
            .run(id, input.run_id, input.section, "noop_already_applied", prevSha, prevSha, new Date().toISOString());
        });
        return {
          patch_id: id,
          new_sha: prevSha,
          prev_sha: prevSha,
          status: "noop_already_applied",
          reason: `run ${input.run_id} block already present in ${input.section}`,
          resolved_section: input.section,
        };
      }
    }
  }

  const next = patchSection(prev, input.section, input.content_md, input.kind);
  writeFileSync(path, next, "utf8");
  const newSha = createHash("sha256").update(next).digest("hex");

  const id = `mpp_${nanoid(10)}`;
  txImmediate(() => {
    db()
      .prepare(
        `INSERT INTO master_plan_patches(id, run_id, section, kind, prev_sha, new_sha, applied_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(id, input.run_id, input.section, input.kind, prevSha, newSha, new Date().toISOString());
  });

  return { patch_id: id, new_sha: newSha, prev_sha: prevSha, status: "applied", resolved_section: input.section };
}

/** Extract just the body of a `## <section>` block; returns "" if absent. */
function sectionBody(doc: string, section: string): string {
  const headingRe = new RegExp(`^## ${escapeRe(section)}\\s*$`, "m");
  const match = headingRe.exec(doc);
  if (!match) return "";
  const start = match.index + match[0].length;
  const nextHeadingRe = /\n## /g;
  nextHeadingRe.lastIndex = start;
  const nextMatch = nextHeadingRe.exec(doc);
  const end = nextMatch ? nextMatch.index : doc.length;
  return doc.slice(start, end);
}

/**
 * Replace the body of a `## <section>` block with `body`. If `kind=append`,
 * append after existing content. If `kind=create` and the section is
 * missing, append a new section block to the document.
 */
function patchSection(doc: string, section: string, body: string, kind: PatchKind): string {
  const heading = `## ${section}`;
  const headingRe = new RegExp(`^## ${escapeRe(section)}\\s*$`, "m");
  const match = headingRe.exec(doc);

  if (!match) {
    if (kind === "create" || kind === "append") {
      return doc.replace(/\n*$/, "\n") + `\n${heading}\n\n${body.trim()}\n`;
    }
    throw new Error(`section "${section}" not found in master plan`);
  }

  const start = match.index + match[0].length;
  const nextHeadingRe = /\n## /g;
  nextHeadingRe.lastIndex = start;
  const nextMatch = nextHeadingRe.exec(doc);
  const end = nextMatch ? nextMatch.index : doc.length;

  let bodyOut: string;
  const existingRaw = doc.slice(start, end);
  const existing = existingRaw.trim();
  const isPlaceholder = /^_To be populated/.test(existing);

  if (kind === "append" && !isPlaceholder && existing) {
    bodyOut = `\n\n${existing}\n\n${body.trim()}\n\n`;
  } else {
    // First write into a placeholder section, or kind=update/create — overwrite.
    bodyOut = `\n\n${body.trim()}\n\n`;
  }

  return doc.slice(0, start) + bodyOut + doc.slice(end);
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ─── Status / checklist ─────────────────────────────────────────────────

export function masterPlanStatus(projectPath: string): {
  path: string;
  exists: boolean;
  bytes: number | null;
  sections: Array<{ section: string; populated: boolean; bytes: number }>;
  completion_checklist: Array<{ item: string; pass: boolean }>;
} {
  const path = masterPlanPath(projectPath);
  if (!existsSync(path)) {
    return {
      path,
      exists: false,
      bytes: null,
      sections: MASTER_PLAN_SECTIONS.map(s => ({ section: s, populated: false, bytes: 0 })),
      completion_checklist: COMPLETION_CHECKLIST.map(item => ({ item, pass: false })),
    };
  }

  const text = readFileSync(path, "utf8");
  const bytes = statSync(path).size;
  const sections = MASTER_PLAN_SECTIONS.map(s => {
    const re = new RegExp(`^## ${escapeRe(s)}\\s*([\\s\\S]*?)(?=\\n## |\\n*$)`, "m");
    const m = re.exec(text);
    const body = m ? (m[1] ?? "").trim() : "";
    const populated = body.length > 0 && !/^_To be populated/.test(body);
    return { section: s, populated, bytes: body.length };
  });

  // Phase 9 wires the actual checklist heuristics; for Phase 3 we approximate
  // each item by mapping to a section's populated flag.
  const sectionByItem: Record<string, string | null> = {
    "The problem and business outcome are explicit.":                                 "1. Executive summary",
    "Users, operators, and approvers are identified.":                                "3. Stakeholders and users",
    "Scope boundaries are written down.":                                             "5. Scope and roadmap",
    "Acceptance criteria and non-functional requirements exist.":                     "7. Acceptance criteria",
    "Architecture decisions are documented with tradeoffs.":                          "11. Architecture and technical strategy",
    "API/event/UI contracts are specified and testable.":                             "12. Interfaces and contracts",
    "Data semantics, lineage, retention, and migration are defined.":                 "10. Domain and data model",
    "Security/privacy/compliance requirements are mapped to controls.":               "14. Security, privacy, and compliance",
    "Quality strategy covers functional and non-functional verification.":            "15. Test and verification strategy",
    "Release, rollback, and support plans exist before launch.":                      "19. Launch, migration, and rollback plan",
    "Telemetry, dashboards, and incident ownership are ready before launch.":         "16. Operations and support model",
    "Documentation ownership is assigned.":                                            "Appendices",
    "Governance forums and decision rights are known.":                                "17. Team operating model and governance",
    "Deprecation and retirement are not left as 'future work'.":                       "20. Deprecation and retirement plan",
    "If AI is involved, evals, permissions, and human review rules exist.":            "Appendices",
  };
  const populatedSet = new Set(sections.filter(s => s.populated).map(s => s.section));
  const checklist = COMPLETION_CHECKLIST.map(item => ({
    item,
    pass: !!sectionByItem[item] && populatedSet.has(sectionByItem[item]!),
  }));

  return { path, exists: true, bytes, sections, completion_checklist: checklist };
}
