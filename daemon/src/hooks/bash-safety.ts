/**
 * Pure shell-command safety evaluator. Used by the
 * `block-destructive-shell` PreToolUse hook to prevent the
 * incident-pattern where a sub-agent runs `rm -rf .next` from a wrong
 * working directory and obliterates the parent codebase.
 *
 * Strategy:
 *   1. Tokenize the command string into sub-commands (split on
 *      `&&` `||` `;` `|` and newlines; recurse into `bash -c`/`pwsh`
 *      wrappers; bail to "block" on heredocs, eval, base64-pipe-to-sh,
 *      and other shapes that can't be statically analysed).
 *   2. Track cwd across `cd <path>` segments so a `cd .. && rm -rf .next`
 *      is judged with the post-`cd` cwd.
 *   3. For each sub-command, check against a pattern catalog:
 *      recursive force-delete (Bash + PowerShell), find-based delete,
 *      git destructive ops, git force-push to protected refs, and
 *      system-level damage (dd / mkfs / shutdown / reboot / fork bomb).
 *   4. For each delete-shaped command, resolve the target path against
 *      the running cwd and check it: BLOCK if it's a filesystem root /
 *      $HOME / at-or-above the project root / outside cwd via `..`;
 *      ALLOW only when strictly inside the project root, the OS temp
 *      dir, or .harness/<run_id>/.
 *
 * Pure module — no DB, no fs writes. Reads only `existsSync` for the
 * project-root walk. Exported function returns a verdict object the
 * hook handler can stringify into a block reason.
 */

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, normalize, resolve, sep, basename, dirname } from "node:path";

export type SafetyVerdict = {
  decision: "allow" | "block";
  pattern?: string;
  reason?: string;
};

/** Files / directories whose presence anchors a "project root". */
const PROJECT_ROOT_MARKERS = [
  ".git",
  "package.json",
  "Cargo.toml",
  "pyproject.toml",
  "go.mod",
  "project.godot",
  "ProjectSettings",        // Unity
];

/** File-suffix markers (any file with this suffix at a level marks root). */
const PROJECT_ROOT_SUFFIX_MARKERS = [
  ".uproject",              // Unreal
  ".yyp",                   // GameMaker
  ".csproj",
  ".sln",
];

/** Conventional cleanup target names. Only honored when resolved INSIDE a project root. */
const CONVENTIONAL_CLEANUP_NAMES = new Set([
  ".next", ".nuxt", ".svelte-kit", ".vinxi", ".vite", ".turbo", ".cache",
  ".parcel-cache", "dist", "build", "out", "coverage", "node_modules",
  "target", "__pycache__", ".pytest_cache", ".mypy_cache", ".ruff_cache",
  ".tox", ".venv", "venv", ".gradle", "Pods", "DerivedData", "Logs",
  "tmp", ".tmp", "Temp",
]);

/** Refs whose force-push always blocks. */
const PROTECTED_REFS = new Set([
  "main", "master", "develop", "trunk", "production", "release",
]);

const PROTECTED_REF_PREFIXES = ["release/", "production/", "stable/"];

/** Never delete recursively — even inside a project root. VCS metadata. */
const NEVER_DELETE = new Set([".git", ".svn", ".hg", ".harness"]);

/** Public entry point. */
export function evaluateShellSafety(command: string, cwd: string): SafetyVerdict {
  if (!command || !command.trim()) return { decision: "allow" };
  const initialCwd = normalizePath(cwd);

  // Walk sub-commands left-to-right, tracking cwd as `cd` advances it.
  const subs = tokenizeSubCommands(command);
  if (subs === "unparseable") {
    return {
      decision: "block",
      pattern: "unparseable",
      reason: `command shape too complex to verify safely (heredoc, eval, base64-pipe, or nested shell). Set PP_ALLOW_DESTRUCTIVE=1 to override after auditing.`,
    };
  }

  let runningCwd = initialCwd;
  for (const sub of subs) {
    // Update cwd if this sub is a `cd <path>`.
    const cdTarget = matchCd(sub);
    if (cdTarget !== null) {
      if (cdTarget === "unparseable") {
        return {
          decision: "block",
          pattern: "unparseable",
          reason: `cd target is dynamic ($VAR / $(...) / cd -); refusing to evaluate downstream commands. Set PP_ALLOW_DESTRUCTIVE=1 to override.`,
        };
      }
      runningCwd = normalizePath(resolve(runningCwd, cdTarget));
      continue;
    }

    const verdict = evaluateSub(sub, runningCwd);
    if (verdict.decision === "block") return verdict;
  }

  return { decision: "allow" };
}

