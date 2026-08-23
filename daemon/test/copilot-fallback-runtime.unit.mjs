/**
 * RUNTIME (behavioral) coverage for criteria 10 and 11 of repro.md
 * (run_jc1UxeCMvyZR) — defect 2, `AGY-SILENT-VENDOR-FALLTHROUGH`.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * `copilot-fallback-removed.unit.mjs` only asserts STATIC repo state
 * (criterion 8: the file is gone; criterion 9: the symbols are grepped away).
 * A future re-introduction of a silent secondary-vendor fallback under a
 * DIFFERENT name would pass every one of those assertions. Criteria 10 and 11
 * are the behavioural heart of the defect and need a runtime assertion:
 *
 *   On a PRIMARY vendor failure, NO secondary vendor process is spawned and
 *   the primary's failing envelope is returned intact.
 *
 * HOW IT IS OBSERVED (no production change required)
 * --------------------------------------------------
 * `runCopilotFallback` spawns the literal binary name `copilot`
 * (copilot-runner.ts: `bin: "copilot"`), and `isCopilotAvailable()` probes
 * `copilot --version`. Both resolve through PATH. So we make the spawn
 * OBSERVABLE rather than mocking it:
 *
 *   1. Build a temp dir containing `copilot.cmd`, `agy.cmd` and `codex.cmd`
 *      and put it FIRST on PATH. (Windows: a bare `copilot` resolves via
 *      PATHEXT, so the shim must be `.cmd`. Verified working on this machine
 *      before this test was committed.)
 *   2. `copilot.cmd` APPENDS a marker line to a temp file on every
 *      invocation — including the `--version` availability probe — then
 *      exits 0. Exiting 0 matters: today the "successful" fallback rewrites
 *      the envelope to exit_code 0, which is exactly the silent
 *      vendor-fallthrough the fix must remove.
 *   3. `agy.cmd` / `codex.cmd` write a PERSISTENT-classified stderr
 *      ("invalid api key", already in PERSISTENT_STDERR_PATTERNS) and exit 1.
 *      Persistent classification means runCliWithRetry does not retry, so the
 *      primary produces exactly one attempt and the test stays fast and
 *      deterministic (~0.5s per case, no network).
 *
 * POSITIVE CONTROL (anti-vacuity)
 * -------------------------------
 * A test that "passes because the shim never had a chance to fire" is
 * worthless. Each case therefore runs a POSITIVE CONTROL first: it spawns
 * `copilot --version` itself through `trackedExeca` (the same execa path the
 * production probe uses) and ASSERTS THE MARKER WAS WRITTEN. Only then is the
 * marker cleared and the real call made. If PATH shimming ever stops working
 * on this platform, the positive control fails loudly instead of the
 * assertion silently going green.
 *
 * ENTRY POINTS
 * ------------
 * `agyGenerate` and `codexGenerate` are NOT exported. The exported
 * `agyCritique` / `codexCritique` delegate to them, and when an explicit
 * `output_schema` is passed they call the generator EXACTLY ONCE with no
 * `stabilizeCritiqueResult` retry wrapper — a clean, single-shot path into
 * the `if (result.exit_code !== 0) return attemptCopilotFallback(...)` branch
 * at antigravity-server.ts:185 and codex-server.ts:382.
 *
 * NOTE on `codexCritique`'s `_invoke` DI seam (codex-server.ts:107): it is NOT
 * usable here, because `_invoke` REPLACES `codexGenerate` wholesale and the
 * fallback lives INSIDE `codexGenerate`. Injecting through the seam would skip
 * the very code under test. `agyGenerate` has no equivalent seam at all. The
 * PATH-shim approach covers BOTH vendors for real, so neither gap matters.
 *
 * RED NOW / GREEN AFTER THE FIX — verified empirically:
 *   PP_COPILOT_FALLBACK=1 (today):  marker WRITTEN, exit_code 0, attempts 2,
 *                                   failure_archive_path undefined  → FAILS
 *   fallback removed:               marker ABSENT,  exit_code 1, attempts 1,
 *                                   failure_archive_path defined    → PASSES
 *
 * This file imports NOTHING from copilot-runner.js, so it keeps compiling
 * after that module is deleted.
 */

