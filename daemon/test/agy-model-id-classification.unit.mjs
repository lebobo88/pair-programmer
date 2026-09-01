/**
 * Unit tests for agy model-id rejection classification.
 * Covers criteria 5, 6, 7 from repro.md (run_jc1UxeCMvyZR).
 *
 * RED PHASE: the test for criterion 5 (isPersistentStderr returning true for
 * the agy rejection string) is currently expected to FAIL because
 * PERSISTENT_STDERR_PATTERNS does not yet contain a pattern matching
 * "is not recognized as a known model".
 */

import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import assert from "node:assert/strict";
import { test, describe } from "node:test";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DIST = join(__dirname, "..", "dist");
const importDist = (relPath) =>
  import(pathToFileURL(join(DIST, relPath)).href);

// The exact agy rejection string from the repro (criterion 5).
const AGY_REJECTION_STDERR =
  'Error: invalid model selection (--model "gemini-3.1-pro-preview" --effort ""): ' +
  "model gemini-3.1-pro-preview is not recognized as a known model or custom model in settings";

describe("isPersistentStderr — agy model-id classification", async () => {
  const { isPersistentStderr } = await importDist("mcp/cli-runner.js");

  await test("criterion 5: returns TRUE for agy literal rejection string (RED — currently fails)", () => {
    // This assertion is the red one. After the fix it must become green.
    assert.equal(
      isPersistentStderr(AGY_REJECTION_STDERR),
      true,
      "isPersistentStderr must return true for the agy 'not recognized as a known model' rejection"
    );
  });

  await test("criterion 6: returns FALSE for read ECONNRESET (genuine transient)", () => {
    assert.equal(
      isPersistentStderr("read ECONNRESET"),
      false,
      "ECONNRESET must remain transient"
    );
  });

  await test("criterion 6: returns FALSE for socket hang up (genuine transient)", () => {
    assert.equal(
      isPersistentStderr("socket hang up"),
      false,
      "socket hang up must remain transient"
    );
  });

  await test("criterion 6: returns FALSE for HTTP 503 Service Unavailable (genuine transient)", () => {
    assert.equal(
      isPersistentStderr("HTTP 503 Service Unavailable"),
      false,
      "HTTP 503 must remain transient"
    );
  });

  await test("criterion 6: returns FALSE for 429 Too Many Requests (genuine transient)", () => {
    assert.equal(
      isPersistentStderr("429 Too Many Requests"),
      false,
      "HTTP 429 must remain transient"
    );
  });

  // Regression guards: existing persistent patterns must still be matched.
  await test("regression guard: command line is too long is still persistent", () => {
    assert.equal(isPersistentStderr("command line is too long"), true);
  });

  await test("regression guard: ENOENT is still persistent", () => {
    assert.equal(isPersistentStderr("spawn agy ENOENT"), true);
  });

  await test("regression guard: invalid api key is still persistent", () => {
    assert.equal(isPersistentStderr("invalid api key provided"), true);
  });

  await test("regression guard: unsupported model is still persistent", () => {
    assert.equal(isPersistentStderr("unsupported model gpt-3"), true);
  });
});

describe("runCliWithRetry — criterion 7: persistent classification stops at 1 attempt", async () => {
  const { runCliWithRetry } = await importDist("mcp/cli-runner.js");

  await test(
    "criterion 7: agy rejection stderr → exactly 1 attempt, classification=persistent (RED — currently fails because isPersistentStderr returns false)",
    async () => {
      // Use `process.execPath` (node) as a portable fake subprocess that:
      //   - writes the agy rejection string to stderr
      //   - exits with code 1
      // This exercises the real runCliWithRetry loop without spawning `agy`.
      const tmpDir = mkdtempSync(join(tmpdir(), "pp-agy-cls-"));
      try {
        mkdirSync(join(tmpDir, ".harness"), { recursive: true });
        const script =
          `process.stderr.write(${JSON.stringify(AGY_REJECTION_STDERR)}); process.exit(1);`;
        const result = await runCliWithRetry({
          bin: process.execPath,
          cliArgs: ["-e", script],
          cwd: tmpDir,
          vendor: "agy",
          timeout_ms: 15000,
        });

        assert.equal(
          result.attempts.length,
          1,
          `Expected exactly 1 attempt but got ${result.attempts.length} — ` +
          "a persistent failure must not be retried"
        );
        assert.equal(
          result.attempts[0].classification,
          "persistent",
          `Expected classification 'persistent' but got '${result.attempts[0].classification}'`
        );
      } finally {
        rmSync(tmpDir, { recursive: true, force: true });
      }
    }
  );
});

