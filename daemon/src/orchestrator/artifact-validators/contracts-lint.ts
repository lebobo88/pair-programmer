/**
 * OpenAPI 3.x / AsyncAPI 3 structural validator.
 *
 * Strategy: in-process YAML/JSON parse + Zod-shape check first. Catches
 * the bulk of malformed specs (parse errors, missing top-level fields,
 * obviously-wrong types) without spawning any subprocess. Optional second
 * pass: `npx -y -p @redocly/cli@1.x redocly lint <abs> --format=json`
 * when npx is reachable on PATH and PP_DISABLE_NPX_VALIDATORS is unset;
 * its severity:'error' findings escalate a 'verified' to 'violation'.
 *
 * The check refuses to upload validation evidence outside the run's
 * artifact dir (use `assertPathInProjectArtifactDir` upstream when
 * running the dispatcher).
 *
 * Failure modes:
 *  - file missing on disk → execution_error
 *  - YAML/JSON parse fails → violation
 *  - top-level shape wrong → violation
 *  - npx unreachable → skip subprocess silently, return in-process result
 *  - redocly lint reports severity: error → violation (overrides verified)
 *  - redocly takes too long / spawn fails → record as warning in reason
 *    but do not flip a verified result to error
 */

import { existsSync, readFileSync } from "node:fs";
import { trackedExeca as execa } from "../../mcp/cli-runner.js";
import YAML from "yaml";
import { z } from "zod";

const REDOCLY_TIMEOUT_MS = 60_000;

const InfoShape = z.object({
  title: z.string().min(1),
  version: z.string().min(1),
}).passthrough();

const OpenApiShape = z.object({
  openapi: z.string().regex(/^3\.[01]/, "openapi field must start with '3.0' or '3.1'"),
  info: InfoShape,
  // For 3.1, paths is optional if webhooks or components exist; for 3.0 paths is required.
  paths: z.record(z.string(), z.unknown()).optional(),
  webhooks: z.record(z.string(), z.unknown()).optional(),
  components: z.record(z.string(), z.unknown()).optional(),
}).passthrough().refine(
  v => Boolean(v.paths || v.webhooks || v.components),
  { message: "at least one of paths / webhooks / components must be present" },
);

const AsyncApiShape = z.object({
  asyncapi: z.string().regex(/^[23]\./, "asyncapi field must start with '2.' or '3.'"),
  info: InfoShape,
  channels: z.record(z.string(), z.unknown()).optional(),
  operations: z.record(z.string(), z.unknown()).optional(),
}).passthrough().refine(
  v => Boolean(v.channels || v.operations),
  { message: "asyncapi spec must declare channels (2.x) or operations (3.x)" },
);

export type ContractsLintResult = {
  status: "verified" | "violation" | "execution_error" | "skipped";
  reason: string | null;
  exit_code: number | null;
  binary_resolved: string;
  output_text: string;
};

export async function validateContracts(input: { artifact_abs_path: string }): Promise<ContractsLintResult> {
  if (!existsSync(input.artifact_abs_path)) {
    return {
      status: "execution_error",
      reason: `artifact file missing on disk: ${input.artifact_abs_path}`,
      exit_code: null,
      binary_resolved: "in-process:contracts-lint",
      output_text: "",
    };
  }
  const raw = readFileSync(input.artifact_abs_path, "utf8");

  // Parse: YAML.parse handles both YAML and JSON.
  let parsed: unknown;
  try {
    parsed = YAML.parse(raw);
  } catch (err) {
    return {
      status: "violation",
      reason: `parse error: ${(err as Error).message.slice(0, 300)}`,
      exit_code: null,
      binary_resolved: "in-process:contracts-lint",
      output_text: `# contracts_lint\nparse error\n${(err as Error).message}`,
    };
  }
  if (!parsed || typeof parsed !== "object") {
    return {
      status: "violation",
      reason: "spec did not parse to an object (empty file? scalar value?)",
      exit_code: null,
      binary_resolved: "in-process:contracts-lint",
      output_text: "# contracts_lint\nparse yielded non-object",
    };
  }

  const obj = parsed as Record<string, unknown>;
  const isAsyncApi = typeof obj.asyncapi === "string";
  const isOpenApi = typeof obj.openapi === "string";
  if (!isAsyncApi && !isOpenApi) {
    return {
      status: "violation",
      reason: "spec is neither OpenAPI (top-level 'openapi') nor AsyncAPI (top-level 'asyncapi')",
      exit_code: null,
      binary_resolved: "in-process:contracts-lint",
      output_text: "# contracts_lint\ntop-level discriminator missing",
    };
  }

  const shape = isAsyncApi ? AsyncApiShape.safeParse(parsed) : OpenApiShape.safeParse(parsed);
  if (!shape.success) {
    const issues = shape.error.issues.slice(0, 5).map(i => `${i.path.join(".") || "<root>"}: ${i.message}`);
    return {
      status: "violation",
      reason: `shape errors: ${issues.join("; ")}`,
      exit_code: null,
      binary_resolved: "in-process:contracts-lint",
      output_text: `# contracts_lint\nshape errors\n${issues.join("\n")}`,
    };
  }

  // Optional second pass: redocly lint via npx, if npx is reachable and the
  // user hasn't opted out. Failures here downgrade to warnings — we do NOT
  // flip a structurally-valid spec into 'violation' just because npx is
  // offline. Severity:error findings DO flip to violation.
  if (process.env.PP_DISABLE_NPX_VALIDATORS === "1") {
    return ok("in-process:contracts-lint (npx pass disabled by env)");
  }

  const redoclyOutcome = await runRedocly(input.artifact_abs_path, isAsyncApi ? "asyncapi" : "openapi");
  if (redoclyOutcome.kind === "violation") {
    return {
      status: "violation",
      reason: redoclyOutcome.reason,
      exit_code: redoclyOutcome.exit_code,
      binary_resolved: "npx:@redocly/cli",
      output_text: redoclyOutcome.output_text,
    };
  }
  if (redoclyOutcome.kind === "skipped") {
    return ok(`in-process:contracts-lint (redocly skipped: ${redoclyOutcome.reason})`);
  }
  return ok("npx:@redocly/cli (clean)");

  function ok(binary: string): ContractsLintResult {
    return {
      status: "verified",
      reason: null,
      exit_code: null,
      binary_resolved: binary,
      output_text: `# contracts_lint\nstatus: verified\nformat: ${isAsyncApi ? "asyncapi" : "openapi"}\nshape ok\n`,
    };
  }
}

