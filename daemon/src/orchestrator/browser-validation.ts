/**
 * Live browser validation for the web-ui / mobile profiles.
 *
 * Complements visual-regression.ts (pixel-diff screenshots only) by recording
 * structured findings from a browser-validator agent run: each finding pairs a
 * route + step with its console errors, network errors, and an optional
 * screenshot path. The agent itself drives the browser (either via the
 * `claude-in-chrome` MCP server or via a `npx playwright test` shell-out) —
 * this module persists evidence and renders the report.
 *
 * Severity rule:
 *   - "errors"   if any finding has status="fail" OR any console_errors OR any 5xx
 *   - "warnings" if any finding has status="warn" OR any 4xx
 *   - "clean"    otherwise
 *
 * Mirrors visual-regression.ts for graceful-degradation patterns: returns
 * structured status objects instead of throwing, so the calling agent can
 * downgrade to {ok:false} without failing the run.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { db } from "../db/database.js";
import { projectArtifactDir } from "../util/paths.js";

export type Finding = {
  route: string;
  step: string;
  status: "pass" | "warn" | "fail";
  console_errors: string[];
  network_errors: Array<{ url: string; status: number }>;
  screenshot_path?: string;
  /**
   * PP-VG-3: per-route/step allowlist of expected non-2xx status codes.
   * Only the specific route/step this Finding describes inherits this list —
   * a 401 expected on "/api/login" does NOT suppress a 500 on "/api/data".
   * There is no run-level fallback; each finding's list is scoped to that
   * finding only.
   */
  expected_statuses?: number[];
};

export type StartInput = {
  run_id: string;
  base_url?: string;       // if the agent already booted a server, pass it here
  routes: string[];        // from profile.runtime_smoke_test.routes
};

export type StartOutput = {
  status: "ok";
  run_id: string;
  artifact_root: string;   // .harness/<run_id>/browser-validation
  routes: string[];
  base_url: string | null; // echoes the caller's base_url; agent boots its own server
};

/**
 * Allocates the per-run browser-validation artifact directory and echoes the
 * inputs the agent will use during capture. The agent (not the daemon) boots
 * the dev server — we don't try to inherit the engineer-stage smoke-test
 * machinery here because the agent already has Bash and the same heuristics
 * apply. Daemon stays narrowly responsible for evidence persistence.
 */
export function browserValidationStart(input: StartInput): StartOutput {
  const run = db()
    .prepare(`SELECT project_path FROM runs WHERE id = ?`)
    .get(input.run_id) as { project_path: string } | undefined;
  if (!run) throw new Error(`run ${input.run_id} not found`);

  const root = join(projectArtifactDir(run.project_path, input.run_id), "browser-validation");
  mkdirSync(join(root, "screenshots"), { recursive: true });
  mkdirSync(join(root, "console"),     { recursive: true });
  mkdirSync(join(root, "network"),     { recursive: true });

  return {
    status: "ok",
    run_id: input.run_id,
    artifact_root: root,
    routes: input.routes,
    base_url: input.base_url ?? null,
  };
}

/**
 * PP-BV-ISO: "unavailable" is a fourth, DEGRADE-OPEN severity for when the
 * browser engine could not run at all (no engine in this environment, headless
 * launch refused, or a live-Chrome conflict). It is NOT "errors": the finalize
 * gate only blocks on "errors", so an "unavailable" run still commits. The
 * browser-validation-evidence missability check then surfaces it as an evidence
 * gap (severity is neither clean nor warnings), so the run is downgraded to
 * "surfaced" for later operator review instead of stalling mid-stage.
 */
export type BvSeverity = "clean" | "warnings" | "errors" | "unavailable";

export type FinalizeInput = {
  run_id: string;
  stage_id: string;
  engine: "chrome-mcp" | "playwright";
  base_url?: string;
  findings: Finding[];
  gif_path?: string;       // chrome-mcp gif_creator output, if any
  /** "ran" (default) = a browser actually drove the flows. "unavailable" =
   *  no browser could run; degrade-open (commit + surface gap, never block). */
  engine_status?: "ran" | "unavailable";
  /** Human-readable reason captured into the report when engine_status="unavailable". */
  unavailable_reason?: string;
};

