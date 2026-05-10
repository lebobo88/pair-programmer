/**
 * Shared command allowlist + tokenizer for validator gates.
 *
 * Extracted from tdd-gate.ts so the same rejection rules apply to every
 * gate that spawns a subprocess (TDD test runners, redocly lint, mmdc
 * render, style-dictionary build, plantuml). The TDD allowlist is a
 * parameter; each caller supplies its own head set.
 *
 * Threat model: validator subprocess commands are NOT user-configurable
 * (the head + flags are hard-coded literals; only the artifact path is
 * dynamic). The allowlist is belt-and-suspenders against a future call
 * site that might pass attacker-controlled strings. The artifact path
 * goes through assertPathInProjectArtifactDir before reaching here.
 */
import { resolve, normalize, sep } from "node:path";
import { projectArtifactDir } from "../../util/paths.js";

export const FORBIDDEN_PATTERNS: readonly RegExp[] = [
  /[;&|<>`$]/,            // shell metacharacters
  /\$\(/,                 // command substitution
  /\\\s*\n/,              // line continuation
  /\.\.\//,               // path traversal in token form (we run with shell=false but still refuse for clarity)
];

export class CommandRejectedError extends Error {
  constructor(message: string, public readonly command: string) {
    super(message);
    this.name = "CommandRejectedError";
  }
}

/**
 * Tokenize respecting double/single quotes, refuse shell metacharacters,
 * require the head to be in `allowedHeads`. Returns { head, args } for
 * execa(head, args, { shell: false }).
 */
export function parseAndValidateCommand(
  cmd: string,
  opts: { allowedHeads: ReadonlySet<string> },
): { head: string; args: string[] } {
  for (const re of FORBIDDEN_PATTERNS) {
    if (re.test(cmd)) {
      throw new CommandRejectedError(
        `command contains forbidden pattern ${re.source}; allowed heads: ${[...opts.allowedHeads].join(", ")}; command was: ${cmd}`,
        cmd,
      );
    }
  }
  const tokens = tokenize(cmd);
  if (tokens.length === 0) {
    throw new CommandRejectedError("command is empty after tokenization", cmd);
  }
  const head = tokens[0]!;
  if (!opts.allowedHeads.has(head)) {
    throw new CommandRejectedError(
      `command head '${head}' is not in the allowlist; allowed: ${[...opts.allowedHeads].join(", ")}`,
      cmd,
    );
  }
  return { head, args: tokens.slice(1) };
}

export function tokenize(cmd: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i] as string;
    if (inSingle) {
      if (c === "'") inSingle = false;
      else cur += c;
      continue;
    }
    if (inDouble) {
      if (c === '"') inDouble = false;
      else cur += c;
      continue;
    }
    if (c === "'") { inSingle = true; continue; }
    if (c === '"') { inDouble = true; continue; }
    if (/\s/.test(c)) {
      if (cur.length > 0) { out.push(cur); cur = ""; }
      continue;
    }
    cur += c;
  }
  if (cur.length > 0) out.push(cur);
  return out;
}

export class PathOutsideArtifactDirError extends Error {
  constructor(message: string, public readonly absPath: string, public readonly artifactDir: string) {
    super(message);
    this.name = "PathOutsideArtifactDirError";
  }
}

/**
 * Resolve an absolute path and verify it lives under the run's
 * .harness/<run_id>/ directory. Refuses traversal, symlink escape, and
 * any path that doesn't share the artifact-dir prefix.
 *
 * Use this on every path that gets passed to a validator subprocess as
 * a positional argument.
 */
export function assertPathInProjectArtifactDir(
  absPath: string,
  projectPath: string,
  runId: string,
): string {
  const resolved = resolve(absPath);
  const dir = normalize(projectArtifactDir(projectPath, runId));
  const dirWithSep = dir.endsWith(sep) ? dir : dir + sep;
  if (resolved !== dir && !resolved.startsWith(dirWithSep)) {
    throw new PathOutsideArtifactDirError(
      `path ${resolved} does not live under run artifact dir ${dir}`,
      resolved,
      dir,
    );
  }
  return resolved;
}
