/**
 * TDD execution gate.
 *
 * The pair-programmer harness has TDD-shaped team pipelines (refactor-team,
 * bug-fix-team, feature-team-tdd) that interleave a `tests_pre` stage between
 * spec/repro/invariants and `code`. This module is what makes those pipelines
 * actually enforce the red/green property instead of being TDD-by-convention.
 *
 * Lifecycle:
 *  1. The test-strategist agent finishes a tests_pre stage. It archives a
 *     manifest at .harness/<run_id>/tests_pre/manifest.yaml with kind
 *     'tdd_manifest', and writes the actual test files into the project tree
 *     at the paths the manifest declares.
 *  2. After the judge passes the tests_pre artifact, the team driver calls
 *     `tdd_pre_check(stage_id)`. This module reads the manifest, validates the
 *     declared command against an allowlist, executes it in project_path, and
 *     compares actual outcome to the manifest's `expected_pre_outcome`.
 *  3. The result lands in the tdd_checks table. finalizeStage refuses to mark
 *     the tests_pre stage `passed` unless a row exists with status='verified'.
 *  4. After the engineer finishes the `code` stage and the judge passes, the
 *     driver calls `tdd_post_check(code_stage_id)`. This re-runs the same test
 *     command against the now-coded tree and compares to
 *     `expected_post_outcome` (always 'all_pass' for all three modes).
 *  5. finalizeStage refuses to mark the `code` stage `passed` if its immediate
 *     prior stage was `tests_pre` and no verified post row exists.
 *
 * Threat model: the test command is attacker-controllable in theory (any
 * compromised generator could declare `rm -rf /` as test_command). The
 * allowlist restricts the head binary to known test-runner CLIs, refuses
 * shell metacharacters, and spawns via execa with shell=false. Tests still
 * run with project-tree write access — that's inherent to running real test
 * code; the allowlist only stops trivial command injection.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { trackedExeca as execa } from "../mcp/cli-runner.js";
import { nanoid } from "nanoid";
import YAML from "yaml";
import { z } from "zod";
import { db, txImmediate } from "../db/database.js";
import { projectArtifactDir } from "../util/paths.js";
import { log } from "../util/logger.js";
import {
  parseAndValidateCommand as sharedParseAndValidateCommand,
  CommandRejectedError,
} from "./artifact-validators/command-allowlist.js";

// ─── Manifest schema ─────────────────────────────────────────────────────

export const TDD_MODES = ["bug-fix", "refactor", "feature-tdd"] as const;
export const TDD_RUNNERS = ["vitest", "jest", "mocha", "pytest", "go-test", "cargo-test", "unittest", "playwright", "node-test", "other"] as const;
/**
 * Valid outcome expectations.
 *
 * "mixed" is accepted for `expected_pre_outcome` ONLY. A bug-fix red phase that
 * appends failing tests to an existing suite is inherently mixed (the new
 * assertions fail, the pre-existing tests and regression guards still pass), and
 * forcing authors to isolate red assertions into an all-failing file to satisfy
 * the gate produces worse tests. `expected_post_outcome` remains pinned to the
 * literal "all_pass" in TddManifestSchema below, so widening this enum cannot
 * weaken the green gate.
 */
export const TDD_OUTCOMES = ["all_pass", "all_fail", "mixed"] as const;

export const TddManifestSchema = z.object({
  tdd_mode: z.enum(TDD_MODES),
  test_runner: z.enum(TDD_RUNNERS),
  test_command: z.string().min(1).max(2000),
  test_files: z.array(z.string().min(1)).min(1),
  expected_pre_outcome: z.enum(TDD_OUTCOMES),
  expected_post_outcome: z.literal("all_pass"),
  timeout_ms: z.number().int().min(10_000).max(900_000).optional(),
  cited_artifacts: z.array(z.object({
    kind: z.string().min(1),
    path: z.string().min(1),
  })).min(1),
});

export type TddManifest = z.infer<typeof TddManifestSchema>;

// ─── Command allowlist ───────────────────────────────────────────────────