export type FinalizeOutput = {
  status: "ok";
  /** Project-relative path of THIS call's report file. */
  report_path: string;
  /** Severity of THIS call's findings (not ratcheted). */
  severity: BvSeverity;
  /**
   * PP-VG-3: append-only ratcheted max severity across ALL calls for this
   * stage. Once "errors" is persisted it never downgrades. Always check
   * effective_severity (not severity) to know the gate state.
   */
  effective_severity: BvSeverity;
  /**
   * PP-VG-3: the report path associated with the highest-severity result.
   * The errors-report is retained even after a later clean run — only
   * replaced when a new call also produces errors.
   */
  effective_report_path: string;
  summary: {
    finding_count: number;
    fail_count: number;
    warn_count: number;
    pass_count: number;
    console_error_total: number;
    network_error_total: number;
  };
};

export function browserValidationFinalize(input: FinalizeInput): FinalizeOutput {
  const run = db()
    .prepare(`SELECT project_path FROM runs WHERE id = ?`)
    .get(input.run_id) as { project_path: string } | undefined;
  if (!run) throw new Error(`run ${input.run_id} not found`);

  // PP-VG-3: verify stage_id belongs to run_id BEFORE persisting anything.
  // This prevents errors from being attached to the wrong run and leaving
  // the intended stage passable.
  const stageOwnerRow = db()
    .prepare(`SELECT id FROM stages WHERE id = ? AND run_id = ?`)
    .get(input.stage_id, input.run_id) as { id: string } | undefined;
  if (!stageOwnerRow) {
    throw new Error(
      `PP-VG-3: stage ${input.stage_id} does not belong to run ${input.run_id} — ` +
      `cannot persist browser validation. Check that stage_id and run_id are from the same run.`,
    );
  }

  const root = join(projectArtifactDir(run.project_path, input.run_id), "browser-validation");
  mkdirSync(root, { recursive: true });

  const fail_count = input.findings.filter(f => f.status === "fail").length;
  const warn_count = input.findings.filter(f => f.status === "warn").length;
  const pass_count = input.findings.filter(f => f.status === "pass").length;
  const console_error_total = input.findings.reduce((acc, f) => acc + f.console_errors.length, 0);
  const network_error_total = input.findings.reduce((acc, f) => acc + f.network_errors.length, 0);

  // PP-VG-3: ONLY per-finding expected_statuses are honoured.
  // There is no run-level fallback — a global list would mask ALL matching
  // status codes across every finding. Both unexpected 4xx AND 5xx produce
  // severity="errors" (fail-closed).
  let hasUnexpectedNetworkError = false;
  for (const f of input.findings) {
    const effectiveExpected = new Set<number>(f.expected_statuses ?? []);
    for (const n of f.network_errors) {
      if (n.status >= 400 && !effectiveExpected.has(n.status)) {
        hasUnexpectedNetworkError = true;
        break;
      }
    }
    if (hasUnexpectedNetworkError) break;
  }

  // PP-BV-ISO: a browser that could not run at all is "unavailable" — a
  // degrade-open outcome that is computed BEFORE the content rules and never
  // escalates to "errors". (An unavailable run carries no findings, so the
  // content rules below would otherwise mislabel it "clean" and falsely claim
  // the UI was validated.)
  const engineStatus: "ran" | "unavailable" = input.engine_status ?? "ran";

  // Severity rule (fail-closed):
  //   "unavailable" — engine_status="unavailable" (no browser ran)
  //   "errors"   — any status="fail", any console_errors, or any unexpected 4xx/5xx
  //   "warnings" — any status="warn" (explicit; NOT triggered by expected network codes)
  //   "clean"    — otherwise
  const severity: BvSeverity =
    engineStatus === "unavailable"                                          ? "unavailable" :
    fail_count > 0 || console_error_total > 0 || hasUnexpectedNetworkError ? "errors" :
    warn_count > 0                                                          ? "warnings" :
                                                                              "clean";

  // PP-VG-3 persistence: APPEND-ONLY severity ratchet in stage notes_json.
  // A later clean finalize MUST NOT overwrite an earlier "errors" row.
  // Any DB/JSON failure is a hard error (fail-closed — do not swallow).
  const stageNotesRow = db()
    .prepare(`SELECT notes_json FROM stages WHERE id = ?`)
    .get(input.stage_id) as { notes_json: string | null } | undefined;
  if (!stageNotesRow) {
    throw new Error(
      `PP-VG-3: stage ${input.stage_id} not found — cannot persist browser validation severity`,
    );
  }

  // Parse existing notes_json. Three outcomes:
  //   (a) null/empty  → start fresh, prevSeverity = undefined
  //   (b) valid JSON plain object → merge into it
  //   (c) valid JSON but wrong type (array, primitive) → FAIL CLOSED:
  //       prevSeverity = "errors" (treat prior state as unknown/worst-case);
  //       discard the non-object and write a fresh object so the gate is
  //       never silently bypassed. A non-object notes_json must NEVER let
  //       an errors severity disappear on the next stringify.
  //   (d) JSON parse failure → same fail-closed treatment as (c).
  let stageNotes: Record<string, unknown>;
  let prevSeverityFromStorage: string | undefined;
  {
    const raw = stageNotesRow.notes_json;
    if (!raw) {
      stageNotes = {};
      prevSeverityFromStorage = undefined;
    } else {
      let parsedRaw: unknown;
      let parsedOk = false;
      try {
        parsedRaw = JSON.parse(raw);
        parsedOk = true;
      } catch { /* fall through to fail-closed branch */ }

      if (parsedOk && typeof parsedRaw === "object" && parsedRaw !== null && !Array.isArray(parsedRaw)) {
        // (b) Valid plain object — safe to merge.
        stageNotes = parsedRaw as Record<string, unknown>;
        prevSeverityFromStorage = stageNotes["browser_validation_severity"] as string | undefined;
      } else {
        // (c)/(d) Parse failed or wrong type — fail closed.
        // Treat prevSeverity as "errors" so the ratchet can never downgrade
        // from an unknown prior state.  Write a fresh object below.
        stageNotes = {};
        prevSeverityFromStorage = "errors";
      }
    }
  }

  // Append-only severity ratchet for the BLOCKING dimension: errors > warnings.
  // "clean" outranks "unavailable" so a later genuine clean run upgrades out of
  // an evidence gap, while "errors"/"warnings" are never downgraded (PP-VG-3).
  // "unavailable" is only the effective severity when neither errors, warnings,
  // nor a real clean run was ever recorded for this stage.
  const prevSeverity = prevSeverityFromStorage;
  let effectiveSeverity: BvSeverity;
  if (prevSeverity === "errors" || severity === "errors") {
    effectiveSeverity = "errors";
  } else if (prevSeverity === "warnings" || severity === "warnings") {
    effectiveSeverity = "warnings";
  } else if (prevSeverity === "clean" || severity === "clean") {
    effectiveSeverity = "clean";
  } else {
    effectiveSeverity = "unavailable";
  }
  stageNotes["browser_validation_severity"] = effectiveSeverity;
  // PP-BV-ISO: stamp an explicit evidence-gap marker + reason so /pp:status and
  // the operator can see WHY validation didn't run, without parsing the report.
  if (effectiveSeverity === "unavailable") {
    stageNotes["browser_validation_evidence_gap"] = true;
    if (input.unavailable_reason) {
      stageNotes["browser_validation_unavailable_reason"] = input.unavailable_reason;
    }
  }

  // Use a timestamp suffix so multiple finalize calls don't clobber each other.
  const ts = Date.now();
  const findingsPath = join(root, `findings-${ts}.json`);
  writeFileSync(
    findingsPath,
    JSON.stringify({ engine: input.engine, base_url: input.base_url ?? null, findings: input.findings }, null, 2),
    "utf8",
  );

  // Markdown report — judge-friendly, embeds GIF + screenshots.
  const reportPath = join(root, `report-${ts}.md`);
  writeFileSync(reportPath, renderReport({ ...input, severity, fail_count, warn_count, pass_count, console_error_total, network_error_total }, root), "utf8");

  const thisReportRelative = relative(run.project_path, reportPath).replaceAll("\\", "/");

  // PP-VG-3: RETAIN the report path associated with the HIGHEST severity rank.
  // Promote effective_report_path whenever the new severity rank >= stored rank
  // (errors=2 > warnings=1 > clean=0). This means:
  //   clean  → warnings : warnings report is retained  (2 >= 1 ? no: 1 >= 0 yes)
  //   warnings → clean  : warnings report kept          (0 >= 1 ? no)
  //   anything → errors : errors report retained        (2 >= any yes)
  //   warnings → warnings: newer warnings report retained (1 >= 1 yes)
  const severityRank = (s: string | undefined): number =>
    s === "errors" ? 3 : s === "warnings" ? 2 : s === "clean" ? 1 : 0; // "unavailable"/undefined = 0

  const prevReportPath = stageNotes["browser_validation_report_path"] as string | undefined;
  let effectiveReportPath: string;
  if (!prevReportPath || severityRank(severity) >= severityRank(prevSeverity)) {
    // First call, or this call's severity is at least as high as what was stored —
    // update to this report so the highest-severity report is always current.
    effectiveReportPath = thisReportRelative;
    stageNotes["browser_validation_report_path"] = effectiveReportPath;
  } else {
    // Previous call was more severe — keep the previously stored report path.
    effectiveReportPath = prevReportPath;
  }

  // Commit notes update — hard error if this fails (gate depends on it).
  db()
    .prepare(`UPDATE stages SET notes_json = ? WHERE id = ?`)
    .run(JSON.stringify(stageNotes), input.stage_id);

  return {
    status: "ok",
    report_path: thisReportRelative,
    severity,
    effective_severity: effectiveSeverity,
    effective_report_path: effectiveReportPath,
    summary: {
      finding_count: input.findings.length,
      fail_count,
      warn_count,
      pass_count,
      console_error_total,
      network_error_total,
    },
  };
}