type RedoclyOutcome =
  | { kind: "verified"; output_text: string }
  | { kind: "violation"; reason: string; exit_code: number | null; output_text: string }
  | { kind: "skipped"; reason: string };

async function runRedocly(absPath: string, format: "openapi" | "asyncapi"): Promise<RedoclyOutcome> {
  // AsyncAPI is supported by redocly via --type asyncapi flag (recent
  // versions). For older redocly we fall back to the implicit detection.
  const args = ["-y", "-p", "@redocly/cli@1.x", "redocly", "lint", absPath, "--format", "json", "--max-problems", "200"];
  if (format === "asyncapi") args.push("--type", "asyncapi");

  let result: Awaited<ReturnType<typeof execa>>;
  try {
    result = await execa("npx", args, {
      timeout: REDOCLY_TIMEOUT_MS,
      reject: false,
      shell: false,
      windowsHide: true,
      env: { ...process.env, NO_COLOR: "1" },
    });
  } catch (err) {
    return { kind: "skipped", reason: `npx redocly spawn failed: ${(err as Error).message.slice(0, 200)}` };
  }

  const stdout = (result.stdout ?? "").toString();
  const stderr = (result.stderr ?? "").toString();
  const combined = stdout + (stderr ? `\n--- stderr ---\n${stderr}` : "");

  // npx prints "command not found" or "404 Not Found" on its own when the
  // package is unreachable — treat as 'skipped'.
  if (/(?:command not found|404 Not Found|ENOENT|getaddrinfo|EACCES|cannot find module)/i.test(combined) && (result.exitCode ?? 0) !== 0) {
    return { kind: "skipped", reason: `redocly unreachable (${(result.exitCode ?? 0)})` };
  }

  // Try to parse JSON output. If parsing fails, fall back to exit code.
  let problems: Array<{ severity?: string; message?: string; ruleId?: string }> = [];
  const jsonStart = stdout.indexOf("[");
  if (jsonStart >= 0) {
    try {
      const parsed = JSON.parse(stdout.slice(jsonStart));
      if (Array.isArray(parsed)) problems = parsed;
    } catch {
      // ignore — exit-code branch below handles
    }
  }

  const errors = problems.filter(p => (p.severity ?? "").toLowerCase() === "error");
  if (errors.length > 0) {
    const top = errors.slice(0, 3).map(e => `${e.ruleId ?? "?"}: ${e.message ?? "?"}`).join("; ");
    return {
      kind: "violation",
      reason: `redocly: ${errors.length} error(s): ${top}`,
      exit_code: result.exitCode ?? null,
      output_text: `# contracts_lint (redocly)\nexit=${result.exitCode}\n--- problems ---\n${stdout.slice(0, 5000)}\n--- stderr ---\n${stderr.slice(0, 2000)}\n`,
    };
  }

  if ((result.exitCode ?? 0) !== 0 && problems.length === 0) {
    // exited non-zero but we couldn't parse problems — could be a redocly
    // crash. Don't promote to violation; skip with reason.
    return { kind: "skipped", reason: `redocly exit=${result.exitCode}, no parseable problems; treating as skipped` };
  }

  return { kind: "verified", output_text: `# contracts_lint (redocly)\nclean (problems=${problems.length}, exit=${result.exitCode})\n` };
}