const ALLOWED_COMMAND_HEADS = new Set([
  "npx", "node", "npm", "pnpm", "yarn", "bun",
  "python", "python3",
  "pytest",
  "go",
  "cargo",
]);

/**
 * Backwards-compat alias. The TDD-specific error name is preserved for
 * any external consumer importing it; the implementation now wraps the
 * shared CommandRejectedError so refactor stays behavior-preserving.
 */
export class TddCommandRejectedError extends Error {
  constructor(message: string, public readonly command: string) {
    super(message);
    this.name = "TddCommandRejectedError";
  }
}

/**
 * Wrapper around the shared allowlist that preserves the TDD-prefix error
 * messages tests/users may already grep for.
 */
export function parseAndValidateCommand(cmd: string): { head: string; args: string[] } {
  try {
    return sharedParseAndValidateCommand(cmd, { allowedHeads: ALLOWED_COMMAND_HEADS });
  } catch (err) {
    if (err instanceof CommandRejectedError) {
      throw new TddCommandRejectedError(
        err.message.replace(/^command /, "tdd test_command "),
        err.command,
      );
    }
    throw err;
  }
}

function maybeInt(v: string | undefined): number | null {
  if (v === undefined) return null;
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : null;
}

/**
 * Normalise runner output before regex matching.
 *
 * Test runners colour their summary lines by default on Windows and under CI
 * regardless of FORCE_COLOR -- tinyrainbow/picocolors test for FORCE_COLOR
 * *presence*, not value, so `FORCE_COLOR: "0"` actually ENABLES colour. The
 * escape bytes land between the label and the count ("Tests \x1b[22m
 * \x1b[1m\x1b[31m9 failed"), which defeats every count regex below and silently
 * downgrades a clean red phase to "mixed" -- the one bucket the TDD gate exists
 * to distinguish a clean red from. See
 * .harness/run_9KKRO08lbJsc/tdd_checks/parser-false-negative.md in the
 * AutoOrchestrate repo for the run that surfaced this.
 *
 * Bare \r progress rewrites are collapsed for the same reason: String.match
 * returns the FIRST hit, so an intermediate progress frame would otherwise be
 * read as the final count. CRLF line endings are preserved by the (?!\n) guard.
 */
export function normalizeRunnerOutput(s: string): string {
  const noAnsi = s
    // CSI sequences (colour, cursor moves, erase-line).
    // eslint-disable-next-line no-control-regex
    .replace(/\x1B\[[0-9;]*[A-Za-z]/g, "")
    // OSC sequences (window title, hyperlinks), BEL- or ST-terminated.
    // eslint-disable-next-line no-control-regex
    .replace(/\x1B\][^\x07\x1B]*(?:\x07|\x1B\\)/g, "");
  return noAnsi.replace(/^.*\r(?!\n)/gm, "");
}

/** First line of `out` matching `pattern`, or null. */
function findLine(out: string, pattern: RegExp): string | null {
  for (const line of out.split(/\r?\n/)) {
    if (pattern.test(line)) return line;
  }
  return null;
}

/** First capture group of `pattern` in `s` as an int, or null if absent. */
function matchCount(s: string, pattern: RegExp): number | null {
  const m = s.match(pattern);
  return m ? maybeInt(m[1]) : null;
}

// ─── Manifest lookup ─────────────────────────────────────────────────────

/**
 * Locate the tdd_manifest artifact for a tests_pre stage. Returns the absolute
 * path on disk, or throws.
 */
