/**
 * Visual regression for the Phase-8 design-system / web-ui flow.
 *
 * captureBefore / captureAfter take screenshots of the requested URLs and
 * write them under `<run_id>/visual-regression/{before,after}/`. `diff`
 * compares each pair, computes a per-route changed-pixel ratio, and emits
 * an HTML report at `<run_id>/visual-regression/report.html`.
 *
 * Playwright is loaded dynamically. If the install is missing (no
 * @playwright/test or no chromium binary), the captures emit a structured
 * `unavailable` response so the calling agent can downgrade gracefully.
 */
import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { PNG } from "pngjs";
import pixelmatch from "pixelmatch";
import { db } from "../db/database.js";
import { projectArtifactDir } from "../util/paths.js";
import { log } from "../util/logger.js";

export type CaptureInput = {
  run_id: string;
  phase: "before" | "after";
  urls: string[];                 // absolute or relative-to-baseUrl
  base_url?: string;              // optional prefix for relative paths
  viewport?: { width: number; height: number };
  full_page?: boolean;
};

export type CaptureOutput =
  | { status: "ok"; phase: "before" | "after"; files: Array<{ url: string; path: string }> }
  | { status: "unavailable"; reason: string };

export async function visualRegressionCapture(input: CaptureInput): Promise<CaptureOutput> {
  let chromium: typeof import("playwright").chromium;
  try {
    ({ chromium } = await import("playwright"));
  } catch (err) {
    return {
      status: "unavailable",
      reason:
        "@playwright/test is not installed in the daemon. Run `npm install` in daemon/, then `npx playwright install chromium`.",
    };
  }

  const run = db()
    .prepare(`SELECT project_path FROM runs WHERE id = ?`)
    .get(input.run_id) as { project_path: string } | undefined;
  if (!run) throw new Error(`run ${input.run_id} not found`);

  const baseDir = join(projectArtifactDir(run.project_path, input.run_id), "visual-regression", input.phase);
  mkdirSync(baseDir, { recursive: true });

  let browser: import("playwright").Browser | null = null;
  try {
    browser = await chromium.launch({ headless: true });
  } catch (err) {
    return {
      status: "unavailable",
      reason: `Failed to launch Chromium: ${err instanceof Error ? err.message : String(err)}. Run \`npx playwright install chromium\`.`,
    };
  }

  const ctx = await browser.newContext({
    viewport: input.viewport ?? { width: 1280, height: 800 },
  });
  const page = await ctx.newPage();
  const files: Array<{ url: string; path: string }> = [];

  try {
    for (const url of input.urls) {
      const target = input.base_url ? new URL(url, input.base_url).toString() : url;
      const safe = url.replace(/[^a-z0-9-_]+/gi, "_").slice(0, 80) || "root";
      const path = join(baseDir, `${safe}.png`);
      try {
        await page.goto(target, { waitUntil: "networkidle", timeout: 15_000 });
        await page.screenshot({ path, fullPage: input.full_page ?? true });
        files.push({ url: target, path });
      } catch (err) {
        log.warn({ err, target }, "screenshot failed");
        // Emit a 1x1 placeholder PNG so the diff stage still has something to compare.
        writeFileSync(path, PLACEHOLDER_PNG);
        files.push({ url: target, path });
      }
    }
  } finally {
    await ctx.close();
    await browser.close();
  }

  return { status: "ok", phase: input.phase, files };
}

export type DiffInput = { run_id: string };

export type DiffEntry = {
  url: string;
  before_path: string;
  after_path: string;
  diff_path: string | null;
  changed_pixels: number;
  total_pixels: number;
  changed_ratio: number;
};

export type DiffOutput =
  | {
      status: "ok";
      entries: DiffEntry[];
      report_path: string;
      worst_changed_ratio: number;
    }
  | { status: "missing"; reason: string };

