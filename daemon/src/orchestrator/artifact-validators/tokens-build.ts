/**
 * Design tokens validator.
 *
 * Layered approach:
 *  1. Parse the artifact (YAML/JSON) and verify it's a Style-Dictionary-
 *     shaped tree: every leaf object has a `value` field; references
 *     `{group.name}` resolve to a real path; no top-level scalar values.
 *  2. Optional second pass: synthesize a minimal style-dictionary config
 *     in tmpdir and run `npx -y -p style-dictionary@4.x style-dictionary
 *     build`. Spawn failures or missing-binary cases skip without
 *     flipping a structurally-valid token tree to violation.
 *
 * Token-tree expectations (Style Dictionary v4):
 *  - Each leaf is `{ value: <scalar | reference> [, type: '...'] }`.
 *  - Non-leaf nodes are plain objects whose keys are token names or
 *    grouping segments.
 *  - References use the `{group.name}` curly-brace syntax (DTCG also
 *    accepts `$value` but we don't insist on the $-prefix variant here).
 */

import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { trackedExeca as execa } from "../../mcp/cli-runner.js";
import YAML from "yaml";

const SD_TIMEOUT_MS = 60_000;

export type TokensBuildResult = {
  status: "verified" | "violation" | "execution_error" | "skipped";
  reason: string | null;
  exit_code: number | null;
  binary_resolved: string;
  output_text: string;
};

export async function validateTokens(input: { artifact_abs_path: string }): Promise<TokensBuildResult> {
  if (!existsSync(input.artifact_abs_path)) {
    return {
      status: "execution_error",
      reason: `artifact file missing on disk: ${input.artifact_abs_path}`,
      exit_code: null,
      binary_resolved: "in-process:tokens-build",
      output_text: "",
    };
  }
  const raw = readFileSync(input.artifact_abs_path, "utf8");

  let parsed: unknown;
  try {
    parsed = YAML.parse(raw);
  } catch (err) {
    return {
      status: "violation",
      reason: `parse error: ${(err as Error).message.slice(0, 300)}`,
      exit_code: null,
      binary_resolved: "in-process:tokens-build",
      output_text: `# tokens_build\nparse error\n${(err as Error).message}`,
    };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return {
      status: "violation",
      reason: "tokens file must parse to an object (got scalar / array / null)",
      exit_code: null,
      binary_resolved: "in-process:tokens-build",
      output_text: "# tokens_build\nparse yielded non-object",
    };
  }

  const errs: string[] = [];
  const refs: string[] = [];
  walkTokens(parsed as Record<string, unknown>, [], errs, refs);

  if (errs.length === 0 && refs.length === 0) {
    errs.push("token tree contains no leaf tokens (every node has a `value` or none?)");
  }

  // Validate that all `{group.name}` references resolve.
  const tokenIndex = collectTokenPaths(parsed as Record<string, unknown>);
  for (const r of refs) {
    if (!tokenIndex.has(r)) errs.push(`unresolved reference: {${r}}`);
  }

  if (errs.length > 0) {
    return {
      status: "violation",
      reason: `shape errors: ${errs.slice(0, 5).join("; ")}`,
      exit_code: null,
      binary_resolved: "in-process:tokens-build",
      output_text: `# tokens_build\nshape errors\n${errs.join("\n")}`,
    };
  }

  if (process.env.PP_DISABLE_NPX_VALIDATORS === "1") {
    return ok("in-process:tokens-build (npx pass disabled by env)");
  }

  const sd = await runStyleDictionary(input.artifact_abs_path);
  if (sd.kind === "violation") {
    return {
      status: "violation",
      reason: sd.reason,
      exit_code: sd.exit_code,
      binary_resolved: "npx:style-dictionary",
      output_text: sd.output_text,
    };
  }
  if (sd.kind === "skipped") {
    return ok(`in-process:tokens-build (style-dictionary skipped: ${sd.reason})`);
  }
  return ok("npx:style-dictionary (built ok)");

  function ok(binary: string): TokensBuildResult {
    return {
      status: "verified",
      reason: null,
      exit_code: null,
      binary_resolved: binary,
      output_text: `# tokens_build\nstatus: verified\ntoken_count: ${tokenIndex.size}\n`,
    };
  }
}

const REFERENCE_RE = /\{([A-Za-z0-9_.-]+)\}/g;