function loadManifestForStage(stage_id: string): { manifest: TddManifest; manifestAbsPath: string; runId: string; projectPath: string; stageKind: string } {
  const stageRow = db()
    .prepare(`SELECT id, kind, run_id FROM stages WHERE id = ?`)
    .get(stage_id) as { id: string; kind: string; run_id: string } | undefined;
  if (!stageRow) throw new Error(`stage ${stage_id} not found`);

  const runRow = db()
    .prepare(`SELECT project_path FROM runs WHERE id = ?`)
    .get(stageRow.run_id) as { project_path: string } | undefined;
  if (!runRow) throw new Error(`run ${stageRow.run_id} not found`);

  const artifactRow = db()
    .prepare(
      `SELECT path FROM artifacts
       WHERE stage_id = ? AND kind = 'tdd_manifest'
       ORDER BY created_at DESC LIMIT 1`,
    )
    .get(stage_id) as { path: string } | undefined;
  if (!artifactRow) {
    throw new Error(
      `tdd_manifest artifact not found for stage ${stage_id} (kind=${stageRow.kind}). ` +
      `The test-strategist must archive a manifest with kind='tdd_manifest' as part of the tests_pre stage.`,
    );
  }

  const manifestAbs = join(runRow.project_path, artifactRow.path);
  if (!existsSync(manifestAbs)) {
    throw new Error(`tdd_manifest registered at ${artifactRow.path} but file is missing on disk`);
  }
  let parsed: unknown;
  try {
    parsed = YAML.parse(readFileSync(manifestAbs, "utf8"));
  } catch (e) {
    throw new Error(`tdd_manifest at ${manifestAbs} is not valid YAML: ${(e as Error).message}`);
  }
  const manifest = TddManifestSchema.parse(parsed);
  return { manifest, manifestAbsPath: manifestAbs, runId: stageRow.run_id, projectPath: runRow.project_path, stageKind: stageRow.kind };
}

/**
 * For a `code` stage, find the tests_pre stage that immediately preceded it
 * in the same run (by started_at order). Returns null if there isn't one.
 */
export function findPriorTestsPreStage(code_stage_id: string): { stage_id: string } | null {
  const code = db()
    .prepare(`SELECT id, run_id, started_at FROM stages WHERE id = ?`)
    .get(code_stage_id) as { id: string; run_id: string; started_at: string } | undefined;
  if (!code) return null;
  const prior = db()
    .prepare(
      `SELECT id FROM stages
       WHERE run_id = ? AND kind = 'tests_pre' AND started_at < ?
       ORDER BY started_at DESC LIMIT 1`,
    )
    .get(code.run_id, code.started_at) as { id: string } | undefined;
  return prior ? { stage_id: prior.id } : null;
}

// ─── Outcome parsing ─────────────────────────────────────────────────────

export type TddActual = "all_pass" | "all_fail" | "mixed" | "error";

export type ParsedOutcome = {
  actual: TddActual;
  passed: number | null;
  failed: number | null;
  reason: string | null;
};

/**
 * Framework-aware parser. Returns 'mixed' when the runner reports both
 * passed and failed counts, 'all_pass' / 'all_fail' on unanimous outcomes,
 * 'error' when the runner couldn't even start (e.g., module not found).
 */
export function parseTestOutcome(runner: string, exitCode: number, stdout: string, stderr: string): ParsedOutcome {
  const combined = normalizeRunnerOutput(stdout + "\n" + stderr);

  // Common "couldn't start" patterns — translate to 'error' regardless of runner.
  if (/Cannot find module/i.test(combined) ||
      /ModuleNotFoundError/i.test(combined) ||
      /No such file or directory/i.test(combined) ||
      /command not found/i.test(combined) ||
      /ENOENT/.test(combined)) {
    if (!/(passed|failed|FAIL|PASS|✓|✗)/i.test(combined)) {
      return { actual: "error", passed: null, failed: null, reason: extractFirstLine(combined, /Cannot find module|ModuleNotFoundError|No such file or directory|command not found|ENOENT/i) };
    }
  }

  switch (runner) {
    case "vitest":   return parseVitest(exitCode, combined);
    case "jest":     return parseJest(exitCode, combined);
    case "mocha":    return parseMocha(exitCode, combined);
    case "playwright": return parsePlaywright(exitCode, combined);
    case "pytest":   return parsePytest(exitCode, combined);
    case "go-test":  return parseGoTest(exitCode, combined);
    case "cargo-test": return parseCargoTest(exitCode, combined);
    case "unittest": return parseUnittest(exitCode, combined);
    case "node-test": return parseNodeTest(exitCode, combined);
    default:         return parseGeneric(exitCode, combined);
  }
}

