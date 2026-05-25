/**
 * AGENTS.md / CLAUDE.md orchestrator. Mirror of master-plan.ts: ensure-on-
 * first-touch, section-aware patching with SHA-based idempotency, and an
 * audit trail in `agents_md_patches`.
 *
 * Why two files share one module: CLAUDE.md is a one-line `@AGENTS.md`
 * import plus Claude-specific add-ons. AGENTS.md carries the actual content
 * and is patched per-section. CLAUDE.md is scaffolded once and rarely
 * patched, so its API is just ensure + status.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, statSync, appendFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { createHash } from "node:crypto";
import { nanoid } from "nanoid";
import { db, txImmediate } from "../db/database.js";
import {
  AGENTS_MD_NAME,
  CLAUDE_MD_NAME,
  AGENTS_MD_SECTIONS,
  agentsMdTemplate,
  claudeMdTemplate,
  defaultProjectName,
  type AgentsMdTemplateExtras,
} from "./agents-md-template.js";

export { AGENTS_MD_SECTIONS };

const AGENTS_MD_MAX_LINES = 200;

const HISTORY_SECTIONS = new Set(["Notes from the harness"]);

const HISTORY_CONTENT_RE = /^###\s+R\d+[\s(]|sealed\s+`dec_|DR-2026-\d{3}/m;

function historyFilePath(projectPath: string): string {
  return join(projectPath, "docs", "agents-md-history.md");
}

function ensureHistoryFile(projectPath: string): string {
  const p = historyFilePath(projectPath);
  if (!existsSync(p)) {
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, `# AGENTS.md — Development History\n\nAppend-only archive of run history, cross-vendor judge notes, and sealed decision records.\n\n`, "utf8");
  }
  return p;
}

function appendToHistory(projectPath: string, section: string, content: string): void {
  const p = ensureHistoryFile(projectPath);
  const header = `\n## ${section}\n\n${content.trim()}\n`;
  appendFileSync(p, header, "utf8");
}

function shouldRedirectToHistory(section: string, content: string): boolean {
  if (HISTORY_SECTIONS.has(section)) return true;
  if (HISTORY_CONTENT_RE.test(content)) return true;
  return false;
}

function wouldExceedCap(currentDoc: string, newContent: string): boolean {
  const currentLines = currentDoc.split(/\r?\n/).length;
  const newLines = newContent.split(/\r?\n/).length;
  return (currentLines + newLines) > AGENTS_MD_MAX_LINES;
}

export function agentsMdPath(projectPath: string): string {
  return join(projectPath, AGENTS_MD_NAME);
}

export function claudeMdPath(projectPath: string): string {
  return join(projectPath, CLAUDE_MD_NAME);
}

export function ensureAgentsMd(
  projectPath: string,
  extras: AgentsMdTemplateExtras = {},
): { path: string; created: boolean } {
  const path = agentsMdPath(projectPath);
  if (existsSync(path)) return { path, created: false };
  mkdirSync(projectPath, { recursive: true });
  writeFileSync(path, agentsMdTemplate(defaultProjectName(projectPath), extras), "utf8");
  return { path, created: true };
}

export function ensureClaudeMd(projectPath: string): { path: string; created: boolean } {
  const path = claudeMdPath(projectPath);
  if (existsSync(path)) return { path, created: false };
  mkdirSync(projectPath, { recursive: true });
  writeFileSync(path, claudeMdTemplate(defaultProjectName(projectPath)), "utf8");
  return { path, created: true };
}

/** Convenience wrapper used by the run lifecycle — guarantees both files exist. */
export function ensureAgentsAndClaudeMd(
  projectPath: string,
  extras: AgentsMdTemplateExtras = {},
): { agents: { path: string; created: boolean }; claude: { path: string; created: boolean } } {
  return {
    agents: ensureAgentsMd(projectPath, extras),
    claude: ensureClaudeMd(projectPath),
  };
}

export type AgentsMdPatchKind = "create" | "update" | "append";

export type AgentsMdPatchInput = {
  run_id: string;
  project_path: string;
  section: string;
  kind: AgentsMdPatchKind;
  content_md: string;
};

export type ApplyAgentsMdPatchResult =
  | { patch_id: string; new_sha: string; prev_sha: string; status: "applied" }
  | { patch_id: string; new_sha: string; prev_sha: string; status: "noop_already_applied"; reason: string };