// ─── Sub-command tokenization ─────────────────────────────────────────────

function tokenizeSubCommands(command: string): string[] | "unparseable" {
  // Reject obvious dynamic-eval shapes up front.
  if (/<<\s*[A-Za-z_]\w*\b/.test(command)) return "unparseable";        // heredoc
  if (/\beval\b/.test(command)) return "unparseable";                    // eval
  if (/\bsource\b\s+/.test(command)) return "unparseable";               // source
  if (/\.\s+\S+\.sh\b/.test(command)) return "unparseable";              // `. script.sh`
  if (/\$\(/.test(command)) return "unparseable";                        // $(...) command substitution
  if (/`[^`]*`/.test(command)) return "unparseable";                     // backtick command substitution
  if (/\b(curl|wget|iwr|invoke-webrequest)\b[^|]*\|\s*(sh|bash|pwsh|powershell|python|node)/i.test(command)) {
    return "unparseable";
  }
  if (/\bbase64\b\s+(-d|--decode)/.test(command) && /\|\s*(sh|bash)/.test(command)) {
    return "unparseable";
  }
  // Fork bomb. Match the canonical shape (with or without quotes / spacing).
  if (/:\s*\(\s*\)\s*\{[^}]*:\s*\|\s*:\s*&[^}]*\}\s*;\s*:/.test(command)) {
    return "unparseable";
  }

  // Strip a single layer of subshell parens at the outside, e.g. `( cmd )`.
  let body = command.trim();
  while (body.startsWith("(") && body.endsWith(")")) {
    body = body.slice(1, -1).trim();
  }

  // bash -c "..." / pwsh -Command "..." / sh -c "..."
  const wrapper = body.match(/^(?:bash|sh|zsh|pwsh|powershell)(?:\.exe)?\s+-(?:c|Command)\s+(.+)$/i);
  if (wrapper) {
    let inner = wrapper[1]!.trim();
    if ((inner.startsWith('"') && inner.endsWith('"')) || (inner.startsWith("'") && inner.endsWith("'"))) {
      inner = inner.slice(1, -1);
    }
    return tokenizeSubCommands(inner);
  }

  // Split on operators, but be careful not to split inside quotes.
  const subs: string[] = [];
  let cur = "";
  let inSingle = false, inDouble = false;
  for (let i = 0; i < body.length; i++) {
    const ch = body[i]!;
    const next = body[i + 1] ?? "";
    if (!inDouble && ch === "'") { inSingle = !inSingle; cur += ch; continue; }
    if (!inSingle && ch === '"') { inDouble = !inDouble; cur += ch; continue; }
    if (!inSingle && !inDouble) {
      if ((ch === "&" && next === "&") || (ch === "|" && next === "|")) {
        if (cur.trim()) subs.push(cur.trim());
        cur = "";
        i++;
        continue;
      }
      if (ch === ";" || ch === "|" || ch === "\n") {
        if (cur.trim()) subs.push(cur.trim());
        cur = "";
        continue;
      }
    }
    cur += ch;
  }
  if (cur.trim()) subs.push(cur.trim());
  return subs;
}

function matchCd(sub: string): string | null | "unparseable" {
  const m = sub.match(/^cd\s+(.+)$/);
  if (!m) return null;
  let target = m[1]!.trim();
  if ((target.startsWith('"') && target.endsWith('"')) || (target.startsWith("'") && target.endsWith("'"))) {
    target = target.slice(1, -1);
  }
  if (target === "-" || target.includes("$") || /\$\(|`/.test(target)) return "unparseable";
  return target;
}