function parseVitest(exitCode: number, out: string): ParsedOutcome {
  // Vitest: "Tests  3 passed | 2 failed (5)", "Tests  2 failed | 3 passed (5)",
  // "Tests  5 passed (5)", "Tests  15 failed (15)" (vitest omits the zero side),
  // and "Tests  9 failed | 1 skipped (10)".
  //
  // The old implementation matched the pipe-separated segments POSITIONALLY,
  // which cannot express a skipped/todo segment: `reverse` required the second
  // segment to be "passed", and `onlyFailed`'s (?!\s*\|) lookahead explicitly
  // rejects a trailing pipe. So a clean red phase carrying a single skipped test
  // left BOTH counts null and fell through classify() to "mixed" -- the one
  // bucket the TDD gate exists to distinguish a clean red from, and the same
  // class of false negative fixed for jest/pytest in 33b183b.
  //
  // Isolate the summary line first, then scan it for each count independently
  // (the shape parseJest/parsePytest already use). The selector requires
  // "passed"/"failed" after the count so an arbitrary output line beginning
  // "Tests 9 ..." cannot be mistaken for the summary; "Test Files  2 failed (2)"
  // cannot match either, since "Tests" needs the literal 's' and findLine scans
  // one line at a time so \s+ can never cross into another line.
  //
  // skipped/todo are deliberately folded into NEITHER count: a skipped test is
  // neither a pass nor a failure, and counting one as a pass would reintroduce
  // the false "mixed".
  let passed: number | null = null;
  let failed: number | null = null;
  const summary = findLine(out, /^\s*Tests\s+\d+\s+(?:passed|failed)\b/im);
  if (summary) {
    failed = matchCount(summary, /(\d+)\s+failed/i) ?? 0;
    passed = matchCount(summary, /(\d+)\s+passed/i) ?? 0;
  }
  return classify(exitCode, passed, failed, out, /\bFAIL\b|✗|×/i);
}

function parseJest(exitCode: number, out: string): ParsedOutcome {
  // Jest: "Tests:       1 failed, 4 passed, 5 total"
  //       "Tests:       9 failed, 9 total"        <- all-fail omits the passed segment
  //       "Tests:       5 passed, 5 total"
  // Isolate the summary line FIRST, then scan within it. A single all-or-nothing
  // regex that requires "<n> passed, <n> total" cannot match the all-fail shape,
  // which left both counts null and fell through to "mixed" -- the same class of
  // false negative fixed for vitest in 9561c42. Scanning the isolated line (not
  // the whole output) keeps counts from test NAMES or per-file lines out.
  let passed: number | null = null;
  let failed: number | null = null;
  const summary = findLine(out, /^\s*Tests:\s+\d+/im);
  if (summary) {
    failed = matchCount(summary, /(\d+)\s+failed/i) ?? 0;
    passed = matchCount(summary, /(\d+)\s+passed/i) ?? 0;
  }
  return classify(exitCode, passed, failed, out, /\bFAIL\b|✕|✗/i);
}

function parseMocha(exitCode: number, out: string): ParsedOutcome {
  const passingM = out.match(/(\d+)\s+passing/i);
  const failingM = out.match(/(\d+)\s+failing/i);
  const passed = passingM ? maybeInt(passingM[1]) : null;
  const failed = failingM ? maybeInt(failingM[1]) : (exitCode === 0 ? 0 : null);
  return classify(exitCode, passed, failed, out, /\d+\s+failing/i);
}

function parsePlaywright(exitCode: number, out: string): ParsedOutcome {
  const failedM = out.match(/(\d+)\s+failed/i);
  const passedM = out.match(/(\d+)\s+passed/i);
  const failed = failedM ? maybeInt(failedM[1]) : (exitCode === 0 ? 0 : null);
  const passed = passedM ? maybeInt(passedM[1]) : null;
  return classify(exitCode, passed, failed, out, /\d+\s+failed/i);
}

