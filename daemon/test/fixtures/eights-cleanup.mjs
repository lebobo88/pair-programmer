// Shared cleanup sequence for eights-integration.smoke.mjs, factored out so
// its error-surfacing contract (shutdown throws -> temp dir removal still
// runs -> the shutdown error is still surfaced) can be unit tested without a
// real TheEights daemon (see eights-cleanup.unit.mjs).

import { existsSync, rmSync } from "node:fs";

/**
 * `mod.shutdown()` closes the MCP client, which (StdioClientTransport.close())
 * ends stdin and SIGTERMs the spawned TheEights subprocess if it hasn't
 * exited within 2s. On Windows the OS can take a short additional moment to
 * release the child's open handles on `state.db`/`state.db-wal` after the
 * process is gone, so an immediate `rmSync` can race an `EBUSY`/`EPERM`. Retry
 * with backoff instead of silently swallowing the failure (a swallowed
 * failure here would mean the temp home leaks silently, un-noticed, on every
 * run — the isolation requirement is to actually remove it, not to best-effort
 * try).
 */
export async function removeEightsHomeWithRetry(dir, maxAttempts = 10, delayMs = 300) {
  let lastErr;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      rmSync(dir, { recursive: true, force: false });
      return;
    } catch (e) {
      lastErr = e;
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  if (existsSync(dir)) {
    throw new Error(`failed to remove temp EIGHTS_HOME ${dir} after ${maxAttempts} attempts: ${lastErr?.message ?? lastErr}`);
  }
}

/**
 * Cleanup sequence run from the smoke test's `finally` block: shut the MCP
 * client down (if one was ever constructed), THEN always remove the temp
 * EIGHTS_HOME — regardless of whether shutdown succeeded — and finally
 * surface whichever step(s) failed.
 *
 * A prior version put `removeEightsHomeWithRetry` AFTER a `throw e` inside
 * the shutdown `catch` block, which meant a shutdown failure skipped temp-dir
 * removal entirely (the exact leak the isolation requirement forbids). This
 * helper guarantees removal always runs by never early-returning/throwing
 * between the two steps, then rethrows:
 *   - the shutdown error, if only shutdown failed;
 *   - the removal error, if only removal failed;
 *   - an AggregateError of both, if both failed;
 *   - nothing, if both succeeded.
 *
 * `opts.shutdownFn` / `opts.removeFn` are injection points for testing this
 * sequence without a real TheEights daemon or a real MCP client.
 */
export async function shutdownAndCleanup(mod, eightsHome, opts = {}) {
  const removeFn = opts.removeFn ?? removeEightsHomeWithRetry;
  const shutdownFn = opts.shutdownFn ?? (mod ? () => mod.shutdown() : null);

  let shutdownErr;
  if (shutdownFn) {
    try {
      await shutdownFn();
    } catch (e) {
      shutdownErr = e;
      console.error(`✗ mod.shutdown() failed during cleanup: ${e?.message ?? e}`);
    }
  }

  let removeErr;
  try {
    await removeFn(eightsHome);
  } catch (e) {
    removeErr = e;
  }

  if (shutdownErr && removeErr) {
    throw new AggregateError(
      [shutdownErr, removeErr],
      `eights-integration cleanup failed on both steps: shutdown=${shutdownErr?.message ?? shutdownErr}; remove=${removeErr?.message ?? removeErr}`
    );
  }
  if (shutdownErr) throw shutdownErr;
  if (removeErr) throw removeErr;
}