// ─── Per-sub-command evaluation ───────────────────────────────────────────

function evaluateSub(sub: string, cwd: string): SafetyVerdict {
  const trimmed = sub.trim();

  // Strip leading env assignments like `FOO=bar baz` so we evaluate the actual command.
  const stripped = trimmed.replace(/^(?:[A-Za-z_][A-Za-z0-9_]*=\S+\s+)+/, "");

  // System-level destructive commands.
  const sys = matchSystemDamage(stripped);
  if (sys) return sys;

  // Git destructive.
  const git = matchGitDestructive(stripped, cwd);
  if (git) return git;

  // find-based deletion.
  const findV = matchFindDelete(stripped, cwd);
  if (findV) return findV;

  // rm -rf and PowerShell equivalents.
  const rmV = matchRecursiveForceDelete(stripped, cwd);
  if (rmV) return rmV;

  return { decision: "allow" };
}

// ─── Pattern: rm -rf and equivalents ──────────────────────────────────────

function matchRecursiveForceDelete(sub: string, cwd: string): SafetyVerdict | null {
  const patterns: Array<{ test: RegExp; pattern: string; extractArgs: (s: string) => string[] }> = [
    {
      // bash rm with both -r/-R/--recursive and -f/--force
      test: /^(?:\/bin\/|\/usr\/bin\/)?rm\s+(?=(?:-[a-zA-Z]*r[a-zA-Z]*\s|-(?:-recursive)\s))(?=(?:-[a-zA-Z]*f[a-zA-Z]*\s|-(?:-force)\s))/,
      pattern: "rm -rf",
      extractArgs: argsAfterFlags,
    },
    {
      // PowerShell Remove-Item -Recurse -Force (any abbrev / any order). Don't
      // pre-consume the trailing whitespace so the lookaheads can find the
      // space before each flag.
      test: /^remove-item\b(?=.*\s-r(?:e(?:c(?:u(?:r(?:s(?:e)?)?)?)?)?)?\b)(?=.*\s-f(?:o(?:r(?:c(?:e)?)?)?)?\b)/i,
      pattern: "Remove-Item -Recurse -Force",
      extractArgs: argsAfterFlagsPS,
    },
    {
      // Windows rd /s /q   or   rmdir /s /q (any flag order; don't pre-consume).
      test: /^(?:rd|rmdir)\b(?=.*\s\/s\b)(?=.*\s\/q\b)/i,
      pattern: "rd /s /q",
      extractArgs: argsAfterFlagsWin,
    },
    {
      // Windows del /s /q (recursive file delete).
      test: /^del\b(?=.*\s\/s\b)(?=.*\s\/q\b)/i,
      pattern: "del /s /q",
      extractArgs: argsAfterFlagsWin,
    },
  ];

  for (const p of patterns) {
    if (!p.test.test(sub)) continue;
    const targets = p.extractArgs(sub);
    if (targets.length === 0) {
      // No-target deletion is a syntax error in real shell; treat as allow.
      return { decision: "allow" };
    }
    for (const target of targets) {
      const res = evaluateDeleteTarget(target, cwd, p.pattern);
      if (res.decision === "block") return res;
    }
    return { decision: "allow" };
  }
  return null;
}

function argsAfterFlags(sub: string): string[] {
  // rm <flags...> <targets...>; flags start with '-'.
  const tokens = splitArgs(sub).slice(1); // drop "rm"
  const out: string[] = [];
  for (const t of tokens) {
    if (t.startsWith("-")) continue; // flag
    if (t === "--") continue;        // end-of-flags marker
    out.push(unquote(t));
  }
  return out;
}

function argsAfterFlagsPS(sub: string): string[] {
  // Remove-Item -Recurse -Force [-Path] <targets>
  const tokens = splitArgs(sub).slice(1); // drop "Remove-Item"
  const out: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;
    if (/^-(?:Recurse|Rec|R|Force|Fo|F|Confirm|WhatIf|Verbose|Path|LiteralPath)$/i.test(t)) {
      // Skip the flag; if it's -Path / -LiteralPath the next token is a value, but it IS a target so don't skip.
      if (/^-(?:Path|LiteralPath)$/i.test(t)) continue; // next token is target, fall through
      continue;
    }
    out.push(unquote(t));
  }
  return out;
}

