// Unit test for test/fixtures/eights-cleanup.mjs's `shutdownAndCleanup`:
// eights-integration.smoke.mjs's finally-block cleanup sequence, factored
// out so its error-surfacing contract can be proven without a real
// TheEights daemon.
//
// The bug this closes: a prior version of the smoke test threw straight out
// of the `mod.shutdown()` catch block, which skipped `removeEightsHomeWithRetry`
// entirely whenever shutdown failed — the temp EIGHTS_HOME leaked silently on
// exactly the path where cleanup mattered most (a shutdown failure usually
// means something already went wrong). This test proves:
//   1. When shutdown throws, the temp dir is STILL removed, and the shutdown
//      error is still surfaced (not swallowed).
//   2. When removal also fails, both errors are surfaced (AggregateError).
//   3. When both succeed, nothing throws.
//
// Self-contained: uses only real temp directories (mkdtempSync/rmSync via
// node:fs against os.tmpdir()) and injected fake shutdown/remove functions.
// No real TheEights daemon, no network, no pp ledger state.

import { mkdtempSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { shutdownAndCleanup, removeEightsHomeWithRetry } from "./fixtures/eights-cleanup.mjs";

function makeTempDir() {
  return mkdtempSync(join(tmpdir(), "pp-eights-cleanup-unit-"));
}

async function testShutdownThrowsRemovalStillRunsAndErrorSurfaces() {
  const dir = makeTempDir();
  assert.ok(existsSync(dir), "precondition: temp dir exists");
  const mod = {
    shutdown: async () => {
      throw new Error("boom: shutdown failed");
    },
  };
  await assert.rejects(
    () => shutdownAndCleanup(mod, dir),
    (err) => {
      assert.equal(err.message, "boom: shutdown failed");
      return true;
    },
    "shutdownAndCleanup must surface the shutdown error"
  );
  assert.equal(
    existsSync(dir),
    false,
    "temp dir must be removed even though mod.shutdown() threw — this is the bug this test closes"
  );
  console.log("✓ shutdown throw: temp dir still removed, shutdown error surfaced");
}

async function testBothStepsFailSurfacesAggregateError() {
  const dir = makeTempDir();
  const mod = {
    shutdown: async () => {
      throw new Error("boom: shutdown failed");
    },
  };
  const removeFn = async () => {
    throw new Error("boom: removal failed");
  };
  await assert.rejects(
    () => shutdownAndCleanup(mod, dir, { removeFn }),
    (err) => {
      assert.ok(err instanceof AggregateError, "must be an AggregateError when both steps fail");
      assert.equal(err.errors.length, 2);
      assert.ok(err.errors.some((e) => e.message.includes("shutdown failed")));
      assert.ok(err.errors.some((e) => e.message.includes("removal failed")));
      return true;
    },
    "shutdownAndCleanup must surface both failures via AggregateError"
  );
  // Clean up the real dir ourselves since the injected removeFn didn't.
  rmSync(dir, { recursive: true, force: true });
  console.log("✓ both steps fail: AggregateError carries both underlying errors");
}

async function testBothStepsSucceedNoThrow() {
  const dir = makeTempDir();
  let shutdownCalled = false;
  const mod = {
    shutdown: async () => {
      shutdownCalled = true;
    },
  };
  await shutdownAndCleanup(mod, dir);
  assert.ok(shutdownCalled, "shutdown must have been invoked");
  assert.equal(existsSync(dir), false, "temp dir must be removed on the success path");
  console.log("✓ both steps succeed: shutdownAndCleanup resolves cleanly");
}

async function testNoModSkipsShutdownButStillRemoves() {
  const dir = makeTempDir();
  await shutdownAndCleanup(null, dir);
  assert.equal(
    existsSync(dir),
    false,
    "temp dir must still be removed when mod was never constructed (e.g. import failed)"
  );
  console.log("✓ mod is null (never constructed): removal still runs, no throw");
}

async function testRemoveEightsHomeWithRetrySanity() {
  const dir = makeTempDir();
  await removeEightsHomeWithRetry(dir, /* maxAttempts */ 3, /* delayMs */ 10);
  assert.equal(existsSync(dir), false, "removeEightsHomeWithRetry must remove a plain, unlocked temp dir");
  console.log("✓ removeEightsHomeWithRetry removes an unlocked temp dir on the first attempt");
}

async function main() {
  await testShutdownThrowsRemovalStillRunsAndErrorSurfaces();
  await testBothStepsFailSurfacesAggregateError();
  await testBothStepsSucceedNoThrow();
  await testNoModSkipsShutdownButStillRemoves();
  await testRemoveEightsHomeWithRetrySanity();
  console.log("✓ eights-cleanup.unit.mjs: all assertions passed");
}

main().catch((err) => {
  console.error("✗ eights-cleanup.unit.mjs failed:", err);
  process.exit(1);
});
