/**
 * Unified hook dispatcher. The daemon binary handles all hooks via
 * `pp-daemon hook <event> <name>`. Each hook reads a JSON envelope on
 * stdin, applies a small piece of logic, and writes a JSON response on
 * stdout. Exit codes:
 *   0  — allow (with optional advisory stdout)
 *   2  — block (PreToolUse / Stop)
 *
 * Block decisions can also be expressed as JSON `{ "decision": "block",
 * "reason": "..." }` — Claude Code respects either convention.
 *
 * The hook envelope shape matches Claude Code's hook contract; we only
 * read the fields we need and ignore the rest.
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { nanoid } from "nanoid";
import { db, txImmediate } from "../db/database.js";
import { scanForSecrets } from "../security/secret-scan.js";
import { loopCeilingStatus } from "./../orchestrator/loop-ceiling.js";
import { doctor } from "../orchestrator/runs.js";
import { masterPlanStatus, applyMasterPlanPatch, ensureMasterPlan } from "../orchestrator/master-plan.js";
import { loadProjectProfile } from "../orchestrator/profiles.js";
import { evaluateGate, type GateType, type Profile } from "../orchestrator/gates.js";
import { evaluateShellSafety } from "./bash-safety.js";

type HookInput = {
  hook_event_name?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  tool_response?: Record<string, unknown>;
  prompt?: string;
  cwd?: string;
  session_id?: string;
  transcript_path?: string;
};

async function readStdin(): Promise<string> {
  return await new Promise<string>((resolve) => {
    let buf = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", c => { buf += c; });
    process.stdin.on("end", () => resolve(buf));
    process.stdin.on("error", () => resolve(buf));
    // If stdin closes immediately (no piped input), fall through.
    setTimeout(() => resolve(buf), 200);
  });
}

function reply(allow: boolean, message?: string, jsonExtras?: Record<string, unknown>): never {
  if (!allow) {
    if (message) {
      console.error(message);
    }
    process.exit(2);
  } else {
    if (message) console.log(message);
    if (jsonExtras) console.log(JSON.stringify(jsonExtras));
    process.exit(0);
  }
}

function activeRunForProject(project_path?: string): string | null {
  if (!project_path) return null;
  try {
    const row = db()
      .prepare(`SELECT id FROM runs WHERE project_path = ? AND status IN ('pending','running') ORDER BY started_at DESC LIMIT 1`)
      .get(project_path) as { id: string } | undefined;
    return row?.id ?? null;
  } catch { return null; }
}

const SECURITY_KEYWORD_RE = /\b(security|threat|owasp|cve|rbac|crypto|privacy|gdpr|sbom|injection|xss|csrf|sqli|hipaa|pci|pii|phi|sox|password|credential)\b|oauth|openid|saml|jwt|sso|auth/i;
const CONCURRENCY_KEYWORD_RE = /\b(concurren|thread|race|deadlock|atomic|mutex|lock|migration|migrat|schema|rollback)\w*/i;
const CODING_PROMPT_RE = /\b(implement|fix|add|remove|change|update|refactor|modify|write|create)\b.*\b(file|function|class|module|component|test|api|endpoint|route|schema)\b/i;

// ─── Hook handlers ───────────────────────────────────────────────────────