function argsAfterFlagsWin(sub: string): string[] {
  // rd / rmdir / del with /switches and target.
  const tokens = splitArgs(sub).slice(1);
  const out: string[] = [];
  for (const t of tokens) {
    if (t.startsWith("/")) continue; // /s /q /f etc.
    if (t.startsWith("-")) continue;
    out.push(unquote(t));
  }
  return out;
}

function splitArgs(s: string): string[] {
  // Tokenizer that respects single + double quotes.
  const out: string[] = [];
  let cur = "";
  let inSingle = false, inDouble = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;
    if (!inDouble && ch === "'") { inSingle = !inSingle; cur += ch; continue; }
    if (!inSingle && ch === '"') { inDouble = !inDouble; cur += ch; continue; }
    if (!inSingle && !inDouble && /\s/.test(ch)) {
      if (cur) { out.push(cur); cur = ""; }
      continue;
    }
    cur += ch;
  }
  if (cur) out.push(cur);
  return out;
}

function unquote(s: string): string {
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1);
  }
  return s;
}

// ─── Pattern: find . -delete ──────────────────────────────────────────────

function matchFindDelete(sub: string, cwd: string): SafetyVerdict | null {
  // `\b` between space and `-` is NOT a word boundary (both are non-word
  // chars), so anchor on whitespace explicitly.
  const m = sub.match(/^find\s+(\S+)(?:\s+.*?)?\s(?:-delete\b|-exec\s+rm\b)/);
  if (!m) return null;
  const target = unquote(m[1]!);
  return evaluateDeleteTarget(target, cwd, "find -delete");
}

// ─── Pattern: git destructive + force-push ────────────────────────────────

function matchGitDestructive(sub: string, cwd: string): SafetyVerdict | null {
  // git push --force / -f / --force-with-lease to protected refs.
  const push = sub.match(/^git\s+push\b(.*)$/);
  if (push) {
    const rest = push[1]!;
    const isForce = /\s(-f\b|--force(\b|=)|--force-with-lease(\b|=))/.test(rest);
    if (!isForce) return null;
    // Extract destination ref. Last token usually wins.
    const tokens = splitArgs(rest).filter(t => t && !t.startsWith("-"));
    const ref = tokens[tokens.length - 1] ? unquote(tokens[tokens.length - 1]!) : "";
    if (!ref) {
      return {
        decision: "block",
        pattern: "git push --force",
        reason: `git force-push without explicit ref; refusing. Set PP_ALLOW_DESTRUCTIVE=1 to override.`,
      };
    }
    if (PROTECTED_REFS.has(ref) || PROTECTED_REF_PREFIXES.some(p => ref.startsWith(p))) {
      return {
        decision: "block",
        pattern: "git push --force",
        reason: `force-push to protected ref "${ref}". Set PP_ALLOW_DESTRUCTIVE=1 to override after coordinating with the team.`,
      };
    }
    return null;
  }

  // git clean -fd / -fdx / -fdX (force + directories + ignored). This is a
  // "scrub untracked files in cwd" op — destructive but a normal dev action
  // when run from inside a project root. Block when cwd is NOT anchored in
  // any project root; allow when it is.
  const clean = sub.match(/^git\s+clean\b(.*)$/);
  if (clean) {
    const rest = clean[1]!;
    const isAggressive = /\s-[a-zA-Z]*f[a-zA-Z]*d/.test(rest) || /--force/.test(rest);
    if (!isAggressive) return null;
    const root = findProjectRoot(cwd);
    if (!root) {
      return {
        decision: "block",
        pattern: "git clean -fd",
        reason: `cwd "${cwd}" has no detectable project root. Refusing aggressive git clean. Set PP_ALLOW_DESTRUCTIVE=1 to override.`,
      };
    }
    return { decision: "allow" };
  }

  // git reset --hard — only block when its target argument is suspicious.
  const reset = sub.match(/^git\s+reset\s+--hard\b(.*)$/);
  if (reset) {
    // Heuristic: allow inside a project root (bog-standard dev op); block when
    // we can't find a project root (means cwd is suspicious).
    const root = findProjectRoot(cwd);
    if (!root) {
      return {
        decision: "block",
        pattern: "git reset --hard",
        reason: `cwd has no detectable project root; refusing destructive git op. Set PP_ALLOW_DESTRUCTIVE=1 to override.`,
      };
    }
    return null;
  }

  // git checkout -- <path> / git restore <path> — block when path escapes cwd.
  const checkout = sub.match(/^git\s+(?:checkout\s+--|restore)\s+(\S+)/);
  if (checkout) {
    const target = unquote(checkout[1]!);
    if (target.includes("..") || isAbsolute(target)) {
      return evaluateDeleteTarget(target, cwd, "git checkout/restore");
    }
    return null;
  }

  return null;
}