function renderReport(
  data: FinalizeInput & {
    severity: BvSeverity;
    fail_count: number;
    warn_count: number;
    pass_count: number;
    console_error_total: number;
    network_error_total: number;
  },
  root: string,
): string {
  const lines: string[] = [];
  lines.push(`# Browser validation report`);
  lines.push("");
  lines.push(`severity: ${data.severity}`);
  lines.push(`engine: ${data.engine}`);
  // PP-BV-ISO: when the browser could not run, the report leads with the reason
  // so the operator sees the evidence gap at a glance. severity="unavailable"
  // is NOT a pass and NOT a hard failure — the code committed; this UI flow was
  // not exercised and should be spot-checked.
  if (data.engine_status === "unavailable") {
    lines.push(`engine_status: unavailable`);
    lines.push(`evidence_gap: true`);
    lines.push(`reason: ${data.unavailable_reason ?? "browser engine could not run in this environment"}`);
  }
  if (data.base_url) lines.push(`base_url: ${data.base_url}`);
  lines.push(`findings: ${data.findings.length} (pass=${data.pass_count}, warn=${data.warn_count}, fail=${data.fail_count})`);
  lines.push(`console_errors: ${data.console_error_total}`);
  lines.push(`network_errors: ${data.network_error_total}`);
  lines.push("");
  if (data.gif_path) {
    const rel = relativeFromReport(data.gif_path, root);
    lines.push(`## Evidence GIF`);
    lines.push("");
    lines.push(`![evidence](${rel})`);
    lines.push("");
  }
  lines.push(`## Findings`);
  lines.push("");
  lines.push(`| route | step | status | console errors | network errors | screenshot |`);
  lines.push(`| --- | --- | --- | --- | --- | --- |`);
  for (const f of data.findings) {
    const screenshot = f.screenshot_path
      ? `![](${relativeFromReport(f.screenshot_path, root)})`
      : "—";
    const cons = f.console_errors.length ? `${f.console_errors.length} (\`${truncate(f.console_errors[0]!, 60)}\`)` : "0";
    const net = f.network_errors.length
      ? f.network_errors.map(n => `${n.status} ${truncate(n.url, 40)}`).join("<br>")
      : "0";
    lines.push(`| \`${f.route}\` | ${truncate(f.step, 60)} | ${f.status} | ${cons} | ${net} | ${screenshot} |`);
  }
  lines.push("");
  if (data.console_error_total > 0) {
    lines.push(`## Console error detail`);
    lines.push("");
    for (const f of data.findings) {
      for (const msg of f.console_errors) {
        lines.push(`- \`${f.route}\` / ${f.step}: ${msg}`);
      }
    }
    lines.push("");
  }
  return lines.join("\n");
}

function relativeFromReport(absOrRelPath: string, reportRoot: string): string {
  // Paths from the agent may be absolute (Bash playwright) or already relative
  // to the artifact root (chrome-mcp screenshots). Normalize to a path the
  // markdown report can resolve.
  const r = relative(reportRoot, absOrRelPath).replaceAll("\\", "/");
  return r.startsWith("..") || r === "" ? absOrRelPath.replaceAll("\\", "/") : r;
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + "…";
}