export function applyAgentsMdPatch(input: AgentsMdPatchInput): ApplyAgentsMdPatchResult {
  const { path } = ensureAgentsMd(input.project_path);
  const prev = readFileSync(path, "utf8");
  const prevSha = createHash("sha256").update(prev).digest("hex");

  // Idempotency: append-with-run-id-block already present → no-op.
  if (input.kind === "append") {
    const existingBody = sectionBody(prev, input.section);
    if (existingBody) {
      const headerRe = new RegExp(`Run\\s*\`?${escapeRe(input.run_id)}\`?`, "m");
      if (headerRe.test(existingBody) && headerRe.test(input.content_md)) {
        const id = `amp_${nanoid(10)}`;
        txImmediate(() => {
          db()
            .prepare(
              `INSERT INTO agents_md_patches(id, run_id, section, kind, prev_sha, new_sha, applied_at)
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
        };
      }
    }
  }

  // Anti-bloat: redirect history-class content to docs/agents-md-history.md
  if (input.kind === "append" && shouldRedirectToHistory(input.section, input.content_md)) {
    appendToHistory(input.project_path, input.section, input.content_md);
    const id = `amp_${nanoid(10)}`;
    txImmediate(() => {
      db()
        .prepare(
          `INSERT INTO agents_md_patches(id, run_id, section, kind, prev_sha, new_sha, applied_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`
        )
        .run(id, input.run_id, input.section, "redirected_to_history", prevSha, prevSha, new Date().toISOString());
    });
    return { patch_id: id, new_sha: prevSha, prev_sha: prevSha, status: "applied" };
  }

  // Anti-bloat: if append would exceed the 200-line cap, redirect to history
  if (input.kind === "append" && wouldExceedCap(prev, input.content_md)) {
    appendToHistory(input.project_path, input.section, input.content_md);
    const id = `amp_${nanoid(10)}`;
    txImmediate(() => {
      db()
        .prepare(
          `INSERT INTO agents_md_patches(id, run_id, section, kind, prev_sha, new_sha, applied_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`
        )
        .run(id, input.run_id, input.section, "redirected_over_cap", prevSha, prevSha, new Date().toISOString());
    });
    return { patch_id: id, new_sha: prevSha, prev_sha: prevSha, status: "applied" };
  }

  const next = patchSection(prev, input.section, input.content_md, input.kind);
  writeFileSync(path, next, "utf8");
  const newSha = createHash("sha256").update(next).digest("hex");

  const id = `amp_${nanoid(10)}`;
  txImmediate(() => {
    db()
      .prepare(
        `INSERT INTO agents_md_patches(id, run_id, section, kind, prev_sha, new_sha, applied_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(id, input.run_id, input.section, input.kind, prevSha, newSha, new Date().toISOString());
  });

  return { patch_id: id, new_sha: newSha, prev_sha: prevSha, status: "applied" };
}

/** Extract the body of a `## <section>` block. Empty string if absent. */
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

function patchSection(doc: string, section: string, body: string, kind: AgentsMdPatchKind): string {
  const heading = `## ${section}`;
  const headingRe = new RegExp(`^## ${escapeRe(section)}\\s*$`, "m");
  const match = headingRe.exec(doc);

  if (!match) {
    if (kind === "create" || kind === "append") {
      return doc.replace(/\n*$/, "\n") + `\n${heading}\n\n${body.trim()}\n`;
    }
    throw new Error(`section "${section}" not found in AGENTS.md`);
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
    bodyOut = `\n\n${body.trim()}\n\n`;
  }

  return doc.slice(0, start) + bodyOut + doc.slice(end);
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ─── Status ─────────────────────────────────────────────────────────────

export type AgentsMdStatus = {
  agents_md: {
    path: string;
    exists: boolean;
    bytes: number | null;
    line_count: number | null;
    over_adherence_cliff: boolean; // >200 lines per Anthropic guidance
    sections: Array<{ section: string; populated: boolean; bytes: number }>;
  };
  claude_md: {
    path: string;
    exists: boolean;
    bytes: number | null;
    imports_agents_md: boolean;
  };
};

export function agentsMdStatus(projectPath: string): AgentsMdStatus {
  const aPath = agentsMdPath(projectPath);
  const cPath = claudeMdPath(projectPath);

  let agents: AgentsMdStatus["agents_md"];
  if (!existsSync(aPath)) {
    agents = {
      path: aPath,
      exists: false,
      bytes: null,
      line_count: null,
      over_adherence_cliff: false,
      sections: AGENTS_MD_SECTIONS.map(s => ({ section: s, populated: false, bytes: 0 })),
    };
  } else {
    const text = readFileSync(aPath, "utf8");
    const bytes = statSync(aPath).size;
    const lineCount = text.split(/\r?\n/).length;
    const sections = AGENTS_MD_SECTIONS.map(s => {
      const re = new RegExp(`^## ${escapeRe(s)}\\s*([\\s\\S]*?)(?=\\n## |\\n*$)`, "m");
      const m = re.exec(text);
      const body = m ? (m[1] ?? "").trim() : "";
      const populated = body.length > 0 && !/^_To be populated/.test(body);
      return { section: s, populated, bytes: body.length };
    });
    agents = {
      path: aPath,
      exists: true,
      bytes,
      line_count: lineCount,
      over_adherence_cliff: lineCount > 200,
      sections,
    };
  }

  let claude: AgentsMdStatus["claude_md"];
  if (!existsSync(cPath)) {
    claude = { path: cPath, exists: false, bytes: null, imports_agents_md: false };
  } else {
    const text = readFileSync(cPath, "utf8");
    claude = {
      path: cPath,
      exists: true,
      bytes: statSync(cPath).size,
      imports_agents_md: /^@AGENTS\.md\b/m.test(text),
    };
  }

  return { agents_md: agents, claude_md: claude };
}
