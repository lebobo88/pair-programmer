/**
 * Sub-CLI session continuity. The Codex and Gemini CLIs both emit a
 * session id on first invocation and accept a resume flag on subsequent
 * turns. We track `(project_path, agent) → session_id` so follow-up
 * calls in the same project keep the conversation context.
 *
 * If the row is missing (cold start), the wrapper synthesizes a recap
 * prompt summarizing the last few archived artifacts so the sub-CLI has
 * grounding without us silently starting fresh.
 */
import { db, txImmediate } from "../db/database.js";
import { log } from "../util/logger.js";

export type SubAgent = "codex" | "gemini" | "copilot";

export type SubSession = {
  project_path: string;
  agent: SubAgent;
  session_id: string;
  last_used_at: string;
};

const STALE_AFTER_MS = 24 * 60 * 60 * 1000; // 24h — sessions older than this are treated as missing.

export function getSession(projectPath: string, agent: SubAgent): SubSession | null {
  try {
    const row = db()
      .prepare(`SELECT * FROM sub_cli_sessions WHERE project_path = ? AND agent = ?`)
      .get(projectPath, agent) as SubSession | undefined;
    if (!row) return null;
    const ageMs = Date.now() - new Date(row.last_used_at).getTime();
    if (Number.isFinite(ageMs) && ageMs > STALE_AFTER_MS) {
      log.info({ projectPath, agent, ageMs }, "sub_cli_session expired");
      return null;
    }
    return row;
  } catch (err) {
    log.warn({ err }, "getSession failed");
    return null;
  }
}

export function setSession(projectPath: string, agent: SubAgent, sessionId: string): void {
  if (!sessionId) return;
  const now = new Date().toISOString();
  try {
    txImmediate(() => {
      db()
        .prepare(
          `INSERT INTO sub_cli_sessions(project_path, agent, session_id, last_used_at)
             VALUES (?, ?, ?, ?)
           ON CONFLICT(project_path, agent) DO UPDATE SET
             session_id   = excluded.session_id,
             last_used_at = excluded.last_used_at`,
        )
        .run(projectPath, agent, sessionId, now);
    });
  } catch (err) {
    log.warn({ err, projectPath, agent }, "setSession failed");
  }
}

export function touchSession(projectPath: string, agent: SubAgent): void {
  try {
    txImmediate(() => {
      db()
        .prepare(`UPDATE sub_cli_sessions SET last_used_at = ? WHERE project_path = ? AND agent = ?`)
        .run(new Date().toISOString(), projectPath, agent);
    });
  } catch { /* ignore */ }
}

/**
 * Synthesize a compact context recap for a cold-start invocation. Returns
 * the most recent verdict critiques + artifact paths from the project's
 * latest finalized run so the sub-CLI doesn't start from zero.
 */
export function synthesizeRecap(projectPath: string, _agent: SubAgent): string {
  try {
    const lastRun = db()
      .prepare(
        `SELECT id, request_text, status FROM runs WHERE project_path = ? AND status IN ('complete','surfaced')
           ORDER BY started_at DESC LIMIT 1`,
      )
      .get(projectPath) as { id: string; request_text: string; status: string } | undefined;
    if (!lastRun) return "";

    const artifacts = db()
      .prepare(
        `SELECT taxonomy_section, kind, path FROM artifacts WHERE run_id = ?
           ORDER BY created_at DESC LIMIT 8`,
      )
      .all(lastRun.id) as Array<{ taxonomy_section: string | null; kind: string | null; path: string }>;
    const verdicts = db()
      .prepare(
        `SELECT outcome, critique_md FROM verdicts v
           JOIN attempts a ON a.id = v.attempt_id
           JOIN stages s ON s.id = a.stage_id
          WHERE s.run_id = ? AND v.critique_md IS NOT NULL
          ORDER BY v.created_at DESC LIMIT 2`,
      )
      .all(lastRun.id) as Array<{ outcome: string; critique_md: string | null }>;

    const lines: string[] = [
      `Context recap (no live session — starting fresh):`,
      `- Last run: ${lastRun.id} (${lastRun.status}) — ${lastRun.request_text.slice(0, 200)}`,
    ];
    if (artifacts.length) {
      lines.push(`- Recent artifacts:`);
      for (const a of artifacts) {
        lines.push(`  • ${a.path}${a.kind ? ` (${a.kind})` : ""}${a.taxonomy_section ? ` [${a.taxonomy_section}]` : ""}`);
      }
    }
    if (verdicts.length) {
      lines.push(`- Recent verdicts:`);
      for (const v of verdicts) {
        const c = (v.critique_md ?? "").slice(0, 240).replaceAll("\n", " ");
        lines.push(`  • ${v.outcome}: ${c}`);
      }
    }
    return lines.join("\n") + "\n";
  } catch (err) {
    log.warn({ err }, "synthesizeRecap failed");
    return "";
  }
}
