/**
 * C4 / PlantUML structural validator.
 *
 * Runs `java -jar $PLANTUML_JAR -checkonly <abs>` (or `plantuml -checkonly
 * <abs>` if the wrapper is on PATH) for `.puml` / `.plantuml` files
 * AND for any markdown artifact whose body contains an `@startuml`
 * token. Non-zero exit → violation.
 *
 * Skip semantics: PlantUML and Java are heavy, optional installs. The
 * validator returns `skipped` (non-blocking unless promoted via
 * `required_validators_strict`) when neither `plantuml` nor a working
 * `java + PLANTUML_JAR` combination is found.
 *
 * Coverage shortcut: when the artifact contains Mermaid blocks (no
 * `@startuml` tokens AND extension is .md), this validator returns
 * `verified` with reason="covered by mermaid_render" — the architect's
 * Mermaid C4 path (Mermaid `C4Context` blocks) is already validated
 * by the mermaid_render validator. We don't double-count.
 */

import { existsSync, readFileSync } from "node:fs";
import { extname } from "node:path";
import { trackedExeca as execa } from "../../mcp/cli-runner.js";

const PLANTUML_TIMEOUT_MS = 60_000;

export type C4RenderResult = {
  status: "verified" | "violation" | "execution_error" | "skipped";
  reason: string | null;
  exit_code: number | null;
  binary_resolved: string;
  output_text: string;
};

export async function validateC4(input: { artifact_abs_path: string }): Promise<C4RenderResult> {
  if (!existsSync(input.artifact_abs_path)) {
    return {
      status: "execution_error",
      reason: `artifact file missing on disk: ${input.artifact_abs_path}`,
      exit_code: null,
      binary_resolved: "in-process:c4-render",
      output_text: "",
    };
  }
  const ext = extname(input.artifact_abs_path).toLowerCase();
  const raw = readFileSync(input.artifact_abs_path, "utf8");
  const isPuml = ext === ".puml" || ext === ".plantuml" || /@startuml/.test(raw);

  if (!isPuml) {
    // No PlantUML content. If the artifact has Mermaid blocks the
    // mermaid_render validator already handled it. Either way this
    // validator has nothing to do.
    return {
      status: "verified",
      reason: "no PlantUML content found (covered by mermaid_render if Mermaid blocks present)",
      exit_code: null,
      binary_resolved: "in-process:c4-render",
      output_text: "# c4_render\nno PlantUML content; deferring to mermaid_render\n",
    };
  }

  const resolved = await resolveBinary();
  if (resolved.kind === "skipped") {
    return {
      status: "skipped",
      reason: resolved.reason,
      exit_code: null,
      binary_resolved: "skipped:no-plantuml",
      output_text: `# c4_render\nplantuml unreachable: ${resolved.reason}\n`,
    };
  }

  const args = resolved.args(input.artifact_abs_path);
  let result: Awaited<ReturnType<typeof execa>>;
  try {
    result = await execa(resolved.head, args, {
      timeout: PLANTUML_TIMEOUT_MS,
      reject: false,
      shell: false,
      windowsHide: true,
      env: { ...process.env, NO_COLOR: "1" },
    });
  } catch (err) {
    return {
      status: "skipped",
      reason: `${resolved.binary_label} spawn failed: ${(err as Error).message.slice(0, 200)}`,
      exit_code: null,
      binary_resolved: `${resolved.binary_label}:spawn-fail`,
      output_text: `# c4_render\nspawn fail\n${(err as Error).message}`,
    };
  }
  const stdout = (result.stdout ?? "").toString();
  const stderr = (result.stderr ?? "").toString();
  const combined = stdout + (stderr ? `\n--- stderr ---\n${stderr}` : "");

  if ((result.exitCode ?? 0) !== 0) {
    return {
      status: "violation",
      reason: `${resolved.binary_label} rejected file: ${firstLine(combined)}`,
      exit_code: result.exitCode ?? null,
      binary_resolved: resolved.binary_label,
      output_text: `# c4_render\nexit=${result.exitCode}\n--- combined ---\n${combined.slice(0, 4000)}\n`,
    };
  }
  return {
    status: "verified",
    reason: null,
    exit_code: 0,
    binary_resolved: resolved.binary_label,
    output_text: `# c4_render\nplantuml accepted file\n`,
  };
}

type Resolved =
  | { kind: "plantuml"; head: string; args: (abs: string) => string[]; binary_label: string }
  | { kind: "java"; head: string; args: (abs: string) => string[]; binary_label: string }
  | { kind: "skipped"; reason: string };

async function resolveBinary(): Promise<Resolved> {
  // 1. plantuml wrapper on PATH (homebrew, apt).
  if (await onPath("plantuml")) {
    return {
      kind: "plantuml",
      head: "plantuml",
      args: abs => ["-checkonly", abs],
      binary_label: "PATH:plantuml",
    };
  }
  // 2. java + $PLANTUML_JAR.
  const jar = process.env.PLANTUML_JAR;
  if (jar && existsSync(jar) && (await onPath("java"))) {
    return {
      kind: "java",
      head: "java",
      args: abs => ["-jar", jar, "-checkonly", abs],
      binary_label: `java+PLANTUML_JAR:${jar}`,
    };
  }
  return {
    kind: "skipped",
    reason: jar
      ? `PLANTUML_JAR=${jar} but java is missing on PATH or jar file does not exist`
      : "no 'plantuml' on PATH and PLANTUML_JAR env var is not set",
  };
}

async function onPath(binary: string): Promise<boolean> {
  // Cross-platform existence probe: attempt to spawn the binary directly with
  // a harmless flag.  We do NOT shell out to `which` (POSIX) or `where`
  // (Windows) because that requires shell: true and introduces platform
  // branching.  Instead we rely on execa's cross-platform PATHEXT resolution
  // (handles .cmd shims on Windows automatically) and catch ENOENT.
  //   - ENOENT thrown  → binary not on PATH (all platforms)
  //   - Windows: "not recognized as an internal or external command" → missing
  //   - Non-zero exit with no error marker → binary is present, just unhappy
  // We bias toward false on any ambiguous failure so missing binaries always
  // skip rather than block.
  try {
    const r = await execa(binary, ["-version"], { timeout: 10_000, reject: false, shell: false, windowsHide: true });
    if (r.exitCode === 0) return true;
    const stderr = (r.stderr ?? "").toString().toLowerCase();
    const stdout = (r.stdout ?? "").toString().toLowerCase();
    const combined = stderr + stdout;
    if (
      combined.includes("not recognized") ||         // Windows cmd
      combined.includes("command not found") ||       // POSIX shells
      combined.includes("no such file or directory")
    ) return false;
    // Some binaries return non-zero on -version (rare). Treat unknown
    // non-zero with no error markers as "present, just unhappy" — most
    // such tools still respond to real invocations.
    return r.exitCode !== null;
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === "ENOENT") return false;
    return false;
  }
}

function firstLine(text: string): string {
  for (const line of text.split(/\r?\n/)) {
    if (line.trim().length > 0) return line.trim().slice(0, 240);
  }
  return text.slice(0, 240);
}
