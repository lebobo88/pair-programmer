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
import { agyEnabled } from "../config.js";
import { evaluateShellSafety } from "./bash-safety.js";
import { recallProjectContext, recallByQuery, listPriorCritiques } from "../ecosystem/eights-writes.js";
import { computeCost } from "../util/prices.js";
import {
  deriveCallKey,
  writeExecutionEvent,
  tallyFailedSpend,
  tallySuccessSpend,
  classifyStopFailureReason,
  findSubagentDispatchMatch,
  markDispatchReconciled,
} from "../orchestrator/execution-events.js";

type HookInput = {
  hook_event_name?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  tool_response?: Record<string, unknown>;
  prompt?: string;
  cwd?: string;
  session_id?: string;
  transcript_path?: string;
  // R10 (Phase H): fields platform docs describe as present "when running
  // with --agent or inside a subagent" (agent_id, agent_type), plus the
  // per-turn identifiers used to derive an idempotent call_key
  // (prompt_id), and two fields carried by several of the newer event
  // types (permission_mode, effort). normalizeHookInput previously dropped
  // every field it did not name (R10's whole reason for existing) — a
  // silent drop here is exactly the R27 vacuity class this phase names,
  // so every one of these is now named explicitly rather than left to fall
  // through.
  agent_id?: string;
  agent_type?: string;
  prompt_id?: string;
  permission_mode?: string;
  effort?: string;
  // FileChanged (R8): the watched file's path. Not documented under a
  // single canonical field name, so both plausible spellings are read.
  file_path?: string;
  // StopFailure (R7): the platform's classification of why the turn ended.
  reason?: string;
};

let CURRENT_EVENT = "";

function parseMaybeJson<T>(value: T): T | unknown {
  if (typeof value !== "string") return value;
  try { return JSON.parse(value) as unknown; } catch { return value; }
}

function normalizeToolName(name: unknown): string | undefined {
  if (typeof name !== "string" || !name) return undefined;
  const lower = name.toLowerCase();
  const builtinMap: Record<string, string> = {
    bash: "Bash",
    powershell: "PowerShell",
    edit: "Edit",
    create: "Write",
    grep: "Grep",
    glob: "Glob",
    view: "Read",
    task: "Task",
    ask_user: "AskUserQuestion",
    web_fetch: "WebFetch",
  };
  if (builtinMap[lower]) return builtinMap[lower];
  const mcp = name.match(/^([A-Za-z0-9_-]+)[/:]([A-Za-z0-9_-]+)$/);
  if (mcp) return `mcp__${mcp[1]!}__${mcp[2]!.replace(/-/g, "_")}`;
  return name;
}

function normalizeHookInput(raw: unknown): HookInput {
  const input = (raw ?? {}) as Record<string, unknown>;
  const toolInput = parseMaybeJson(input.tool_input ?? input.toolArgs ?? input.tool_args);
  return {
    hook_event_name: (input.hook_event_name ?? input.hookEventName) as string | undefined,
    tool_name: normalizeToolName(input.tool_name ?? input.toolName),
    tool_input: (typeof toolInput === "string" ? parseMaybeJson(toolInput) : toolInput) as Record<string, unknown> | undefined,
    tool_response: (input.tool_response ?? input.toolResult ?? input.tool_result) as Record<string, unknown> | undefined,
    prompt: (input.prompt ?? input.initial_prompt ?? input.initialPrompt) as string | undefined,
    cwd: input.cwd as string | undefined,
    session_id: (input.session_id ?? input.sessionId) as string | undefined,
    transcript_path: (input.transcript_path ?? input.transcriptPath) as string | undefined,
    // R10: carried through undefined (never null/"") when the envelope omits
    // them, matching every other optional field's contract above.
    agent_id: (input.agent_id ?? input.agentId) as string | undefined,
    agent_type: (input.agent_type ?? input.agentType) as string | undefined,
    prompt_id: (input.prompt_id ?? input.promptId) as string | undefined,
    permission_mode: (input.permission_mode ?? input.permissionMode) as string | undefined,
    effort: input.effort as string | undefined,
    file_path: (input.file_path ?? input.filePath ?? input.path) as string | undefined,
    reason: input.reason as string | undefined,
  };
}

