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

export type FinalizeInput = {
  run_id: string;
  stage_id: string;
  engine: "chrome-mcp" | "playwright";
  base_url?: string;
  findings: Finding[];
  gif_path?: string;       // chrome-mcp gif_creator output, if any
};

export type FinalizeOutput = {
  status: "ok";
  report_path: string;     // project-relative
  severity: "clean" | "warnings" | "errors";
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

  const root = join(projectArtifactDir(run.project_path, input.run_id), "browser-validation");
  mkdirSync(root, { recursive: true });

  const fail_count = input.findings.filter(f => f.status === "fail").length;
  const warn_count = input.findings.filter(f => f.status === "warn").length;
  const pass_count = input.findings.filter(f => f.status === "pass").length;
  const console_error_total = input.findings.reduce((acc, f) => acc + f.console_errors.length, 0);
  const network_error_total = input.findings.reduce((acc, f) => acc + f.network_errors.length, 0);
  const has5xx = input.findings.some(f => f.network_errors.some(n => n.status >= 500));
  const has4xx = input.findings.some(f => f.network_errors.some(n => n.status >= 400 && n.status < 500));

  const severity: "clean" | "warnings" | "errors" =
    fail_count > 0 || console_error_total > 0 || has5xx ? "errors" :
    warn_count > 0 || has4xx                            ? "warnings" :
                                                          "clean";

  // Findings JSON for replay/judge consumption.
  const findingsPath = join(root, "findings.json");
  writeFileSync(
    findingsPath,
    JSON.stringify({ engine: input.engine, base_url: input.base_url ?? null, findings: input.findings }, null, 2),
    "utf8",
  );

  // Markdown report — judge-friendly, embeds GIF + screenshots.
  const reportPath = join(root, "report.md");
  writeFileSync(reportPath, renderReport({ ...input, severity, fail_count, warn_count, pass_count, console_error_total, network_error_total }, root), "utf8");

  return {
    status: "ok",
    report_path: relative(run.project_path, reportPath).replaceAll("\\", "/"),
    severity,
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
    severity: "clean" | "warnings" | "errors";
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