// ═══════════════════════════════════════════════════════════════════════════
// REFLEXION ADDITION (retry 1) — over-broad-pattern protection for criterion 6
//
// The judge observed that the criterion-6 guards above are not actually
// protective against the LIKELY lazy fix. The obvious way to make criterion 5
// green is to add a pattern like /not recognized/i. That pattern would pass
// criterion 5, pass criterion 7, and pass all eight guards above — because
// none of those guard strings contains the phrase "not recognized".
//
// The guards below close that hole: they are genuinely-transient stderr lines
// that DO contain the substring "not recognized" in an unrelated sense
// (TLS handshake / upstream proxy). A pattern narrow enough to be correct
// (e.g. /is not recognized as a known model/i or
// /not recognized as a known model or custom model/i) leaves them transient;
// a lazy /not recognized/i turns them persistent and these tests go red.
//
// ┌──────────────────────────────────────────────────────────────────────┐
// │ THESE ARE REGRESSION GUARDS, NOT RED ASSERTIONS.                     │
// │ They are GREEN NOW (nothing in PERSISTENT_STDERR_PATTERNS matches    │
// │ them today) and they MUST STAY GREEN after the fix. Do not "fix"     │
// │ them by making them red — a red here means the new pattern is too    │
// │ broad and network transients are no longer being retried.            │
// └──────────────────────────────────────────────────────────────────────┘
//
// Note also that `/not found/i` is ALREADY in PERSISTENT_STDERR_PATTERNS, so
// these strings deliberately avoid "not found" — they isolate the specific
// over-breadth risk introduced by criterion 5's new pattern.
// ═══════════════════════════════════════════════════════════════════════════

describe("isPersistentStderr — over-broad-pattern protection (GREEN NOW, MUST STAY GREEN)", async () => {
  const { isPersistentStderr } = await importDist("mcp/cli-runner.js");

  await test(
    "GREEN-STAYS-GREEN guard: TLS 'certificate authority not recognized' is TRANSIENT, not persistent",
    () => {
      assert.equal(
        isPersistentStderr(
          "warning: TLS certificate authority not recognized, retrying handshake",
        ),
        false,
        "A transient TLS handshake warning that merely contains the words 'not recognized' " +
          "must remain retryable. If this fails, the criterion-5 pattern is over-broad " +
          "(e.g. a bare /not recognized/i) — narrow it to the model-rejection phrasing.",
      );
    },
  );

  await test(
    "GREEN-STAYS-GREEN guard: 'upstream proxy not recognized; connection reset by peer' is TRANSIENT",
    () => {
      assert.equal(
        isPersistentStderr("upstream proxy not recognized; connection reset by peer"),
        false,
        "A proxy/connection-reset transient containing 'not recognized' must remain " +
          "retryable. A failure here means the new persistent pattern is too broad.",
      );
    },
  );

  await test(
    "GREEN-STAYS-GREEN guard: 'gateway not recognized, please retry in 30s' is TRANSIENT",
    () => {
      assert.equal(
        isPersistentStderr("gateway not recognized, please retry in 30s"),
        false,
        "An explicitly-retryable gateway error containing 'not recognized' must remain " +
          "transient.",
      );
    },
  );
});