// ─── Pattern: system-level damage ─────────────────────────────────────────

function matchSystemDamage(sub: string): SafetyVerdict | null {
  // dd if=... of=/dev/...  or  dd of=<absolute>
  if (/^dd\b/.test(sub)) {
    const ofMatch = sub.match(/\bof=([^\s]+)/);
    if (ofMatch) {
      const dest = ofMatch[1]!;
      if (dest.startsWith("/dev/") || dest.startsWith("\\\\.\\") || isAbsolute(dest)) {
        return {
          decision: "block",
          pattern: "dd",
          reason: `dd of=${dest} writes to a device or absolute path. Set PP_ALLOW_DESTRUCTIVE=1 to override.`,
        };
      }
    }
  }
  if (/^mkfs(\.\w+)?\b/.test(sub)) {
    return {
      decision: "block",
      pattern: "mkfs",
      reason: `mkfs creates a filesystem and erases the device. Set PP_ALLOW_DESTRUCTIVE=1 to override.`,
    };
  }
  if (/^(shutdown|reboot|halt|poweroff)\b/i.test(sub) && !/^shutdown\s+\/\?/.test(sub)) {
    return {
      decision: "block",
      pattern: "system halt",
      reason: `system halt / reboot is not a safe action for an automated agent. Set PP_ALLOW_DESTRUCTIVE=1 to override.`,
    };
  }
  // Fork bomb.
  if (/:\(\)\s*\{\s*:\s*\|\s*:&\s*\}\s*;\s*:/.test(sub)) {
    return {
      decision: "block",
      pattern: "fork bomb",
      reason: `fork bomb pattern detected. Refusing.`,
    };
  }
  return null;
}

// ─── Path-resolution rules ────────────────────────────────────────────────

