// Unit tests for the global Antigravity (agy) kill-switch (PP_DISABLE_AGY).
//
// Covers:
//   - config.agyEnabled() reflects PP_DISABLE_AGY each call (function, not a
//     load-time const).
//   - gates.listAllowedJudges() drops "agy" from preferred_producers when
//     disabled, and restores it when enabled — for both a claude generator
//     (cross-vendor) and a codex generator (still yields a non-empty judge).
//
// Both functions are pure and read process.env per call, so a single process
// can toggle the flag between assertions. Runs against the compiled dist/.

import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync, mkdirSync } from "node:fs";
import test from "node:test";
import assert from "node:assert/strict";

// Defensive: set PP_HOME before any dist import in case a transitive import
// touches DB_PATH at module-load. These modules (config, gates) shouldn't, but
// keep the suite hermetic.
const SUITE_DIR = mkdtempSync(join(tmpdir(), "pp-agy-disable-"));
mkdirSync(join(SUITE_DIR, ".pair-programmer"), { recursive: true });
process.env.PP_HOME = SUITE_DIR;

const __dirname = dirname(fileURLToPath(import.meta.url));
const DIST = join(__dirname, "..", "dist");
const importDist = (relPath) => import(pathToFileURL(join(DIST, relPath)).href);

const { agyEnabled } = await importDist("config.js");
const { evaluateGate, listAllowedJudges } = await importDist("orchestrator/gates.js");

// Helper: a cross-vendor gate decision (security gates are always cross-vendor).
const crossVendorDecision = () => evaluateGate({ gate_type: "security" });
// Helper: a same-vendor-eligible decision (docs_polish base tier is same-vendor).
const sameVendorDecision = () => evaluateGate({ gate_type: "docs_polish" });

function withFlag(value, fn) {
  const prev = process.env.PP_DISABLE_AGY;
  if (value === undefined) delete process.env.PP_DISABLE_AGY;
  else process.env.PP_DISABLE_AGY = value;
  try { return fn(); }
  finally {
    if (prev === undefined) delete process.env.PP_DISABLE_AGY;
    else process.env.PP_DISABLE_AGY = prev;
  }
}

test("agyEnabled() is true when unset", () => {
  withFlag(undefined, () => assert.equal(agyEnabled(), true));
});

test("agyEnabled() is true when '0'", () => {
  withFlag("0", () => assert.equal(agyEnabled(), true));
});

test("agyEnabled() is false when '1'", () => {
  withFlag("1", () => assert.equal(agyEnabled(), false));
});

test("enabled: claude cross-vendor judge prefers codex AND agy", () => {
  withFlag("0", () => {
    const judges = listAllowedJudges(crossVendorDecision(), "claude");
    const cross = judges.find((j) => j.agent === "judge-cross-vendor");
    assert.ok(cross, "expected a judge-cross-vendor entry");
    assert.deepEqual([...cross.preferred_producers].sort(), ["agy", "codex"]);
  });
});

test("disabled: claude cross-vendor judge prefers codex ONLY (no agy)", () => {
  withFlag("1", () => {
    const judges = listAllowedJudges(crossVendorDecision(), "claude");
    const cross = judges.find((j) => j.agent === "judge-cross-vendor");
    assert.ok(cross, "expected a judge-cross-vendor entry");
    assert.deepEqual(cross.preferred_producers, ["codex"]);
    assert.ok(
      !cross.preferred_producers.includes("agy"),
      "agy must not be a preferred producer when disabled",
    );
  });
});

test("disabled: codex generator still yields a non-empty cross-vendor judge", () => {
  withFlag("1", () => {
    // A codex generator cannot be judged by codex (same vendor); with agy
    // disabled the only cross-vendor option is claude. The list must not be empty.
    const judges = listAllowedJudges(crossVendorDecision(), "codex");
    const cross = judges.find((j) => j.agent === "judge-cross-vendor");
    assert.ok(cross, "expected a judge-cross-vendor entry");
    assert.deepEqual(cross.preferred_producers, ["claude"]);
  });
});

test("disabled: same-vendor-eligible gate also excludes agy from its cross-vendor fallback", () => {
  withFlag("1", () => {
    const judges = listAllowedJudges(sameVendorDecision(), "claude");
    const cross = judges.find((j) => j.agent === "judge-cross-vendor");
    assert.ok(cross, "same-vendor decisions still expose a cross-vendor fallback judge");
    assert.ok(!cross.preferred_producers.includes("agy"));
  });
});

test("disabled: agy generator on a same-vendor gate drops the agy same-vendor lane", () => {
  // Regression guard for the Codex-found hole: the same-vendor branch must not
  // hint preferred_producers=["agy"] when agy is disabled. The driver must
  // still get a usable (cross-vendor, non-empty) judge instead.
  withFlag("1", () => {
    const judges = listAllowedJudges(sameVendorDecision(), "agy");
    const same = judges.find((j) => j.agent === "judge-same-vendor");
    assert.equal(same, undefined, "no same-vendor judge should be offered for a disabled agy generator");
    const cross = judges.find((j) => j.agent === "judge-cross-vendor");
    assert.ok(cross, "a cross-vendor judge must still be offered");
    assert.deepEqual([...cross.preferred_producers].sort(), ["claude", "codex"]);
    assert.ok(!cross.preferred_producers.includes("agy"));
  });
});

test("enabled: agy generator still gets its (degenerate) same-vendor lane", () => {
  // Non-regression: when agy is enabled, the documented degenerate same-vendor
  // agy lane is preserved exactly as before.
  withFlag("0", () => {
    const judges = listAllowedJudges(sameVendorDecision(), "agy");
    const same = judges.find((j) => j.agent === "judge-same-vendor");
    assert.ok(same, "agy same-vendor lane must exist when enabled");
    assert.deepEqual(same.preferred_producers, ["agy"]);
  });
});

test("non-regression: codex generator keeps its same-vendor lane regardless of agy flag", () => {
  for (const flag of ["0", "1"]) {
    withFlag(flag, () => {
      const judges = listAllowedJudges(sameVendorDecision(), "codex");
      const same = judges.find((j) => j.agent === "judge-same-vendor");
      assert.ok(same, `codex same-vendor lane must exist (flag=${flag})`);
      assert.deepEqual(same.preferred_producers, ["codex"]);
    });
  }
});

test("toggle is live within one process (function, not load-time const)", () => {
  const enabled = withFlag("0", () =>
    listAllowedJudges(crossVendorDecision(), "claude")
      .find((j) => j.agent === "judge-cross-vendor").preferred_producers,
  );
  const disabled = withFlag("1", () =>
    listAllowedJudges(crossVendorDecision(), "claude")
      .find((j) => j.agent === "judge-cross-vendor").preferred_producers,
  );
  assert.ok(enabled.includes("agy"));
  assert.ok(!disabled.includes("agy"));
});