function parsePytest(exitCode: number, out: string): ParsedOutcome {
  // "=== 1 failed, 4 passed in 0.12s ===", "=== 5 passed in 0.12s ===",
  // "=== 9 failed in 0.12s ==="  <- all-fail omits the passed segment entirely.
  // The old single regex made `failed` optional only WITH a trailing comma, so
  // the all-fail shape matched with both groups undefined -> 0/0 -> "error".
  // Isolate the summary line first, then scan it (same shape as parseJest).
  const summary = findLine(out, /^=+.*\b\d+\s+(?:failed|passed|error)/im);
  let passed: number | null = null;
  let failed: number | null = null;
  let errored = 0;
  if (summary) {
    failed = matchCount(summary, /(\d+)\s+failed/i) ?? 0;
    passed = matchCount(summary, /(\d+)\s+passed/i) ?? 0;
    errored = matchCount(summary, /(\d+)\s+errors?\b/i) ?? 0;
  }
  if (exitCode === 2 || exitCode === 5) {
    return { actual: "error", passed, failed, reason: `pytest exit ${exitCode} (collection or config error)` };
  }
  // pytest reports "error" (not "failed") for collection failures, import errors
  // and fixture-setup exceptions, all of which exit 1. Folding those into the
  // failed count would let a red phase that cannot even LOAD pass as a valid
  // red -- the same doctrine parseNodeTest states below.
  if (errored > 0) {
    return {
      actual: "error", passed, failed,
      reason: `pytest reported ${errored} error(s) (collection/import/fixture), not assertion failures`,
    };
  }
  return classify(exitCode, passed, failed, out, /=+\s+\d+\s+failed/i);
}

function parseGoTest(exitCode: number, out: string): ParsedOutcome {
  const failMatches = out.match(/--- FAIL:/g);
  const passMatches = out.match(/--- PASS:/g);
  const failed = failMatches ? failMatches.length : (exitCode === 0 ? 0 : null);
  const passed = passMatches ? passMatches.length : null;
  return classify(exitCode, passed, failed, out, /--- FAIL:/);
}

function parseCargoTest(exitCode: number, out: string): ParsedOutcome {
  const m = out.match(/test result:\s+\w+\.\s+(\d+)\s+passed;\s+(\d+)\s+failed/i);
  let passed: number | null = null;
  let failed: number | null = null;
  if (m) { passed = maybeInt(m[1]); failed = maybeInt(m[2]); }
  return classify(exitCode, passed, failed, out, /\d+\s+failed/i);
}