function evaluateDeleteTarget(rawTarget: string, cwd: string, pattern: string): SafetyVerdict {
  const target = rawTarget.trim();
  if (!target) return { decision: "allow" };

  // Refuse to evaluate dynamic targets — block defensively.
  if (target.includes("$") || target.includes("`") || /^~\w/.test(target)) {
    return {
      decision: "block",
      pattern,
      reason: `target "${rawTarget}" expands dynamically ($VAR, ~user, $(...), backtick). Refusing. Set PP_ALLOW_DESTRUCTIVE=1 to override.`,
    };
  }

  // Filesystem roots / drive letters.
  if (target === "/" || target === "\\") {
    return { decision: "block", pattern, reason: `target "${rawTarget}" is filesystem root.` };
  }
  if (/^[A-Za-z]:[\\\/]?$/.test(target)) {
    return { decision: "block", pattern, reason: `target "${rawTarget}" is a drive root.` };
  }

  // Bare home references.
  if (target === "~" || target === "$HOME" || target === "%USERPROFILE%") {
    return { decision: "block", pattern, reason: `target "${rawTarget}" is the user home directory.` };
  }

  // Bare wildcard from a high directory is dangerous.
  if (target === "*" || target === "*.*") {
    const root = findProjectRoot(cwd);
    if (!root || normalizePath(cwd) !== root) {
      return {
        decision: "block",
        pattern,
        reason: `bare glob "${rawTarget}" from cwd "${cwd}" without project-root anchor.`,
      };
    }
  }

  // Resolve absolute path.
  const resolved = isAbsolute(target) ? normalizePath(target) : normalizePath(resolve(cwd, target));

  // Filesystem root after resolution.
  if (resolved === sep || /^[A-Za-z]:[\\\/]?$/.test(resolved)) {
    return { decision: "block", pattern, reason: `target resolves to filesystem root: ${resolved}` };
  }

  // Home directory hit.
  const home = normalizePath(homedir());
  if (resolved === home) {
    return { decision: "block", pattern, reason: `target resolves to user home: ${resolved}` };
  }

  // Never-delete basenames (.git, .svn, .hg, .harness) — these are VCS or
  // harness state and must never be recursively wiped, even from inside a
  // project root.
  const baseN = basename(resolved);
  if (NEVER_DELETE.has(baseN)) {
    return {
      decision: "block",
      pattern,
      reason: `target "${resolved}" is a protected directory (${baseN}). Refusing recursive delete.`,
    };
  }

  // Project-root walk anchors the decision.
  const projectRoot = findProjectRoot(cwd);

  if (projectRoot) {
    // Resolved path equals or is ABOVE project root.
    if (resolved === projectRoot || isPathInside(projectRoot, resolved)) {
      return {
        decision: "block",
        pattern,
        reason: `target "${resolved}" resolves at or above project root "${projectRoot}".`,
      };
    }
    // Resolved path strictly inside project root → allow.
    if (isPathInside(resolved, projectRoot)) {
      return { decision: "allow" };
    }
    // Resolved path is outside project root entirely. Cross-project deletes
    // are refused regardless of whether they happen to land in tmpdir; the
    // harness can't reason about a target it has no run-context for.
    return {
      decision: "block",
      pattern,
      reason: `target "${resolved}" is outside the project root "${projectRoot}". Refusing cross-project delete. Set PP_ALLOW_DESTRUCTIVE=1 to override.`,
    };
  }

  // No project root anchored. Refuse — the harness can't prove the delete
  // is safe without a project context. Real temp-only scratch deletions
  // can be authorised with PP_ALLOW_DESTRUCTIVE=1.
  return {
    decision: "block",
    pattern,
    reason: `cwd "${cwd}" has no detectable project root (no .git / package.json / Cargo.toml / etc. within 8 levels). Refusing destructive op against "${resolved}". Set PP_ALLOW_DESTRUCTIVE=1 to override.`,
  };
}

// ─── Path helpers ─────────────────────────────────────────────────────────

function normalizePath(p: string): string {
  // Normalize separators to OS native + remove trailing slash (except root).
  const n = normalize(p);
  if (n.length > 1 && (n.endsWith(sep) || n.endsWith("/") || n.endsWith("\\"))) {
    return n.slice(0, -1);
  }
  return n;
}

function isPathInside(child: string, parent: string): boolean {
  const c = normalizePath(child);
  const p = normalizePath(parent);
  if (c === p) return true;
  return c.startsWith(p + sep) || c.startsWith(p + "/") || c.startsWith(p + "\\");
}

function findProjectRoot(cwd: string): string | null {
  let dir = normalizePath(cwd);
  for (let depth = 0; depth < 8; depth++) {
    if (hasProjectMarker(dir)) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null; // hit FS root
    dir = parent;
  }
  return null;
}

function hasProjectMarker(dir: string): boolean {
  for (const m of PROJECT_ROOT_MARKERS) {
    if (existsSync(`${dir}${sep}${m}`)) return true;
  }
  // Suffix-based: scan one level (cheap; only checks current dir's filenames).
  try {
    const { readdirSync } = require("node:fs") as typeof import("node:fs");
    const entries = readdirSync(dir);
    for (const e of entries) {
      for (const sfx of PROJECT_ROOT_SUFFIX_MARKERS) {
        if (e.endsWith(sfx)) return true;
      }
    }
  } catch { /* ignore */ }
  return false;
}

// Re-export the cleanup-name set so the test harness can assert membership
// without duplicating the list.
export { CONVENTIONAL_CLEANUP_NAMES, PROTECTED_REFS };