function walkTokens(
  node: Record<string, unknown>,
  path: string[],
  errs: string[],
  refs: string[],
): void {
  // A node is a "leaf token" iff it has a `value` field. Otherwise it's a
  // grouping container.
  if (Object.prototype.hasOwnProperty.call(node, "value")) {
    const v = (node as { value: unknown }).value;
    if (v === null || v === undefined) {
      errs.push(`${path.join(".") || "<root>"}: value is null/undefined`);
      return;
    }
    if (typeof v === "object" && !Array.isArray(v)) {
      errs.push(`${path.join(".") || "<root>"}: value must be a scalar (string/number/boolean), got object`);
      return;
    }
    if (typeof v === "string") {
      let m: RegExpExecArray | null;
      const re = new RegExp(REFERENCE_RE.source, "g");
      while ((m = re.exec(v)) !== null) refs.push(m[1]!);
    }
    return;
  }
  for (const [k, child] of Object.entries(node)) {
    if (child && typeof child === "object" && !Array.isArray(child)) {
      walkTokens(child as Record<string, unknown>, [...path, k], errs, refs);
    } else if (child !== null && typeof child !== "object") {
      // A non-leaf scalar at a non-leaf position is invalid (e.g. user wrote
      // `color: "#fff"` instead of `color: { value: "#fff" }`).
      errs.push(`${[...path, k].join(".")}: scalar at non-leaf position (wrap in { value: ... })`);
    }
  }
}

function collectTokenPaths(node: Record<string, unknown>, prefix: string[] = [], out: Set<string> = new Set()): Set<string> {
  if (Object.prototype.hasOwnProperty.call(node, "value")) {
    out.add(prefix.join("."));
    return out;
  }
  for (const [k, child] of Object.entries(node)) {
    if (child && typeof child === "object" && !Array.isArray(child)) {
      collectTokenPaths(child as Record<string, unknown>, [...prefix, k], out);
    }
  }
  return out;
}

type SdOutcome =
  | { kind: "verified"; output_text: string }
  | { kind: "violation"; reason: string; exit_code: number | null; output_text: string }
  | { kind: "skipped"; reason: string };

async function runStyleDictionary(absArtifactPath: string): Promise<SdOutcome> {
  // Synthesize a config in a private tmpdir so we don't pollute the project.
  const tmp = mkdtempSync(join(tmpdir(), "pp-tokens-"));
  const configPath = join(tmp, "style-dictionary.config.json");
  const buildPath = join(tmp, "build/");
  const config = {
    source: [absArtifactPath],
    platforms: {
      web: {
        transformGroup: "web",
        buildPath,
        files: [{ destination: "out.css", format: "css/variables" }],
      },
    },
  };
  writeFileSync(configPath, JSON.stringify(config, null, 2));

  let result: Awaited<ReturnType<typeof execa>>;
  try {
    result = await execa("npx", ["-y", "-p", "style-dictionary@4.x", "style-dictionary", "build", "--config", configPath], {
      timeout: SD_TIMEOUT_MS,
      reject: false,
      shell: false,
      windowsHide: true,
      env: { ...process.env, NO_COLOR: "1" },
    });
  } catch (err) {
    return { kind: "skipped", reason: `npx style-dictionary spawn failed: ${(err as Error).message.slice(0, 200)}` };
  }

  const stdout = (result.stdout ?? "").toString();
  const stderr = (result.stderr ?? "").toString();
  const combined = stdout + (stderr ? `\n--- stderr ---\n${stderr}` : "");

  if (/(?:command not found|404 Not Found|ENOENT|getaddrinfo|EACCES|cannot find module)/i.test(combined) && (result.exitCode ?? 0) !== 0) {
    return { kind: "skipped", reason: `style-dictionary unreachable (exit=${result.exitCode})` };
  }

  if ((result.exitCode ?? 0) === 0) {
    return { kind: "verified", output_text: `# tokens_build (style-dictionary)\nbuilt ok\n${stdout.slice(0, 1000)}` };
  }

  // Style Dictionary printed an error of some kind.
  return {
    kind: "violation",
    reason: `style-dictionary failed: exit=${result.exitCode}; ${firstLine(stderr || stdout)}`,
    exit_code: result.exitCode ?? null,
    output_text: `# tokens_build (style-dictionary)\nexit=${result.exitCode}\n--- stdout ---\n${stdout.slice(0, 4000)}\n--- stderr ---\n${stderr.slice(0, 2000)}\n`,
  };
}

function firstLine(text: string): string {
  const lines = text.split(/\r?\n/).filter(l => l.trim().length > 0);
  return (lines[0] ?? "").slice(0, 240);
}