import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join, delimiter } from "node:path";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  existsSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import assert from "node:assert/strict";
import { test, describe } from "node:test";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DIST = join(__dirname, "..", "dist");
const importDist = (relPath) => import(pathToFileURL(join(DIST, relPath)).href);

// ── Environment must be pinned BEFORE any dist module is imported ────────
// paths.ts computes ROOT_DIR/SANDBOX_DIR at module load from PP_HOME, and
// config.ts computes COPILOT_FALLBACK_ENABLED at module load from
// PP_COPILOT_FALLBACK. Redirect all daemon state into a temp home so this
// stays a self-contained unit test (no ~/.pair-programmer, no live daemon).
const HOME_DIR = mkdtempSync(join(tmpdir(), "pp-fallback-home-"));
process.env.PP_HOME = HOME_DIR;
process.env.PP_DB_PATH = join(HOME_DIR, "state.db");
// Explicitly ENABLE the fallback. Without this the test could pass vacuously
// on a machine where the operator has already set PP_COPILOT_FALLBACK=0 —
// the fallback would be skipped for the wrong reason and the red phase would
// be a lie. Post-fix this variable is inert (the flag no longer exists).
process.env.PP_COPILOT_FALLBACK = "1";

/**
 * Create a temp dir on PATH containing a marker-writing `copilot` shim and a
 * failing primary-vendor shim. Returns { dir, marker, restorePath }.
 */