export function visualRegressionDiff(input: DiffInput): DiffOutput {
  const run = db()
    .prepare(`SELECT project_path FROM runs WHERE id = ?`)
    .get(input.run_id) as { project_path: string } | undefined;
  if (!run) throw new Error(`run ${input.run_id} not found`);

  const root = join(projectArtifactDir(run.project_path, input.run_id), "visual-regression");
  const beforeDir = join(root, "before");
  const afterDir = join(root, "after");
  const diffDir = join(root, "diff");
  if (!existsSync(beforeDir) || !existsSync(afterDir)) {
    return { status: "missing", reason: "before/ or after/ directory missing — run captureBefore + captureAfter first." };
  }
  mkdirSync(diffDir, { recursive: true });

  const beforeFiles = readdirSync(beforeDir).filter(f => f.endsWith(".png"));
  const entries: DiffEntry[] = [];
  let worst = 0;

  for (const name of beforeFiles) {
    const beforePath = join(beforeDir, name);
    const afterPath = join(afterDir, name);
    const diffPath = join(diffDir, name);
    if (!existsSync(afterPath)) continue;

    // Real pixel-precision diff via pngjs + pixelmatch. Threshold 0.1 is
    // pixelmatch's documented "fairly strict" default; alpha=0.5 makes
    // the diff overlay readable in the report.
    let changed = 0;
    let total = 0;
    try {
      const beforePng = PNG.sync.read(readFileSync(beforePath));
      const afterPng = PNG.sync.read(readFileSync(afterPath));
      const width = Math.max(beforePng.width, afterPng.width);
      const height = Math.max(beforePng.height, afterPng.height);
      const beforeNorm = normalizePng(beforePng, width, height);
      const afterNorm = normalizePng(afterPng, width, height);
      const diffPng = new PNG({ width, height });
      changed = pixelmatch(
        beforeNorm.data,
        afterNorm.data,
        diffPng.data,
        width,
        height,
        { threshold: 0.1, alpha: 0.5, includeAA: false },
      );
      total = width * height;
      writeFileSync(diffPath, PNG.sync.write(diffPng));
    } catch (err) {
      // PNG parse/diff failed (rare — placeholder PNG, truncated file, etc.).
      // Fall back to byte compare so the run still returns a coarse signal.
      log.warn({ err, before: beforePath, after: afterPath }, "pixel diff failed; using byte-compare fallback");
      const beforeBuf = readFileSync(beforePath);
      const afterBuf = readFileSync(afterPath);
      total = Math.max(beforeBuf.length, afterBuf.length, 1);
      changed = beforeBuf.length !== afterBuf.length
        ? total
        : Array.from(beforeBuf).reduce((acc, b, i) => acc + (b === afterBuf[i] ? 0 : 1), 0);
    }
    const ratio = total === 0 ? 0 : changed / total;
    worst = Math.max(worst, ratio);
    entries.push({
      url: name.replace(/\.png$/, ""),
      before_path: relative(run.project_path, beforePath).replaceAll("\\", "/"),
      after_path: relative(run.project_path, afterPath).replaceAll("\\", "/"),
      diff_path: existsSync(diffPath) ? relative(run.project_path, diffPath).replaceAll("\\", "/") : null,
      changed_pixels: changed,
      total_pixels: total,
      changed_ratio: ratio,
    });
  }

  const reportHtml = renderReport(entries, input.run_id, worst);
  const reportPath = join(root, "report.html");
  writeFileSync(reportPath, reportHtml, "utf8");

  return {
    status: "ok",
    entries,
    report_path: relative(run.project_path, reportPath).replaceAll("\\", "/"),
    worst_changed_ratio: worst,
  };
}

function renderReport(entries: DiffEntry[], runId: string, worst: number): string {
  const rows = entries
    .sort((a, b) => b.changed_ratio - a.changed_ratio)
    .map(e => {
      const diffCell = e.diff_path
        ? `<img src="${relativeFromReport(e.diff_path)}" alt="diff" />`
        : "<em>(no diff — fallback compare)</em>";
      return (
        `<tr><td><code>${e.url}</code></td><td>${(e.changed_ratio * 100).toFixed(2)}%</td>` +
        `<td><img src="${relativeFromReport(e.before_path)}" alt="before" /></td>` +
        `<td><img src="${relativeFromReport(e.after_path)}" alt="after" /></td>` +
        `<td>${diffCell}</td></tr>`
      );
    })
    .join("\n");
  return `<!doctype html><meta charset="utf-8"><title>Visual regression — ${runId}</title>
<style>
  body{font:14px system-ui;margin:24px}
  table{border-collapse:collapse;width:100%}
  td,th{border:1px solid #ddd;padding:6px;vertical-align:top}
  img{max-width:360px;height:auto;border:1px solid #eee}
</style>
<h1>Visual regression — ${runId}</h1>
<p>Worst changed ratio: <strong>${(worst * 100).toFixed(2)}%</strong>. Greater than 0.5% is usually meaningful.</p>
<table>
  <thead><tr><th>route</th><th>changed</th><th>before</th><th>after</th><th>diff</th></tr></thead>
  <tbody>${rows}</tbody>
</table>
`;
}

/** Project-relative paths in the report need to be relative to the report file itself. */
function relativeFromReport(path: string): string {
  // The report sits at <run>/visual-regression/report.html. The path values
  // we receive are project-relative (e.g. ".harness/<run>/visual-regression/before/foo.png"),
  // so the link should strip the `.harness/<run>/visual-regression/` prefix.
  const m = /\.harness\/[^/]+\/visual-regression\/(.+)$/.exec(path);
  return m ? m[1]! : path;
}

/** Pad/copy a PNG to (width, height). pixelmatch requires identical dims. */
function normalizePng(src: PNG, width: number, height: number): PNG {
  if (src.width === width && src.height === height) return src;
  const out = new PNG({ width, height, fill: true });
  // PNG.bitblt copies a rectangle from src into out at (0,0), tolerating
  // src smaller than (width,height). The remaining area stays transparent
  // (filled by `fill: true`).
  src.bitblt(out, 0, 0, src.width, src.height, 0, 0);
  return out;
}

// 1x1 transparent PNG as a placeholder when a screenshot fails. Keeps the
// diff stage's output deterministic even when a route 404s.
const PLACEHOLDER_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
  "base64",
);