export { normalizeHookInput };

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
  const structuredPreToolUse = CURRENT_EVENT === "PreToolUse";
  const structuredStop = CURRENT_EVENT === "Stop";
  if (!allow) {
    if (structuredPreToolUse) {
      process.stdout.write(JSON.stringify({
        permissionDecision: "deny",
        permissionDecisionReason: message ?? "[pp] blocked by hook",
        ...(jsonExtras ?? {}),
      }));
      process.exit(0);
    }
    if (structuredStop) {
      process.stdout.write(JSON.stringify({
        decision: "block",
        reason: message ?? "[pp] blocked by hook",
        ...(jsonExtras ?? {}),
      }));
      process.exit(0);
    }
    if (message) {
      console.error(message);
    }
    process.exit(2);
  } else {
    if (structuredPreToolUse || structuredStop) {
      if (message) console.error(message);
      process.exit(0);
    }
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
        `${advisory} Set OPENAI_API_KEY + (GEMINI_API_KEY or ANTIGRAVITY_API_KEY) (or run \`codex login\` / \`agy\` to sign in) before continuing. Session start blocked. Set PP_ALLOW_SINGLE_VENDOR=1 to bypass for read-only / single-vendor sessions.`,
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
        // RA-4: exclude runs the operator has already acknowledged via ack_run.
        const rows = db()
          .prepare(`SELECT id, request_text FROM runs WHERE project_path = ? AND status = 'surfaced' AND acked_at IS NULL ORDER BY started_at DESC LIMIT 5`)
          .all(input.cwd) as Array<{ id: string; request_text: string }>;
        if (rows.length) {
          console.log(`[pp] ${rows.length} surfaced run(s) waiting:`);
          for (const r of rows) console.log(`  - ${r.id}: ${r.request_text.slice(0, 60)}`);
          console.log("Use /pp:retry <run_id> to resume, or pp_harness.ack_run to dismiss.");
        }
      } catch { /* ignore */ }
      reply(true);
    },
    // Phase B / T1.2 — recall recent context from TheEights episodic memory.
    // Silent no-op when TheEights is offline (graceful degradation). The
    // summary line surfaces in Claude's startup context so subsequent turns
    // know whether prior work exists.
    "eights-recall-project": async (input) => {
      if (!input.cwd) return reply(true);
      try {
        const summary = await recallProjectContext(input.cwd, 10);
        if (!summary || summary.total_hits === 0) return reply(true);
        console.log(
          `[pp] eights recall: ${summary.prior_runs} prior run(s), ` +
          `${summary.incidents} incident(s), ${summary.evaluations} verdict(s) ` +
          `in episodic memory for this project.`
        );
        for (const entry of summary.top) {
          console.log(`  - [${entry.type}] ${entry.handle ?? "(no-handle)"}: ${entry.summary}`);
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
      if (!/pp_(codex|agy)/.test(tool)) return reply(true);
      const report = (await doctor()) as { vendors_configured?: Record<string, boolean>; cross_vendor_ready?: boolean };
      const v = report.vendors_configured ?? {};
      const wantsCodex = /pp_codex/.test(tool);
      const wantsAgy = /pp_agy/.test(tool);

      // 1. Direct vendor presence — block if the requested vendor is missing.
      if (wantsCodex && !v.openai)  reply(false, "[pp] pp_codex tools blocked: OpenAI not configured (set OPENAI_API_KEY or `codex login`).");
      if (wantsAgy && !v.google) {
        const why = !agyEnabled()
          ? "disabled via PP_DISABLE_AGY=1 (unset it to re-enable)"
          : "Google not configured (set GEMINI_API_KEY/ANTIGRAVITY_API_KEY or sign in via `agy`)";
        reply(false, `[pp] pp_agy tools blocked: ${why}.`);
      }

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
        reply(
          false,
          `[pp] secret scanner refused this write: nothing was written. ${matches.length} match(es): ${matches.map(m => m.kind).slice(0, 3).join(", ")}. ` +
          `Move the value to an environment variable and reference it, per AGENTS.md Security ("Credentials must be env vars — not hardcoded"). ` +
          `There is deliberately no bypass environment variable for this guard.`,
        );
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
    // Phase B / T1.2 — when a stage opens, pull prior verdicts on the same
    // stage_kind in this project so the generator agent has cross-run
    // critique context. Matcher in hooks.json restricts this to start_stage.
    "eights-recall-stage": async (input) => {
      if (!input.cwd) return reply(true);
      const tool = input.tool_name ?? "";
      if (!tool.endsWith("__start_stage")) return reply(true);
      const stageKind =
        typeof input.tool_input?.kind === "string" ? (input.tool_input.kind as string) : null;
      if (!stageKind) return reply(true);
      try {
        const critiques = await listPriorCritiques({
          stage_kind: stageKind,
          project_path: input.cwd,
          k: 3,
        });
        if (critiques.length === 0) return reply(true);
        const failed = critiques.filter(c => c.outcome === "fail" || c.outcome === "revise").length;
        console.log(
          `[pp] eights recall (stage=${stageKind}): ${critiques.length} prior verdict(s), ${failed} fail/revise. ` +
          `Reflexion∞: the reflexion-coach should pull these via list_prior_critiques on retry.`
        );
        for (const c of critiques.slice(0, 2)) {
          console.log(`  - [${c.outcome}] ${c.summary || c.content.slice(0, 120)}`);
        }
      } catch { /* ignore */ }
      reply(true);
    },
  },

  PostToolUse: {
    "cost-tally": (input) => {
      const tool = input.tool_name ?? "";
      if (!/pp_(codex|agy)/.test(tool)) return reply(true);
      const resp = input.tool_response as
        | { direct_cli?: boolean; tokens_in?: number; tokens_out?: number; cost_usd?: number; model?: string; wall_ms?: number }
        | undefined;
      if (resp && (resp.tokens_in || resp.tokens_out || resp.cost_usd)) {
        console.log(`[pp] +${resp.tokens_in ?? 0}/${resp.tokens_out ?? 0} tok, $${(resp.cost_usd ?? 0).toFixed(4)} (${resp.model ?? "?"})`);
      }
      // R16/R28 (Phase H, GitHub #58 second half; HIGH-2 fix,
      // run_p8JPpVhDonUA retry). Ownership: `cost-tally` is now the
      // EXCLUSIVE tallier of every pp_codex/pp_agy PostToolUse call's spend
      // into the ordinary run:/day:/model: scopes, on every path —
      // `direct_cli` and agent-driven alike. Earlier this hook only tallied
      // the `direct_cli` backstop path, on the theory that an agent-driven
      // flow would separately tally the same spend via `recordAttempt`. That
      // theory was false: `pp_codex`/`pp_agy` `generate` is deprecated, so
      // almost every one of these calls is a judge CRITIQUE, which is
      // recorded via `recordVerdict` — a function that takes no tokens or
      // cost and never tallies anything. Gating the tally on `direct_cli`
      // therefore left ALL agent-driven critique spend permanently outside
      // `budgets`, which is exactly what HIGH-2 caught.
      //
      // Double-tally is made structurally impossible, not merely avoided,
      // two ways:
      //  (1) `writeExecutionEvent`'s `call_key` is unique-indexed with
      //      `ON CONFLICT DO NOTHING` (R2). `.inserted` tells us whether
      //      THIS invocation is the one that won the race for that call —
      //      the budget tally below only runs when it did, so a hook that
      //      fires twice for the same underlying call (retry, duplicate
      //      dispatch) tallies once, not twice.
      //  (2) `recordAttempt` (runs.ts) now excludes producers "codex" and
      //      "agy" from its own R15 cost-derivation tally, precisely
      //      because THIS hook already owns that spend for those two
      //      producers — see the comment at the `tallyBudgets` call site in
      //      runs.ts for the other half of this split. `recordAttempt`
      //      still tallies "claude" (and any future non-vendor-CLI
      //      producer) spend, which this hook never observes (no
      //      `pp_codex`/`pp_agy` tool call underlies it), so the two
      //      writers' domains are disjoint by producer, not by a "shouldn't
      //      also fire" assumption.
      // The sibling `record-attempt` backstop handler below intentionally
      // still performs a non-tallying raw INSERT into `attempts` for
      // `direct_cli` calls (audit trail only) — it has no `tallyBudgets`
      // call and this comment is not asserting it needs one.
      try {
        const producer = /pp_codex/.test(tool) ? "codex" : "agy";
        const projectPath = input.cwd;
        const runId = activeRunForProject(projectPath);
        const tokensIn = resp?.tokens_in ?? 0;
        const tokensOut = resp?.tokens_out ?? 0;
        let costUsd = resp?.cost_usd ?? 0;
        if (!costUsd && resp?.model && (tokensIn || tokensOut)) {
          costUsd = computeCost(resp.model, tokensIn, tokensOut);
        }
        if (tokensIn || tokensOut || costUsd) {
          const callKey = deriveCallKey({
            hook_event_name: "PostToolUse:cost-tally",
            session_id: input.session_id,
            tool_name: tool,
            prompt_id: input.prompt_id,
            agent_id: input.agent_id,
            detail: JSON.stringify({ tool, model: resp?.model, tokensIn, tokensOut, costUsd }),
          });
          const written = writeExecutionEvent({
            call_key: callKey,
            event_kind: "tool_success_spend",
            status: "observed",
            tool_name: tool,
            producer,
            run_id: runId,
            session_id: input.session_id ?? null,
            agent_id: input.agent_id ?? null,
            tokens_in: tokensIn || null,
            tokens_out: tokensOut || null,
            cost_usd: costUsd || null,
            wall_ms: resp?.wall_ms ?? null,
          });
          // Only the invocation that WON the call_key insert race tallies —
          // see point (1) above.
          tallySuccessSpend(written.inserted, runId, resp?.model ?? null, tokensIn, tokensOut, costUsd);
        }
      } catch (err) {
        // NEW-3 (judge verdict_i4RtSb1C7X): cost-tally is now the SOLE writer
        // of pp_codex/pp_agy spend into `budgets`, so a swallowed throw here
        // loses that spend with nothing else to catch it -- the same class of
        // invisibility GitHub #58 reports. A PostToolUse hook MUST NOT block
        // the tool call that already succeeded, so this cannot throw onward;
        // instead it is made LOUD and self-describing, naming itself as the
        // sole writer so the message says what was lost rather than only that
        // something failed.
        const msg = err instanceof Error ? err.message : String(err);
        console.error(
          `[pp] cost-tally FAILED TO PERSIST vendor spend and is the only writer for it — ` +
          `this call's tokens/cost are now absent from budgets and budget_status will under-report. ` +
          `tool=${tool} session=${input.session_id ?? "?"} ` +
          `tokens=${resp?.tokens_in ?? 0}/${resp?.tokens_out ?? 0} cost=${resp?.cost_usd ?? "?"} — ${msg}`,
        );
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
      if (!/pp_(codex|agy)/.test(tool)) return reply(true);
      const resp = input.tool_response as
        | { direct_cli?: boolean; tokens_in?: number; tokens_out?: number; cost_usd?: number; model?: string; wall_ms?: number }
        | undefined;
      if (!resp?.direct_cli) return reply(true);
      try {
        const producer = /pp_codex/.test(tool) ? "codex" : "agy";
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

  // R6: fires when an MCP tool call to a vendor critique lane exits
  // non-zero / times out / returns an unparseable response. This is the
  // ledger row that closes GitHub #58's second half AND makes the
  // `.harness/critique_failures/` bridge archives (already written today
  // by cli-runner.ts independent of any hook — see spec.md §1.3)
  // discoverable from budget_status/replay instead of being invisible
  // text files on disk.
  PostToolUseFailure: {
    "record-execution-failure": (input) => {
      const tool = input.tool_name ?? "";
      if (!/pp_(codex|agy)/.test(tool)) return reply(true);
      try {
        const producer = /pp_codex/.test(tool) ? "codex" : "agy";
        const resp = input.tool_response as
          | { tokens_in?: number; tokens_out?: number; cost_usd?: number; wall_ms?: number; failure_archive_path?: string; error?: string; model?: string }
          | undefined;
        const runId = activeRunForProject(input.cwd);
        let stageId: string | null = null;
        if (runId) {
          const stage = db()
            .prepare(`SELECT id FROM stages WHERE run_id = ? AND status = 'open' ORDER BY started_at DESC LIMIT 1`)
            .get(runId) as { id: string } | undefined;
          stageId = stage?.id ?? null;
        }
        // R6b: derive cost from tokens when the response omits cost_usd,
        // same reasoning as R15 — an unpriced/absent cost should not read
        // as "this call was free".
        let costUsd = resp?.cost_usd;
        if (costUsd === undefined && resp?.model && ((resp?.tokens_in ?? 0) || (resp?.tokens_out ?? 0))) {
          costUsd = computeCost(resp.model, resp.tokens_in ?? 0, resp.tokens_out ?? 0);
        }
        // R6a: cross-reference the on-disk archive path so the ledger row
        // and the archive point at each other.
        const detailParts: string[] = [];
        if (resp?.error) detailParts.push(`error: ${resp.error}`);
        if (resp?.failure_archive_path) detailParts.push(`failure_archive_path: ${resp.failure_archive_path}`);
        const detail = detailParts.length ? detailParts.join(" | ") : null;

        const callKey = deriveCallKey({
          hook_event_name: "PostToolUseFailure",
          session_id: input.session_id,
          tool_name: tool,
          prompt_id: input.prompt_id,
          agent_id: input.agent_id,
          detail: JSON.stringify({ tool, error: resp?.error, path: resp?.failure_archive_path }),
        });
        writeExecutionEvent({
          call_key: callKey,
          event_kind: "tool_failure",
          status: "failed",
          tool_name: tool,
          producer,
          run_id: runId,
          stage_id: stageId,
          session_id: input.session_id ?? null,
          agent_id: input.agent_id ?? null,
          reason: resp?.error ? String(resp.error).slice(0, 200) : null,
          detail,
          tokens_in: resp?.tokens_in ?? null,
          tokens_out: resp?.tokens_out ?? null,
          cost_usd: costUsd ?? null,
          wall_ms: resp?.wall_ms ?? null,
        });
        // R4b: failed spend is visible AND distinguishable from attempt
        // spend, hence the `failed:` scope prefix rather than run:/day:/model:.
        tallyFailedSpend(runId, resp?.model ?? null, resp?.tokens_in ?? 0, resp?.tokens_out ?? 0, costUsd ?? 0);
      } catch (err) {
        console.error(`[pp] record-execution-failure failed: ${err instanceof Error ? err.message : String(err)}`);
      }
      // R6/NFR9: a failed hook MUST NOT be able to block a turn.
      reply(true);
    },
  },

  // R8: detector only. See R8a — MUST NOT block, revert, abort, surface,
  // or write to CONSTITUTION.md. Hard Rule 1 forbids editing that file; the
  // job here ends at noticing the SHA moved and saying so on stdout.
  FileChanged: {
    "constitution-drift-detect": (input) => {
      try {
        const path = input.file_path;
        if (!path || !existsSync(path)) return reply(true);
        const runId = activeRunForProject(input.cwd);
        if (!runId) return reply(true);
        const run = db()
          .prepare(`SELECT constitution_sha FROM runs WHERE id = ?`)
          .get(runId) as { constitution_sha: string | null } | undefined;
        const recordedSha = run?.constitution_sha ?? null;
        const content = readFileSync(path, "utf8");
        const currentSha = createHash("sha256").update(content).digest("hex");
        if (!recordedSha || recordedSha === currentSha) return reply(true);

        const callKey = deriveCallKey({
          hook_event_name: "FileChanged:constitution-drift-detect",
          session_id: input.session_id,
          tool_name: null,
          detail: `${recordedSha}:${currentSha}`,
        });
        writeExecutionEvent({
          call_key: callKey,
          event_kind: "constitution_drift",
          status: "observed",
          run_id: runId,
          session_id: input.session_id ?? null,
          detail: `recorded_sha=${recordedSha} current_sha=${currentSha}`,
        });
        console.log(`[pp] CONSTITUTION.md drift detected: recorded_sha=${recordedSha.slice(0, 12)}… current_sha=${currentSha.slice(0, 12)}…. HITL required — this detector never edits the file. Use /pp:constitution amend.`);
      } catch (err) {
        console.error(`[pp] constitution-drift-detect failed: ${err instanceof Error ? err.message : String(err)}`);
      }
      reply(true);
    },
  },

  // R9: PreCompact/PostCompact are wired as a save/reinject pair. Neither
  // may reference `additionalContext` (R9a — not documented on the hooks
  // page); the reinject side emits plain text on stdout at exit 0 via
  // reply(true, message), which is the documented channel.
  PreCompact: {
    "run-context-save": (input) => {
      // Nothing to persist beyond what's already in the DB — the active
      // run/stage is looked up fresh at reinject time. This handler exists
      // as the paired hook name PreCompact/PostCompact conventionally
      // wants, and is a pure advisory no-op today.
      reply(true);
    },
  },
  PostCompact: {
    "run-context-reinject": (input) => {
      try {
        const runId = activeRunForProject(input.cwd);
        // R9b: no active run -> emit nothing.
        if (!runId) return reply(true);
        const stage = db()
          .prepare(`SELECT id FROM stages WHERE run_id = ? AND status = 'open' ORDER BY started_at DESC LIMIT 1`)
          .get(runId) as { id: string } | undefined;
        // R9c: does not begin with "{" so Claude Code's documented parsing
        // rule treats it as plain text, not an attempted JSON parse.
        const message = `[pp] active run: ${runId}${stage ? ` (stage: ${stage.id})` : ""}`;
        return reply(true, message);
      } catch {
        return reply(true);
      }
    },
  },

  // R7: an API-killed run today sits `running` for up to six hours until
  // the janitor's time-based sweep marks it `crashed` with no cause
  // recorded (janitor.ts:38). This surfaces it within seconds, with a
  // reason, as `surfaced` — the operator-actionable status that already
  // appears in the SessionStart banner and that /pp:retry operates on.
  // MUST NOT touch RUN_STATUS, MUST NOT touch the janitor's crashed sweep.
  StopFailure: {
    "surface-api-killed-run": (input) => {
      try {
        const classified = classifyStopFailureReason(input.reason);
        if (!input.cwd) return reply(true);
        const run = db()
          .prepare(
            `SELECT id, status FROM runs WHERE project_path = ? AND status IN ('pending','running') ORDER BY started_at DESC LIMIT 1`,
          )
          .get(input.cwd) as { id: string; status: string } | undefined;

        // HIGH-3 fix (run_p8JPpVhDonUA retry): R7b still forbids surfacing
        // the run on an unclassified reason (no status/surfaced_reason
        // mutation below), but "not evidence of an API kill" is not the
        // same as "not worth recording". An unclassified reason is now
        // written as an observation carrying the RAW text, so an operator
        // can see a run died of something this classifier does not
        // recognize yet, and so the classifier's blind spots are
        // discoverable from data (R27) rather than a bug report. No DB
        // write happens when there is no reason at all, and none happens
        // when there is no run to correlate against, matching AC-H19's
        // "execution_events count unchanged" expectation for that case.
        if (!classified) {
          if (input.reason && run) {
            const callKey = deriveCallKey({
              hook_event_name: "StopFailure",
              session_id: input.session_id,
              tool_name: null,
              detail: `unclassified:${run.id}:${input.reason}`,
            });
            writeExecutionEvent({
              call_key: callKey,
              event_kind: "api_stop_failure",
              status: "observed",
              run_id: run.id,
              session_id: input.session_id ?? null,
              reason: null,
              detail: `unclassified StopFailure reason: ${input.reason}`,
            });
          }
          return reply(true);
        }
        if (!run) return reply(true);

        const callKey = deriveCallKey({
          hook_event_name: "StopFailure",
          session_id: input.session_id,
          tool_name: null,
          detail: `${run.id}:${classified}`,
        });
        txImmediate(() => {
          db()
            .prepare(`UPDATE runs SET status = 'surfaced', surfaced_reason = ? WHERE id = ? AND status IN ('pending','running')`)
            .run(classified, run.id);
        });
        writeExecutionEvent({
          call_key: callKey,
          event_kind: "api_stop_failure",
          status: "observed",
          run_id: run.id,
          session_id: input.session_id ?? null,
          reason: classified,
        });
        console.log(`[pp] run ${run.id} surfaced (reason=${classified}) — an API error killed the turn. /pp:retry ${run.id} to resume.`);
      } catch (err) {
        console.error(`[pp] surface-api-killed-run failed: ${err instanceof Error ? err.message : String(err)}`);
      }
      reply(true);
    },
  },

  // R12/R13: the observation ledger half of SubagentStart/SubagentStop
  // correlation. See R14 for why "one attempt row with the engineer's
  // metadata intact" is [f] rather than built here — a hook cannot own
  // that invariant.
  SubagentStart: {
    "subagent-dispatch-record": (input) => {
      try {
        const runId = activeRunForProject(input.cwd);
        let stageId: string | null = null;
        if (runId) {
          const stage = db()
            .prepare(`SELECT id FROM stages WHERE run_id = ? AND status = 'open' ORDER BY started_at DESC LIMIT 1`)
            .get(runId) as { id: string } | undefined;
          stageId = stage?.id ?? null;
        }
        const callKey = deriveCallKey({
          hook_event_name: "SubagentStart",
          session_id: input.session_id,
          tool_name: null,
          agent_id: input.agent_id,
          detail: input.agent_type ?? null,
        });
        writeExecutionEvent({
          call_key: callKey,
          event_kind: "subagent_dispatch",
          status: "observed",
          run_id: runId,
          stage_id: stageId,
          session_id: input.session_id ?? null,
          agent_id: input.agent_id ?? null,
          producer: null,
          reason: input.agent_type ?? null,
        });
      } catch (err) {
        console.error(`[pp] subagent-dispatch-record failed: ${err instanceof Error ? err.message : String(err)}`);
      }
      reply(true);
    },
  },
  SubagentStop: {
    "subagent-stop-observe": (input) => {
      try {
        const match = findSubagentDispatchMatch(input.session_id, input.agent_id);
        const callKey = deriveCallKey({
          hook_event_name: "SubagentStop",
          session_id: input.session_id,
          tool_name: null,
          agent_id: input.agent_id,
          detail: match ? match.event_id : "unmatched",
        });
        if (match) {
          // R13a: exactly one dispatch match -> reconciled, carrying the
          // dispatch row's correlation. Both rows are execution_events
          // rows; neither touches attempts.
          writeExecutionEvent({
            call_key: callKey,
            event_kind: "subagent_stop",
            status: "reconciled",
            run_id: match.run_id,
            stage_id: match.stage_id,
            attempt_slot_id: match.attempt_slot_id,
            session_id: input.session_id ?? null,
            agent_id: input.agent_id ?? null,
          });
          markDispatchReconciled(match.event_id);
        } else {
          // R13b: agent_id absent, or zero/multiple matches -> unreconciled
          // with NULL correlation. Never inferred from recency, agent_type,
          // or the sole open stage.
          writeExecutionEvent({
            call_key: callKey,
            event_kind: "subagent_stop",
            status: "unreconciled",
            run_id: null,
            stage_id: null,
            attempt_slot_id: null,
            session_id: input.session_id ?? null,
            agent_id: input.agent_id ?? null,
          });
        }
      } catch (err) {
        console.error(`[pp] subagent-stop-observe failed: ${err instanceof Error ? err.message : String(err)}`);
      }
      reply(true);
    },
  },

  // R11: judged on merit — the raised SessionEnd budget (documented as 1.5s
  // shared, raised to match a longer declared per-hook timeout up to 60s)
  // makes a Node cold start + SQLite open viable at timeout>=20.
  SessionEnd: {
    "session-orphan-sweep": (input) => {
      try {
        if (input.session_id) {
          // NFR3: at most 2 prepare() calls in this handler body.
          db()
            .prepare(
              `UPDATE execution_events SET status = 'unreconciled'
                WHERE event_kind = 'subagent_dispatch' AND status = 'observed' AND session_id = ?`,
            )
            .run(input.session_id);
        }
        if (input.cwd) {
          const row = db()
            .prepare(`SELECT id FROM runs WHERE project_path = ? AND status IN ('pending','running') ORDER BY started_at DESC LIMIT 1`)
            .get(input.cwd) as { id: string } | undefined;
          if (row?.id) console.log(`[pp] session ending with run ${row.id} still open (pending/running).`);
        }
      } catch (err) {
        console.error(`[pp] session-orphan-sweep failed: ${err instanceof Error ? err.message : String(err)}`);
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
        // RA-4: exclude operator-acked runs — they have already been handled
        // via preserved-and-merge and the operator called ack_run to dismiss.
        const rows = db()
          .prepare(`SELECT id FROM runs WHERE project_path = ? AND status = 'surfaced' AND acked_at IS NULL ORDER BY started_at DESC LIMIT 1`)
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
    // Phase B / T1.2 — semantic recall on the user's prompt text. Surfaces
    // memories most relevant to what the user is asking about so the
    // triage classifier (which reads stdout) sees prior context.
    "eights-recall-request": async (input) => {
      if (!input.cwd || !input.prompt || input.prompt.length < 12) return reply(true);
      try {
        const summary = await recallByQuery(input.cwd, input.prompt, 5);
        if (!summary || summary.total_hits === 0) return reply(true);
        console.log(
          `[pp] eights recall (request-relevant): ${summary.total_hits} matching memor` +
          `${summary.total_hits === 1 ? "y" : "ies"} ` +
          `(${summary.prior_runs} run, ${summary.incidents} incident, ${summary.evaluations} verdict). ` +
          `Top hits:`
        );
        for (const entry of summary.top.slice(0, 3)) {
          console.log(`  - [${entry.type}] ${entry.summary}`);
        }
      } catch { /* ignore */ }
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

/**
 * Side-effect-free inventory of every implemented hook handler, derived
 * directly from `HANDLERS` (never a hand-maintained duplicate — a duplicate
 * list is precisely the drift class this export exists to let a test catch;
 * R2.6). Importing this module and calling this function executes no hook
 * body and touches no database — it only reads the keys of the `HANDLERS`
 * object that `runHookDispatcher` itself indexes at dispatch time (R2.7).
 *
 * Consumed by `daemon/test/hook-inventory.unit.mjs` to assert parity against
 * `.claude/settings.template.json` and `hooks.json`.
 */
export function listHookHandlers(): Array<{ event: string; name: string }> {
  const pairs: Array<{ event: string; name: string }> = [];
  for (const [event, handlersForEvent] of Object.entries(HANDLERS)) {
    for (const name of Object.keys(handlersForEvent)) {
      pairs.push({ event, name });
    }
  }
  return pairs;
}

export async function runHookDispatcher(args: string[]): Promise<void> {
  const event = args[0];
  const name = args[1];
  CURRENT_EVENT = event ?? "";
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
  try { input = normalizeHookInput(stdin ? JSON.parse(stdin) : {}); } catch { /* ignore */ }
  try {
    await handler(input);
    process.exit(0);
  } catch (err) {
    console.error(`[pp] hook ${event}/${name} crashed: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(0);
  }
}