function parseUnittest(exitCode: number, out: string): ParsedOutcome {
  // unittest prints "Ran <n> tests in <t>s" followed by "OK", "OK (skipped=2)",
  // or "FAILED (failures=9, errors=1, skipped=1)". The keys inside the
  // parenthetical are order-independent and any subset may be absent, so scan
  // the isolated summary line for each key rather than matching a fixed
  // sequence -- the same doctrine parseJest/parsePytest use.
  //
  // `passed` is DERIVED (ran - failed - skipped), because unittest never prints
  // a pass count. Subtracting skipped is load-bearing: the old
  // `passed = ran - failed` counted every skipped test as a pass, so
  // "Ran 10 tests" + "FAILED (failures=9, skipped=1)" reported 1 passed and
  // classified as "mixed" on what is actually a clean red phase -- the same
  // false negative fixed for vitest above.
  const summary = findLine(out, /^\s*(?:OK|FAILED)\b/im);
  const ranM = out.match(/Ran\s+(\d+)\s+tests?/i);
  const ran = ranM ? maybeInt(ranM[1]) : null;

  let failed: number | null = null;
  let skipped = 0;
  if (summary) {
    skipped = matchCount(summary, /skipped=(\d+)/i) ?? 0;
    failed = /^\s*FAILED\b/i.test(summary)
      ? (matchCount(summary, /failures=(\d+)/i) ?? 0) + (matchCount(summary, /errors=(\d+)/i) ?? 0)
      : 0;
  } else if (exitCode === 0) failed = 0;

  // Math.max guards a malformed summary whose counts exceed the Ran total from
  // producing a negative pass count (which classify() would read as all_pass).
  const passed = ran !== null && failed !== null ? Math.max(0, ran - failed - skipped) : null;
  return classify(exitCode, passed, failed, out, /FAILED\s+\(/i);
}

function parseNodeTest(exitCode: number, out: string): ParsedOutcome {
  // Node's built-in runner (`node --test`) prints a trailing counter block.
  // The spec reporter (the non-TTY default since Node 20) prefixes each line
  // with U+2139 INFORMATION SOURCE; the tap reporter prefixes with "#". Both
  // emit the same "<label> <count>" pairs, so accept either marker:
  //     ℹ pass 9        |  # pass 9
  //     ℹ fail 10       |  # fail 10
  // `fail` counts assertion failures and suite-level failures alike. A file
  // that throws at import time reports 0 pass / 0 fail, which classify() maps
  // to "error" rather than "all_fail" -- a red phase that cannot load is not
  // a valid red phase.
  const passM = out.match(/^[\sℹ#]*pass\s+(\d+)\s*$/im);
  const failM = out.match(/^[\sℹ#]*fail\s+(\d+)\s*$/im);
  const passed = passM ? maybeInt(passM[1]) : null;
  const failed = failM ? maybeInt(failM[1]) : null;
  return classify(exitCode, passed, failed, out, /^[\sℹ#]*fail\s+[1-9]/im);
}

function parseGeneric(exitCode: number, out: string): ParsedOutcome {
  // No structured parse; rely on exit code only.
  if (exitCode === 0) return { actual: "all_pass", passed: null, failed: 0, reason: "generic runner: exit 0 → assumed all_pass (no parse)" };
  return { actual: "mixed", passed: null, failed: null, reason: `generic runner: exit ${exitCode} → cannot distinguish all_fail from mixed without parser` };
}

function classify(exitCode: number, passed: number | null, failed: number | null, out: string, failPattern: RegExp): ParsedOutcome {
  if (passed === null && failed === null) {
    if (exitCode === 0) return { actual: "all_pass", passed: 0, failed: 0, reason: "no count parsed; exit 0 ⇒ all_pass" };
    if (failPattern.test(out)) return { actual: "mixed", passed: null, failed: null, reason: `non-zero exit and fail pattern present; couldn't parse counts` };
    return { actual: "error", passed: null, failed: null, reason: `exit ${exitCode}, no test output recognized` };
  }
  const p = passed ?? 0;
  const f = failed ?? 0;
  if (p === 0 && f === 0) return { actual: "error", passed: 0, failed: 0, reason: "runner reported zero tests executed" };
  if (f === 0 && p > 0)  return { actual: "all_pass", passed: p, failed: 0, reason: null };
  if (p === 0 && f > 0)  return { actual: "all_fail", passed: 0, failed: f, reason: null };
  return { actual: "mixed", passed: p, failed: f, reason: `mixed outcome: ${p} passed, ${f} failed` };
}

function extractFirstLine(text: string, pattern: RegExp): string {
  for (const line of text.split(/\r?\n/)) {
    if (pattern.test(line)) return line.trim().slice(0, 300);
  }
  const first = text.split(/\r?\n/)[0];
  return first ? first.trim().slice(0, 300) : "";
}

// ─── The gate itself ─────────────────────────────────────────────────────

export type TddCheckRow = {
  id: string;
  run_id: string;
  stage_id: string;
  phase: "pre" | "post";
  mode: typeof TDD_MODES[number];
  test_runner: string;
  test_command: string;
  test_files_json: string;
  expected: typeof TDD_OUTCOMES[number];
  actual: TddActual;
  status: "verified" | "violation" | "execution_error";
  passed_count: number | null;
  failed_count: number | null;
  exit_code: number | null;
  duration_ms: number;
  output_path: string | null;
  reason: string | null;
  manifest_path: string;
  created_at: string;
};

export async function runTddCheck(opts: { stage_id: string; phase: "pre" | "post" }): Promise<TddCheckRow> {
  // For phase='post' the caller passes the CODE stage_id; we resolve the prior
  // tests_pre stage to find the manifest, but the row's stage_id is the code
  // stage so finalizeStage can find it by (code_stage_id, phase='post').
  const recordStageId = opts.stage_id;
  let manifestStageId = opts.stage_id;
  if (opts.phase === "post") {
    const prior = findPriorTestsPreStage(opts.stage_id);
    if (!prior) {
      throw new Error(`tdd_post_check: stage ${opts.stage_id} has no prior tests_pre stage in the same run`);
    }
    manifestStageId = prior.stage_id;
  }

  const { manifest, manifestAbsPath, runId, projectPath, stageKind } = loadManifestForStage(manifestStageId);

  // Phase sanity: the manifest's home stage must be tests_pre.
  if (stageKind !== "tests_pre") {
    throw new Error(`tdd_${opts.phase}_check: manifest stage ${manifestStageId} is kind='${stageKind}', expected 'tests_pre'`);
  }

  const expected = opts.phase === "pre" ? manifest.expected_pre_outcome : manifest.expected_post_outcome;
  let parsedCommand: { head: string; args: string[] };
  try {
    parsedCommand = parseAndValidateCommand(manifest.test_command);
  } catch (e) {
    return persistRow({
      run_id: runId,
      stage_id: recordStageId,
      phase: opts.phase,
      mode: manifest.tdd_mode,
      test_runner: manifest.test_runner,
      test_command: manifest.test_command,
      test_files: manifest.test_files,
      expected,
      actual: "error",
      status: "execution_error",
      passed: null,
      failed: null,
      exit_code: null,
      duration_ms: 0,
      output_path: null,
      reason: (e as Error).message,
      manifest_path: manifestAbsPath,
    });
  }

  const timeoutMs = manifest.timeout_ms ?? 5 * 60 * 1000;
  const started = Date.now();
  let exitCode: number | null = null;
  let stdout = "";
  let stderr = "";
  let timedOut = false;
  let spawnFailed: string | null = null;

  try {
    const result = await execa(parsedCommand.head, parsedCommand.args, {
      cwd: projectPath,
      timeout: timeoutMs,
      reject: false,
      shell: false,
      windowsHide: true,
      all: false,
      stripFinalNewline: false,
      // NO_COLOR is the only key that actually disables colour: tinyrainbow /
      // picocolors enable it on `"FORCE_COLOR" in env` (presence, not value),
      // on `"CI" in env`, and unconditionally on win32. FORCE_COLOR must be
      // `undefined` rather than "" or "0" -- Node's normalizeSpawnArguments
      // skips undefined entries, so that is the only value that removes an
      // inherited key from the child env instead of leaving it present.
      // The parser strips ANSI regardless (normalizeRunnerOutput); this is
      // belt-and-braces so the archived log stays readable too.
      env: { ...process.env, CI: "1", NO_COLOR: "1", FORCE_COLOR: undefined },
    });
    exitCode = result.exitCode ?? null;
    stdout = result.stdout ?? "";
    stderr = result.stderr ?? "";
    timedOut = result.timedOut === true;
  } catch (e) {
    spawnFailed = (e as Error).message;
  }
  const durationMs = Date.now() - started;

  const outDir = join(projectArtifactDir(projectPath, runId), "tdd_checks");
  mkdirSync(outDir, { recursive: true });
  const outFile = join(outDir, `${recordStageId}.${opts.phase}.${nanoid(8)}.log`);
  writeFileSync(
    outFile,
    `# TDD ${opts.phase} check\n` +
    `command: ${manifest.test_command}\n` +
    `cwd: ${projectPath}\n` +
    `exit_code: ${exitCode}\n` +
    `timed_out: ${timedOut}\n` +
    `duration_ms: ${durationMs}\n` +
    `spawn_error: ${spawnFailed ?? ""}\n` +
    `--- stdout ---\n${stdout}\n--- stderr ---\n${stderr}\n`,
    "utf8",
  );

  if (spawnFailed !== null) {
    return persistRow({
      run_id: runId,
      stage_id: recordStageId,
      phase: opts.phase,
      mode: manifest.tdd_mode,
      test_runner: manifest.test_runner,
      test_command: manifest.test_command,
      test_files: manifest.test_files,
      expected,
      actual: "error",
      status: "execution_error",
      passed: null,
      failed: null,
      exit_code: null,
      duration_ms: durationMs,
      output_path: outFile,
      reason: `spawn failed: ${spawnFailed}`,
      manifest_path: manifestAbsPath,
    });
  }

  if (timedOut) {
    return persistRow({
      run_id: runId,
      stage_id: recordStageId,
      phase: opts.phase,
      mode: manifest.tdd_mode,
      test_runner: manifest.test_runner,
      test_command: manifest.test_command,
      test_files: manifest.test_files,
      expected,
      actual: "error",
      status: "execution_error",
      passed: null,
      failed: null,
      exit_code: exitCode,
      duration_ms: durationMs,
      output_path: outFile,
      reason: `test command exceeded timeout of ${timeoutMs}ms`,
      manifest_path: manifestAbsPath,
    });
  }

  const parsed = parseTestOutcome(manifest.test_runner, exitCode ?? -1, stdout, stderr);
  let status: "verified" | "violation" | "execution_error";
  if (parsed.actual === "error") status = "execution_error";
  else if (parsed.actual === expected) status = "verified";
  else status = "violation";

  const reason = parsed.reason ?? (
    status === "verified" ? null
    : status === "violation" ? `expected ${expected}, got ${parsed.actual}`
    : null
  );

  return persistRow({
    run_id: runId,
    stage_id: recordStageId,
    phase: opts.phase,
    mode: manifest.tdd_mode,
    test_runner: manifest.test_runner,
    test_command: manifest.test_command,
    test_files: manifest.test_files,
    expected,
    actual: parsed.actual,
    status,
    passed: parsed.passed,
    failed: parsed.failed,
    exit_code: exitCode,
    duration_ms: durationMs,
    output_path: outFile,
    reason,
    manifest_path: manifestAbsPath,
  });
}

function persistRow(r: {
  run_id: string;
  stage_id: string;
  phase: "pre" | "post";
  mode: typeof TDD_MODES[number];
  test_runner: string;
  test_command: string;
  test_files: string[];
  expected: typeof TDD_OUTCOMES[number];
  actual: TddActual;
  status: "verified" | "violation" | "execution_error";
  passed: number | null;
  failed: number | null;
  exit_code: number | null;
  duration_ms: number;
  output_path: string | null;
  reason: string | null;
  manifest_path: string;
}): TddCheckRow {
  const id = nanoid();
  const created_at = new Date().toISOString();
  txImmediate(() => {
    db()
      .prepare(
        `INSERT INTO tdd_checks(
          id, run_id, stage_id, phase, mode, test_runner, test_command,
          test_files_json, expected, actual, status, passed_count, failed_count,
          exit_code, duration_ms, output_path, reason, manifest_path, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id, r.run_id, r.stage_id, r.phase, r.mode, r.test_runner, r.test_command,
        JSON.stringify(r.test_files), r.expected, r.actual, r.status,
        r.passed, r.failed, r.exit_code, r.duration_ms, r.output_path, r.reason,
        r.manifest_path, created_at,
      );
  });
  log.info({
    event: "tdd_check",
    id, run_id: r.run_id, stage_id: r.stage_id, phase: r.phase, mode: r.mode,
    expected: r.expected, actual: r.actual, status: r.status,
    duration_ms: r.duration_ms,
  });
  return {
    id, run_id: r.run_id, stage_id: r.stage_id, phase: r.phase, mode: r.mode,
    test_runner: r.test_runner, test_command: r.test_command,
    test_files_json: JSON.stringify(r.test_files), expected: r.expected,
    actual: r.actual, status: r.status, passed_count: r.passed, failed_count: r.failed,
    exit_code: r.exit_code, duration_ms: r.duration_ms, output_path: r.output_path,
    reason: r.reason, manifest_path: r.manifest_path, created_at,
  };
}

/** Returns the latest tdd_check row for (stage_id, phase) or null. */
export function getLatestTddCheck(stage_id: string, phase: "pre" | "post"): TddCheckRow | null {
  const row = db()
    .prepare(
      `SELECT id, run_id, stage_id, phase, mode, test_runner, test_command,
              test_files_json, expected, actual, status, passed_count, failed_count,
              exit_code, duration_ms, output_path, reason, manifest_path, created_at
       FROM tdd_checks
       WHERE stage_id = ? AND phase = ?
       ORDER BY created_at DESC LIMIT 1`,
    )
    .get(stage_id, phase) as TddCheckRow | undefined;
  return row ?? null;
}