function installShims(primaryBin, label) {
  const dir = mkdtempSync(join(tmpdir(), `pp-shim-${label}-`));
  const marker = join(dir, "copilot-spawns.txt");
  // Every invocation (including `--version`) appends a line.
  writeFileSync(
    join(dir, "copilot.cmd"),
    `@echo off\r\n>>"${marker}" echo SPAWNED %*\r\nexit /b 0\r\n`,
    "utf8",
  );
  writeFileSync(
    join(dir, `${primaryBin}.cmd`),
    `@echo off\r\n>&2 echo invalid api key provided by ${primaryBin} shim\r\nexit /b 1\r\n`,
    "utf8",
  );
  // POSIX equivalents so this file is not silently a no-op off Windows.
  writeFileSync(
    join(dir, "copilot"),
    `#!/bin/sh\necho "SPAWNED $@" >> "${marker}"\nexit 0\n`,
    { encoding: "utf8", mode: 0o755 },
  );
  writeFileSync(
    join(dir, primaryBin),
    `#!/bin/sh\necho "invalid api key provided by ${primaryBin} shim" 1>&2\nexit 1\n`,
    { encoding: "utf8", mode: 0o755 },
  );
  const prevPath = process.env.PATH;
  process.env.PATH = dir + delimiter + prevPath;
  return {
    dir,
    marker,
    workDir: (() => {
      const w = join(dir, "work");
      mkdirSync(w, { recursive: true });
      return w;
    })(),
    cleanup() {
      process.env.PATH = prevPath;
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

function markerText(marker) {
  return existsSync(marker) ? readFileSync(marker, "utf8") : "";
}

describe("criteria 10 & 11 — no secondary-vendor spawn on primary failure (RUNTIME)", async () => {
  const { trackedExeca } = await importDist("mcp/cli-runner.js");

  // -----------------------------------------------------------------------
  // Criterion 10 — agy
  // -----------------------------------------------------------------------
  await test(
    "criterion 10 (RED): agyGenerate returns the failing primary envelope intact and spawns NO copilot process",
    async () => {
      const shim = installShims("agy", "agy");
      try {
        // ---- POSITIVE CONTROL: prove the shim is reachable on PATH --------
        await trackedExeca("copilot", ["--version"], {
          timeout: 10_000,
          windowsHide: true,
          reject: true,
        });
        assert.match(
          markerText(shim.marker),
          /SPAWNED/,
          "POSITIVE CONTROL FAILED: the `copilot` PATH shim did not fire, so a " +
            "later 'no spawn' assertion would be vacuous. Fix the shim, do not " +
            "weaken the assertion.",
        );
        // Clear the marker: from here on, ANY line means production spawned copilot.
        rmSync(shim.marker, { force: true });

        const { agyCritique } = await importDist("mcp/antigravity-server.js");
        const result = await agyCritique({
          artifact_text: "an artifact under review",
          rubric_md: "an arbitrary rubric",
          cwd: shim.workDir,
          model: "unused-caller-model",
          // Explicit schema => single-shot invoke, no stabilizeCritiqueResult retries.
          output_schema: { type: "object" },
          timeout_ms: 20_000,
        });

        // Sanity: the PRIMARY really ran and really failed (not an ENOENT skip).
        assert.ok(
          Array.isArray(result.attempts) && result.attempts.length >= 1,
          "expected at least one primary attempt to be recorded",
        );
        assert.match(
          result.attempts[0].stderr_tail ?? "",
          /agy shim/,
          "the agy PATH shim must be the process that produced the primary failure",
        );

        // RED ASSERTION 10a — no secondary vendor process.
        assert.equal(
          markerText(shim.marker),
          "",
          "criterion 11/10: a `copilot` process was spawned after the agy primary " +
            `failed. Spawn log:\n${markerText(shim.marker)}`,
        );
        // RED ASSERTION 10b — failing envelope preserved.
        assert.notEqual(
          result.exit_code,
          0,
          "criterion 10: the failing primary envelope must be returned; a non-zero " +
            "primary must not be laundered into exit_code 0 by a secondary vendor",
        );
        // RED ASSERTION 10c — attempts preserved (not merged with fallback attempts).
        assert.equal(
          result.attempts.length,
          1,
          "criterion 10: `attempts` must be the primary's attempts only " +
            `(got ${result.attempts.length}; >1 means fallback attempts were merged in)`,
        );
        assert.equal(result.attempts[0].classification, "persistent");
        // RED ASSERTION 10d — failure_archive_path preserved (fallback clears it).
        assert.ok(
          typeof result.failure_archive_path === "string" &&
            result.failure_archive_path.length > 0,
          "criterion 10: `failure_archive_path` from the primary run must survive",
        );
      } finally {
        shim.cleanup();
      }
    },
  );

  // -----------------------------------------------------------------------
  // Criterion 11 — codex
  // -----------------------------------------------------------------------
  await test(
    "criterion 11 (RED): codexGenerate (via codexCritique) returns the failing primary envelope intact and spawns NO copilot process",
    async () => {
      const shim = installShims("codex", "codex");
      try {
        // ---- POSITIVE CONTROL ---------------------------------------------
        await trackedExeca("copilot", ["--version"], {
          timeout: 10_000,
          windowsHide: true,
          reject: true,
        });
        assert.match(
          markerText(shim.marker),
          /SPAWNED/,
          "POSITIVE CONTROL FAILED: the `copilot` PATH shim did not fire; the " +
            "'no spawn' assertion below would be vacuous.",
        );
        rmSync(shim.marker, { force: true });

        const { codexCritique } = await importDist("mcp/codex-server.js");
        const result = await codexCritique(
          {
            artifact_text: "an artifact under review",
            rubric_md: "an arbitrary rubric",
            cwd: shim.workDir,
            model: "unused-caller-model",
            output_schema: { type: "object" },
            timeout_ms: 20_000,
          },
          { skip_git_repo_check: true },
        );

        assert.ok(
          Array.isArray(result.attempts) && result.attempts.length >= 1,
          "expected at least one primary attempt to be recorded",
        );
        assert.match(
          result.attempts[0].stderr_tail ?? "",
          /codex shim/,
          "the codex PATH shim must be the process that produced the primary failure",
        );

        // RED ASSERTION 11a — spawn recorder shows zero `copilot` spawns.
        assert.equal(
          markerText(shim.marker),
          "",
          "criterion 11: a `copilot` process was spawned after the codex primary " +
            `failed. Spawn log:\n${markerText(shim.marker)}`,
        );
        // RED ASSERTION 11b — failing envelope preserved.
        assert.notEqual(
          result.exit_code,
          0,
          "criterion 11: the failing codex envelope must be returned unchanged",
        );
        // RED ASSERTION 11c — attempts not merged.
        assert.equal(
          result.attempts.length,
          1,
          `criterion 11: expected the primary's single attempt, got ${result.attempts.length}`,
        );
        // RED ASSERTION 11d — failure_archive_path preserved.
        assert.ok(
          typeof result.failure_archive_path === "string" &&
            result.failure_archive_path.length > 0,
          "criterion 11: `failure_archive_path` from the primary run must survive",
        );
      } finally {
        shim.cleanup();
      }
    },
  );
});
