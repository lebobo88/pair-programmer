/**
 * Mermaid block renderer / structural validator.
 *
 * Extracts every fenced ```mermaid block from the artifact (or treats
 * the whole file as a single block when the path ends in .mmd /
 * .mermaid). Runs each through `npx -y -p @mermaid-js/mermaid-cli@10.x
 * mmdc -i <abs> -o <abs.png>`. Non-zero exit on any block → violation.
 *
 * The `mmdc` CLI requires Chromium / Puppeteer dependencies. When
 * `npx` cannot resolve mmdc OR the launch fails for environmental
 * reasons (no Chromium, headless-shell missing) the result is `skipped`
 * with a precise reason — non-blocking unless the profile lists
 * `mermaid_render` in `required_validators_strict`.
 *
 * Cheap pre-checks happen in-process to catch obvious mistakes without
 * needing Chromium:
 *   - file missing on disk → execution_error
 *   - file has no fenced mermaid blocks AND extension is not .mmd →
 *     verified with reason="no mermaid blocks present" (nothing to
 *     render is not a violation; the architect is allowed to ship an
 *     ADR without a diagram)
 *   - mermaid block is empty / has only whitespace → violation
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, extname, join } from "node:path";
import { tmpdir } from "node:os";
import { trackedExeca as execa } from "../../mcp/cli-runner.js";
import { nanoid } from "nanoid";

const MMDC_TIMEOUT_MS = 60_000;

const FENCE_RE = /(^|\r?\n)```mermaid\s*\r?\n([\s\S]*?)\r?\n```/gi;

export type MermaidRenderResult = {
  status: "verified" | "violation" | "execution_error" | "skipped";
  reason: string | null;
  exit_code: number | null;
  binary_resolved: string;
  output_text: string;
};

export async function validateMermaid(input: { artifact_abs_path: string }): Promise<MermaidRenderResult> {
  if (!existsSync(input.artifact_abs_path)) {
    return {
      status: "execution_error",
      reason: `artifact file missing on disk: ${input.artifact_abs_path}`,
      exit_code: null,
      binary_resolved: "in-process:mermaid-render",
      output_text: "",
    };
  }
  const raw = readFileSync(input.artifact_abs_path, "utf8");
  const ext = extname(input.artifact_abs_path).toLowerCase();
  const blocks = extractMermaidBlocks(raw, ext);

  if (blocks.length === 0) {
    return {
      status: "verified",
      reason: "no mermaid blocks present",
      exit_code: null,
      binary_resolved: "in-process:mermaid-render",
      output_text: "# mermaid_render\nno mermaid blocks present\n",
    };
  }

  const empties = blocks.filter(b => b.trim().length === 0);
  if (empties.length > 0) {
    return {
      status: "violation",
      reason: `${empties.length} mermaid block(s) are empty / whitespace-only`,
      exit_code: null,
      binary_resolved: "in-process:mermaid-render",
      output_text: `# mermaid_render\n${empties.length} empty block(s) detected\n`,
    };
  }

  if (process.env.PP_DISABLE_NPX_VALIDATORS === "1") {
    return {
      status: "verified",
      reason: `${blocks.length} mermaid block(s); mmdc pass disabled by env`,
      exit_code: null,
      binary_resolved: "in-process:mermaid-render (npx pass disabled by env)",
      output_text: `# mermaid_render\nverified ${blocks.length} block(s) without mmdc\n`,
    };
  }

  // Persist each block as its own .mmd file in a temp dir; mmdc renders one
  // diagram per call. We stop on the first failure.
  const workDir = join(tmpdir(), `pp-mermaid-${nanoid(8)}`);
  mkdirSync(workDir, { recursive: true });

  const logs: string[] = [];
  for (let i = 0; i < blocks.length; i++) {
    const inFile = join(workDir, `block-${i + 1}.mmd`);
    const outFile = join(workDir, `block-${i + 1}.png`);
    writeFileSync(inFile, blocks[i]!, "utf8");

    let result: Awaited<ReturnType<typeof execa>>;
    try {
      result = await execa(
        "npx",
        ["-y", "-p", "@mermaid-js/mermaid-cli@10.x", "mmdc", "-i", inFile, "-o", outFile, "-q"],
        { timeout: MMDC_TIMEOUT_MS, reject: false, shell: false, windowsHide: true, env: { ...process.env, NO_COLOR: "1" } },
      );
    } catch (err) {
      return {
        status: "skipped",
        reason: `mmdc spawn failed (block ${i + 1}): ${(err as Error).message.slice(0, 200)}`,
        exit_code: null,
        binary_resolved: "npx:@mermaid-js/mermaid-cli (skip)",
        output_text: `# mermaid_render\nspawn fail block ${i + 1}\n${(err as Error).message}`,
      };
    }
    const stdout = (result.stdout ?? "").toString();
    const stderr = (result.stderr ?? "").toString();
    const combined = stdout + (stderr ? `\n--- stderr ---\n${stderr}` : "");

    // Environmental signals that mmdc isn't usable here.
    if (
      (result.exitCode ?? 0) !== 0 &&
      /(?:command not found|404 Not Found|ENOENT|getaddrinfo|EACCES|cannot find module|Failed to launch|No usable sandbox|browser_revision|Could not find Chromium|libnss3|libatk-bridge|chrome-headless-shell)/i.test(combined)
    ) {
      return {
        status: "skipped",
        reason: `mmdc unreachable on this host (block ${i + 1}); first hint: ${firstLine(combined)}`,
        exit_code: result.exitCode ?? null,
        binary_resolved: "npx:@mermaid-js/mermaid-cli (skip)",
        output_text: `# mermaid_render\nblock ${i + 1} skipped\n${combined.slice(0, 4000)}`,
      };
    }

    if ((result.exitCode ?? 0) !== 0) {
      return {
        status: "violation",
        reason: `mmdc rejected block ${i + 1}: ${firstLine(combined)}`,
        exit_code: result.exitCode ?? null,
        binary_resolved: "npx:@mermaid-js/mermaid-cli",
        output_text: `# mermaid_render\nblock ${i + 1} failed\nexit=${result.exitCode}\n--- combined ---\n${combined.slice(0, 4000)}\n`,
      };
    }
    if (!existsSync(outFile)) {
      return {
        status: "violation",
        reason: `mmdc reported success but produced no output for block ${i + 1}`,
        exit_code: result.exitCode ?? null,
        binary_resolved: "npx:@mermaid-js/mermaid-cli",
        output_text: `# mermaid_render\nmmdc exit 0 but no PNG written for block ${i + 1}\n`,
      };
    }
    logs.push(`block ${i + 1}: ok`);
  }

  return {
    status: "verified",
    reason: null,
    exit_code: null,
    binary_resolved: "npx:@mermaid-js/mermaid-cli",
    output_text: `# mermaid_render\nverified ${blocks.length} block(s)\n${logs.join("\n")}\n`,
  };
}

export function extractMermaidBlocks(raw: string, ext: string): string[] {
  if (ext === ".mmd" || ext === ".mermaid") {
    return [raw.replace(/^﻿/, "")];
  }
  const out: string[] = [];
  let m: RegExpExecArray | null;
  const re = new RegExp(FENCE_RE.source, FENCE_RE.flags);
  while ((m = re.exec(raw)) !== null) {
    out.push(m[2] ?? "");
  }
  return out;
}

function firstLine(text: string): string {
  for (const line of text.split(/\r?\n/)) {
    if (line.trim().length > 0) return line.trim().slice(0, 240);
  }
  return text.slice(0, 240);
}

// Avoid unused-import warning when the daemon is built without ever
// invoking the renderer (e.g. when PP_DISABLE_NPX_VALIDATORS=1).
const _silenceDirname: typeof dirname = dirname;
void _silenceDirname;