const HANDLERS: Record<string, Record<string, (input: HookInput) => Promise<void> | void>> = {
  SessionStart: {
    "daemon-up": async () => {
      // Fail closed: if the DB is unreachable or doctor() throws, block the
      // session. The only tools wired through MCP rely on the daemon, so a
      // green session start is meaningless if the daemon is dead.
      try {
        const report = await doctor() as { db_reachable?: boolean };
        if (!report.db_reachable) {
          reply(false, "[pp] daemon DB unreachable; restart pp-daemon and retry. Session start blocked.");
        }
        console.log("[pp] daemon ok.");
        reply(true);
      } catch (err) {
        reply(false, `[pp] daemon health check failed: ${err instanceof Error ? err.message : String(err)}. Session start blocked.`);
      }
    },
    "vendor-matrix": async () => {
      // Fail closed when the matrix is incomplete. A session that starts
      // with `cross_vendor_ready=false` will hit a hard wall the moment the
      // first /pp:run reaches a spec/design/security/contract gate; better
      // to refuse the session up front and tell the user to fix the matrix.
      // Override with PP_ALLOW_SINGLE_VENDOR=1 for read-only Codex-only use.
      const report = (await doctor()) as { cross_vendor_ready?: boolean; vendors_configured?: Record<string, boolean> };
      if (report.cross_vendor_ready) return reply(true);

      const configured = Object.entries(report.vendors_configured ?? {}).filter(([, v]) => v).map(([k]) => k);
      const advisory = `[pp] vendor matrix incomplete: only ${configured.join(", ") || "none"} configured. Cross-vendor gates (spec/design/security/contract) will refuse to run.`;

      if (process.env.PP_ALLOW_SINGLE_VENDOR === "1") {
        console.log(`${advisory} (PP_ALLOW_SINGLE_VENDOR=1 — proceeding anyway; cross-vendor gates will still refuse).`);
        return reply(true);
      }

      reply(
        false,
        `${advisory} Set OPENAI_API_KEY + GEMINI_API_KEY (or run \`codex login\` / \`gemini auth\`) before continuing. Session start blocked. Set PP_ALLOW_SINGLE_VENDOR=1 to bypass for read-only / single-vendor sessions.`,
      );
    },
    "cli-version-pin": async () => {
      const report = (await doctor()) as { cli_versions?: Record<string, string | null> };
      const v = report.cli_versions ?? {};
      const missing = Object.entries(v).filter(([, ver]) => !ver).map(([k]) => k);
      if (missing.length) console.log(`[pp] missing CLIs: ${missing.join(", ")}`);
      reply(true);
    },
    "master-plan-load": (input) => {
      if (!input.cwd) return reply(true);
      try {
        const status = masterPlanStatus(input.cwd);
        if (!status.exists) {
          console.log(`[pp] no PROJECT_MASTER.md yet — will be scaffolded on first /pp:run finalize.`);
        } else {
          const populated = status.sections.filter(s => s.populated).length;
          console.log(`[pp] PROJECT_MASTER.md: ${populated}/${status.sections.length} sections populated.`);
        }
      } catch { /* ignore */ }
      reply(true);
    },
    "surfaced-runs": (input) => {
      if (!input.cwd) return reply(true);
      try {
        const rows = db()
          .prepare(`SELECT id, request_text FROM runs WHERE project_path = ? AND status = 'surfaced' ORDER BY started_at DESC LIMIT 5`)
          .all(input.cwd) as Array<{ id: string; request_text: string }>;
        if (rows.length) {
          console.log(`[pp] ${rows.length} surfaced run(s) waiting:`);
          for (const r of rows) console.log(`  - ${r.id}: ${r.request_text.slice(0, 60)}`);
          console.log("Use /pp:retry <run_id> to resume.");
        }
      } catch { /* ignore */ }
      reply(true);
    },
  },

  PreToolUse: {
    "block-destructive-shell": (input) => {
      // Catch the rm -rf .next-from-wrong-cwd incident pattern. Smart-block:
      // allow routine cleanups when target resolves inside a project root;
      // block when the target escapes upward, equals/exceeds project root,
      // hits FS root / $HOME, or matches lateral destruction patterns
      // (find -delete, git clean -fdx above project root, force-push to
      // protected refs, dd / mkfs / shutdown / reboot, fork bomb).
      const tool = input.tool_name ?? "";
      if (tool !== "Bash" && tool !== "PowerShell") return reply(true);

      const command = (input.tool_input?.command ?? "") as string;
      if (!command) return reply(true);

      if (process.env.PP_ALLOW_DESTRUCTIVE === "1") {
        console.error("[pp] destructive-shell guard bypassed via PP_ALLOW_DESTRUCTIVE=1");
        return reply(true);
      }

      const cwd = (input.cwd ?? process.cwd()) as string;
      const verdict = evaluateShellSafety(command, cwd);
      if (verdict.decision === "block") {
        reply(false, `[pp] destructive-shell blocked (${verdict.pattern}): ${verdict.reason}`);
      }
      reply(true);
    },
    "enforce-active-run": (input) => {
      const tool = input.tool_name ?? "";
      const isCodeMod = /^(Edit|Write|NotebookEdit|MultiEdit)$/.test(tool);
      if (!isCodeMod) return reply(true);
      const filePath = (input.tool_input?.file_path ?? input.tool_input?.path) as string | undefined;
      if (!filePath) return reply(true);

      // Allow edits inside .harness/ — that's where artifacts live.
      if (filePath.includes(".harness")) return reply(true);

      // Allow edits inside the .claude/ plugin (the user is editing the harness, not running with it).
      if (filePath.includes(".claude")) return reply(true);

      // Escape hatch for ad-hoc edits when the user explicitly opts out.
      if (process.env.PP_ALLOW_AD_HOC === "1") return reply(true);

      const projectPath = input.cwd;
      const runId = activeRunForProject(projectPath);
      if (!runId) {
        reply(
          false,
          `[pp] no active run owns this edit (${filePath}). Start a run with /pp:run "<request>" so the change is taxonomy-mapped and judged, or set PP_ALLOW_AD_HOC=1 to bypass.`,
        );
      }
      reply(true);
    },
    "enforce-vendor-matrix": async (input) => {
      const tool = input.tool_name ?? "";
      if (!/pp_(codex|gemini)/.test(tool)) return reply(true);
      const report = (await doctor()) as { vendors_configured?: Record<string, boolean>; cross_vendor_ready?: boolean };
      const v = report.vendors_configured ?? {};
      const wantsCodex = /pp_codex/.test(tool);
      const wantsGemini = /pp_gemini/.test(tool);

      // 1. Direct vendor presence — block if the requested vendor is missing.
      if (wantsCodex && !v.openai)  reply(false, "[pp] pp_codex tools blocked: OpenAI not configured (set OPENAI_API_KEY or `codex login`).");
      if (wantsGemini && !v.google) reply(false, "[pp] pp_gemini tools blocked: Google not configured (set GEMINI_API_KEY or `gemini auth`).");

      // 2. Stage-aware: replicate gate_eligible_judges' decision (base tier
      // + content-aware upgrades + profile-aware upgrades) using the same
      // evaluateGate() function. If the active stage requires cross-vendor
      // and the matrix can't deliver it, block the call. This catches
      // upgraded gates the driver may have missed (e.g. enterprise profile
      // turning code_style into cross-vendor, or a security keyword in the
      // request escalating docs_polish).
      if (input.cwd) {
        const runId = activeRunForProject(input.cwd);
        if (runId) {
          const ctx = db()
            .prepare(
              `SELECT s.gate_type AS gate_type, r.request_text AS request_text, r.profile_snapshot_json AS profile_snapshot_json
                 FROM stages s JOIN runs r ON r.id = s.run_id
                WHERE s.run_id = ? AND s.status = 'open'
                ORDER BY s.started_at DESC LIMIT 1`,
            )
            .get(runId) as { gate_type: string; request_text: string; profile_snapshot_json: string | null } | undefined;
          if (ctx?.gate_type) {
            let profileName: Profile | undefined;
            if (ctx.profile_snapshot_json) {
              try {
                const snapshot = JSON.parse(ctx.profile_snapshot_json) as { name?: string };
                if (snapshot?.name) profileName = snapshot.name as Profile;
              } catch { /* ignore */ }
            }
            const decision = evaluateGate({
              gate_type:       ctx.gate_type as GateType,
              prompt_keywords: ctx.request_text,
              profile:         profileName,
            });
            if (decision.required_cross_vendor && !report.cross_vendor_ready) {
              reply(
                false,
                `[pp] active stage requires cross-vendor judging (${decision.reason}) but matrix is incomplete. Configure both vendors before continuing.`,
              );
            }
          }
        }
      }

      reply(true);
    },
    "enforce-sandbox-policy": (input) => {
      const tool = input.tool_name ?? "";
      if (!/pp_codex.*generate/.test(tool)) return reply(true);
      const sandbox = (input.tool_input?.sandbox ?? "read-only") as string;

      // Block danger-full-access unconditionally unless explicitly allowed.
      if (sandbox === "danger-full-access" && process.env.PP_ALLOW_DANGER !== "1") {
        reply(false, `[pp] sandbox=danger-full-access blocked. Use 'workspace-write' or set PP_ALLOW_DANGER=1.`);
      }

      // Stage-aware policy: read-only stages must use read-only sandbox.
      // Writeable stages may use workspace-write. The active stage is the
      // most recently-opened stage on the active run for this project.
      if (input.cwd) {
        const runId = activeRunForProject(input.cwd);
        if (runId) {
          const stage = db()
            .prepare(`SELECT kind FROM stages WHERE run_id = ? AND status = 'open' ORDER BY started_at DESC LIMIT 1`)
            .get(runId) as { kind: string } | undefined;
          const kind = stage?.kind;
          const READ_ONLY_KINDS = new Set(["spec", "design", "architecture", "contracts", "security", "ux", "design_system", "governance", "ai-controls", "retirement", "release-plan", "ops", "data"]);
          const WRITE_KINDS = new Set(["code", "tests", "docs"]);
          if (kind && READ_ONLY_KINDS.has(kind) && sandbox !== "read-only") {
            reply(false, `[pp] active stage kind=${kind} requires sandbox=read-only; got ${sandbox}.`);
          }
          if (kind && WRITE_KINDS.has(kind) && sandbox === "read-only") {
            // Allow read-only on a writable stage (a generator may legitimately just analyze first),
            // but warn so the user notices a likely misconfig.
            console.log(`[pp] note: stage kind=${kind} typically uses workspace-write; sandbox=read-only is unusual.`);
          }
        }
      }
      reply(true);
    },
    "enforce-no-secrets": (input) => {
      const tool = input.tool_name ?? "";
      const isWrite = /^(Edit|Write|MultiEdit|mcp__pp_harness__archive_artifact)$/.test(tool);
      if (!isWrite) return reply(true);
      const content = (input.tool_input?.content
        ?? input.tool_input?.new_string
        ?? input.tool_input?.bytes
        ?? "") as string;
      if (!content) return reply(true);
      const matches = scanForSecrets(content);
      if (matches.length) {
        reply(false, `[pp] secret scanner blocked write: ${matches.length} match(es): ${matches.map(m => m.kind).slice(0, 3).join(", ")}.`);
      }
      reply(true);
    },
    "enforce-validator-gate": (input) => {
      const tool = input.tool_name ?? "";
      const isCodeMod = /^(Edit|Write|MultiEdit)$/.test(tool);
      if (!isCodeMod || !input.cwd) return reply(true);
      const runId = activeRunForProject(input.cwd);
      if (!runId) return reply(true);

      const filePath = (input.tool_input?.file_path ?? input.tool_input?.path) as string | undefined;
      // Edits inside .harness/ are part of the run's own bookkeeping; allow them.
      if (filePath && filePath.includes(".harness")) return reply(true);

      // Find the most recent verdict in the active run. If it failed AND no
      // Reflexion retry has happened since (no later attempt with retry_index >= 1
      // on the same stage), block the edit. The driver MUST call retry_with_critique
      // before resuming work.
      const row = db()
        .prepare(
          `SELECT v.outcome AS outcome, v.created_at AS verdict_at, a.stage_id AS stage_id
             FROM verdicts v JOIN attempts a ON a.id = v.attempt_id
             JOIN stages s ON s.id = a.stage_id
            WHERE s.run_id = ?
            ORDER BY v.created_at DESC LIMIT 1`,
        )
        .get(runId) as { outcome: string; verdict_at: string; stage_id: string } | undefined;
      if (!row || row.outcome !== "fail") return reply(true);

      const retried = db()
        .prepare(
          `SELECT 1 FROM attempts WHERE stage_id = ? AND retry_index >= 1 AND created_at > ? LIMIT 1`,
        )
        .get(row.stage_id, row.verdict_at) as unknown;
      if (retried) return reply(true);

      reply(
        false,
        `[pp] the latest verdict on this run is 'fail' and no Reflexion retry has happened. Invoke the reflexion-coach agent (or call retry_with_critique) before resuming code edits, or set PP_ALLOW_AD_HOC=1 to bypass.`,
      );
    },
    "enforce-rfc2119-language": (input) => {
      const tool = input.tool_name ?? "";
      if (!/^(Write|Edit|mcp__pp_harness__archive_artifact)$/.test(tool)) return reply(true);
      const path = (input.tool_input?.file_path ?? input.tool_input?.path ?? input.tool_input?.relative_path ?? "") as string;
      const content = (input.tool_input?.content ?? input.tool_input?.new_string ?? input.tool_input?.bytes ?? "") as string;
      if (!content || content.length < 200) return reply(true);

      const isSpecShapedPath = /(\bspec\b|\bprd\b|requirements|\badr\b)/i.test(path);
      // For archive_artifact calls, also check the staged taxonomy_section / kind.
      const taxonomySection = (input.tool_input?.taxonomy_section ?? "") as string;
      const kind = (input.tool_input?.kind ?? "") as string;
      const isSpecStage = taxonomySection === "4.3" || /^(prd|spec|adr|acceptance_criteria|nfrs)$/i.test(kind);

      if (!isSpecShapedPath && !isSpecStage) return reply(true);

      const hasNormative = /\b(MUST|MUST NOT|SHALL|SHOULD|SHOULD NOT|MAY|REQUIRED|RECOMMENDED|OPTIONAL)\b/.test(content);
      if (hasNormative) return reply(true);

      // Spec-shaped writes inside an active run with no normative language is a hard fail —
      // the spec is not testable as a contract. Outside a run (e.g. user editing a doc by hand),
      // downgrade to a warning so we don't break ad-hoc note-taking.
      if (input.cwd && activeRunForProject(input.cwd)) {
        reply(
          false,
          `[pp] spec-shaped artifact at ${path || kind || "(unknown)"} lacks RFC 2119 normative keywords (MUST/SHOULD/MAY). Add them or change the artifact kind. Set PP_ALLOW_AD_HOC=1 to bypass.`,
        );
      }
      console.log(`[pp] RFC 2119 advisory: spec-shaped artifact at ${path || "(unknown)"} contains no normative keywords (MUST/SHOULD/MAY).`);
      reply(true);
    },
  },

  PostToolUse: {
    "cost-tally": (input) => {
      const tool = input.tool_name ?? "";
      if (!/pp_(codex|gemini)/.test(tool)) return reply(true);
      const resp = input.tool_response as { tokens_in?: number; tokens_out?: number; cost_usd?: number; model?: string } | undefined;
      if (resp && (resp.tokens_in || resp.tokens_out || resp.cost_usd)) {
        console.log(`[pp] +${resp.tokens_in ?? 0}/${resp.tokens_out ?? 0} tok, $${(resp.cost_usd ?? 0).toFixed(4)} (${resp.model ?? "?"})`);
      }
      reply(true);
    },
    "record-attempt": (input) => {
      // Backstop: when an MCP call to a vendor tool happens outside an
      // agent-driven flow (e.g. an ad-hoc test invocation), insert a
      // minimal attempts row tagged direct_cli=1 in producer so audit
      // queries can find it. Real agent-driven calls already record their
      // own attempts; this hook only fires when the response carries a
      // `direct_cli` marker (the wrappers set this when the daemon detects
      // no in-flight stage). Without that marker, no-op.
      const tool = input.tool_name ?? "";
      if (!/pp_(codex|gemini)/.test(tool)) return reply(true);
      const resp = input.tool_response as
        | { direct_cli?: boolean; tokens_in?: number; tokens_out?: number; cost_usd?: number; model?: string; wall_ms?: number }
        | undefined;
      if (!resp?.direct_cli) return reply(true);
      try {
        const producer = /pp_codex/.test(tool) ? "codex" : "gemini";
        const stageId = `direct_${nanoid(8)}`;
        // Synthesize a stub stage if no run is active; this preserves an audit trail
        // without requiring the user to start a run first.
        const projectPath = input.cwd ?? "(unknown)";
        const runId = activeRunForProject(projectPath) ?? `direct_run_${nanoid(8)}`;
        txImmediate(() => {
          db()
            .prepare(
              `INSERT OR IGNORE INTO runs(id, project_path, request_text, mode, status, started_at)
                 VALUES (?, ?, ?, ?, ?, ?)`,
            )
            .run(runId, projectPath, "(direct CLI invocation)", "single", "complete", new Date().toISOString());
          db()
            .prepare(
              `INSERT OR IGNORE INTO stages(id, run_id, kind, gate_type, status, started_at, finished_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?)`,
            )
            .run(stageId, runId, "direct", "code_style", "passed", new Date().toISOString(), new Date().toISOString());
          db()
            .prepare(
              `INSERT INTO attempts(id, stage_id, producer, model_id, tokens_in, tokens_out, cost_usd, wall_ms, retry_index, status, created_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            )
            .run(
              `attempt_${nanoid(10)}`,
              stageId,
              producer,
              resp.model ?? "unknown",
              resp.tokens_in ?? null,
              resp.tokens_out ?? null,
              resp.cost_usd ?? null,
              resp.wall_ms ?? null,
              0,
              "ok",
              new Date().toISOString(),
            );
        });
      } catch (err) {
        console.error(`[pp] record-attempt backstop failed: ${err instanceof Error ? err.message : String(err)}`);
      }
      reply(true);
    },
    "taxonomy-coverage-update": (input) => {
      const tool = input.tool_name ?? "";
      if (tool !== "mcp__pp_harness__archive_artifact") return reply(true);
      const section = (input.tool_input?.taxonomy_section ?? "") as string;
      if (section) console.log(`[pp] taxonomy section ${section} +1 artifact`);
      reply(true);
    },
    "hash-artifact": (input) => {
      // Verify: after archive_artifact succeeds, recompute the on-disk
      // sha256 and confirm it matches the row. A mismatch usually means
      // the file was edited between the daemon's write and our read,
      // which is suspicious — surface it for /pp:doctor to investigate.
      const tool = input.tool_name ?? "";
      if (tool !== "mcp__pp_harness__archive_artifact") return reply(true);
      const resp = input.tool_response as { absolute_path?: string; sha256?: string; status?: string } | undefined;
      if (!resp?.absolute_path || !resp.sha256 || resp.status !== "ok") return reply(true);
      try {
        if (existsSync(resp.absolute_path)) {
          const onDisk = readFileSync(resp.absolute_path, "utf8");
          const current = createHash("sha256").update(onDisk).digest("hex");
          if (current !== resp.sha256) {
            console.error(
              `[pp] hash-artifact: sha mismatch immediately after write at ${resp.absolute_path} ` +
              `(stored=${resp.sha256.slice(0, 12)}…, current=${current.slice(0, 12)}…). ` +
              `Manual edit between write and verify? Run /pp:doctor.`,
            );
          }
        }
      } catch (err) {
        console.error(`[pp] hash-artifact verify failed: ${err instanceof Error ? err.message : String(err)}`);
      }
      reply(true);
    },
    "loop-ceiling-tally": (input) => {
      const tool = input.tool_name ?? "";
      if (tool !== "mcp__pp_harness__record_verdict") return reply(true);
      const stageId = (input.tool_input?.attempt_id ?? "") as string;
      try {
        const row = db()
          .prepare(`SELECT s.run_id FROM stages s JOIN attempts a ON a.stage_id = s.id WHERE a.id = ?`)
          .get(stageId) as { run_id?: string } | undefined;
        if (row?.run_id) {
          const status = loopCeilingStatus(row.run_id);
          if (status.remaining <= 2) {
            console.log(`[pp] loop ceiling: ${status.validator_calls}/${status.ceiling} (${status.remaining} remaining).`);
          }
          if (status.blocked) {
            console.log(`[pp] LOOP CEILING REACHED. Further retry_with_critique calls will be rejected.`);
          }
        }
      } catch { /* ignore */ }
      reply(true);
    },
    "verdict-rubric-coverage": (input) => {
      const tool = input.tool_name ?? "";
      if (tool !== "mcp__pp_harness__record_verdict") return reply(true);
      const score = (input.tool_input?.score_json ?? null) as Record<string, number> | null;
      if (score && Object.keys(score).length < 3) {
        console.log(`[pp] WARNING: verdict has only ${Object.keys(score).length} rubric dimension(s). Judge may have skipped scoring.`);
      }
      reply(true);
    },
    "update-master-plan": (input) => {
      // After finalize_run, scaffold PROJECT_MASTER.md if absent. The daemon's
      // finalize_run path already calls applyMasterPlanPatch on `complete`, so
      // this hook is a defense-in-depth: if the run is `complete` and no
      // master_plan_patches row exists for this run, fold the artifacts in.
      const tool = input.tool_name ?? "";
      if (tool !== "mcp__pp_harness__finalize_run") return reply(true);
      const args = (input.tool_input ?? {}) as { run_id?: string; status?: string };
      const runId = args.run_id;
      if (!runId) return reply(true);

      const run = db()
        .prepare(`SELECT project_path, status FROM runs WHERE id = ?`)
        .get(runId) as { project_path: string; status: string } | undefined;
      if (!run) return reply(true);
      if (run.status !== "complete") return reply(true);

      try {
        ensureMasterPlan(run.project_path);
        const patched = db()
          .prepare(`SELECT 1 FROM master_plan_patches WHERE run_id = ? AND kind != 'surfaced_skip' LIMIT 1`)
          .get(runId) as unknown;
        if (patched) {
          console.log(`[pp] master-plan: ${runId} already patched.`);
          return reply(true);
        }
        // Defer to applyMasterPlanPatch via a tiny inline summary block. The
        // canonical patcher lives in finalize_run/runs.ts; this is a backstop.
        applyMasterPlanPatch({
          run_id: runId,
          project_path: run.project_path,
          section: "1. Executive summary",
          kind: "append",
          content_md: `### Run \`${runId}\`\n\n- Run finalized via PostToolUse backstop.\n`,
        });
        console.log(`[pp] master-plan backstop patched ${runId}.`);
      } catch (err) {
        console.error(`[pp] update-master-plan hook failed: ${err instanceof Error ? err.message : String(err)}`);
      }
      reply(true);
    },
  },

  UserPromptSubmit: {
    "taxonomy-nudge": (input) => {
      const p = input.prompt ?? "";
      if (!CODING_PROMPT_RE.test(p)) return reply(true);
      if (/\/pp:/i.test(p)) return reply(true);
      console.log(`[pp] this looks code-shaped — consider /pp:run for taxonomy-aware execution with cross-vendor validation.`);
      reply(true);
    },
    "team-suggester": (input) => {
      const p = input.prompt ?? "";
      const suggestions: string[] = [];
      if (/\bbug|fix|crash|regression\b/i.test(p)) suggestions.push("/pp:team bug-fix-team");
      if (/\brefactor|cleanup|extract|simplify\b/i.test(p)) suggestions.push("/pp:team refactor-team");
      if (/\bsecurity|threat|asvs|owasp\b/i.test(p)) suggestions.push("/pp:team security-review-team");
      if (/\bdesign|wireframe|ux|ui|accessibility|a11y|wcag\b/i.test(p)) suggestions.push("/pp:team ux-team");
      if (/\bdeprecate|sunset|retire|eol\b/i.test(p)) suggestions.push("/pp:team retirement-team");
      if (suggestions.length) console.log(`[pp] team suggestions: ${suggestions.join("  |  ")}`);
      reply(true);
    },
    "risk-flag": (input) => {
      const p = input.prompt ?? "";
      if (SECURITY_KEYWORD_RE.test(p) || CONCURRENCY_KEYWORD_RE.test(p)) {
        console.log(`[pp] risk-flag: prompt contains security/concurrency keyword — gate_eligible_judges will auto-elevate to cross-vendor.`);
      }
      reply(true);
    },
    "surfaced-run-reminder": (input) => {
      if (!input.cwd) return reply(true);
      try {
        const rows = db()
          .prepare(`SELECT id FROM runs WHERE project_path = ? AND status = 'surfaced' ORDER BY started_at DESC LIMIT 1`)
          .get(input.cwd) as { id: string } | undefined;
        if (rows?.id) console.log(`[pp] reminder: surfaced run ${rows.id} is awaiting attention. /pp:retry ${rows.id}`);
      } catch { /* ignore */ }
      reply(true);
    },
    "profile-aware-nudge": (input) => {
      if (!input.cwd) return reply(true);
      const profile = loadProjectProfile(input.cwd);
      if (!profile) return reply(true);
      if (profile.name === "enterprise") console.log(`[pp] profile=enterprise: SBOM and audit obligations active. Cross-vendor on every gate.`);
      if (profile.name === "ai-agentic") console.log(`[pp] profile=ai-agentic: eval suite + HITL workflow are required artifacts.`);
      reply(true);
    },
  },

  Stop: {
    "decision-log-required": (input) => {
      // If the active run touched architecture (verdicts on stages of kind
      // 'architecture' / 'design') but produced no governance/decision-log
      // artifact, block the stop with an explanation. Fires only when a
      // run is in 'running' state at Stop — completed runs are handled by
      // the finalizer.
      if (!input.cwd) return reply(true);
      const runId = activeRunForProject(input.cwd);
      if (!runId) return reply(true);
      const archStage = db()
        .prepare(
          `SELECT 1 FROM stages WHERE run_id = ? AND kind IN ('architecture','design') AND status = 'passed' LIMIT 1`,
        )
        .get(runId) as unknown;
      if (!archStage) return reply(true);
      const decisionArtifact = db()
        .prepare(
          `SELECT 1 FROM artifacts WHERE run_id = ? AND (taxonomy_section = '4.14' OR kind IN ('decision_log','adr')) LIMIT 1`,
        )
        .get(runId) as unknown;
      if (decisionArtifact) return reply(true);
      // Block on the missing decision log unless the user opted out.
      if (process.env.PP_ALLOW_AD_HOC === "1") return reply(true);
      reply(
        false,
        `[pp] active run ${runId} passed an architecture/design stage but produced no decision-log/ADR artifact (4.14). Add an ADR or decision-log entry before stopping, or set PP_ALLOW_AD_HOC=1.`,
      );
    },
    "summary-format-check": (input) => {
      // Read the transcript path if present and look at the final assistant
      // message for the conventional "what changed" + "what's next" pattern.
      // This is purely advisory — never block.
      const transcriptPath = (input as { transcript_path?: string }).transcript_path;
      if (!transcriptPath || !existsSync(transcriptPath)) return reply(true);
      try {
        const lines = readFileSync(transcriptPath, "utf8").split(/\r?\n/).slice(-200);
        let lastAssistant = "";
        for (let i = lines.length - 1; i >= 0; i--) {
          try {
            const evt = JSON.parse(lines[i]!) as { type?: string; role?: string; content?: unknown };
            if (evt.role === "assistant" || evt.type === "assistant") {
              lastAssistant = typeof evt.content === "string" ? evt.content : JSON.stringify(evt.content ?? "");
              break;
            }
          } catch { /* not JSON */ }
        }
        if (!lastAssistant) return reply(true);
        const tail = lastAssistant.slice(-1500).toLowerCase();
        const hasChanged = /(what changed|changes|summary|completed|done|fixed|added|updated)/.test(tail);
        const hasNext = /(next|todo|remaining|follow[- ]?up|outstanding|left to do)/.test(tail);
        if (!(hasChanged && hasNext)) {
          console.log(`[pp] summary-format advisory: end-of-turn summary should describe what changed AND what's next.`);
        }
      } catch { /* ignore */ }
      reply(true);
    },
  },
};

export async function runHookDispatcher(args: string[]): Promise<void> {
  const event = args[0];
  const name = args[1];
  if (!event || !name) {
    console.error(`usage: pp-daemon hook <event> <name>\nevents: ${Object.keys(HANDLERS).join(", ")}`);
    process.exit(2);
  }
  const handler = HANDLERS[event]?.[name];
  if (!handler) {
    console.error(`[pp] unknown hook ${event}/${name}; allowing.`);
    process.exit(0);
  }
  const stdin = await readStdin();
  let input: HookInput = {};
  try { input = stdin ? JSON.parse(stdin) as HookInput : {}; } catch { /* ignore */ }
  try {
    await handler(input);
    process.exit(0);
  } catch (err) {
    console.error(`[pp] hook ${event}/${name} crashed: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(0);
  }
}
