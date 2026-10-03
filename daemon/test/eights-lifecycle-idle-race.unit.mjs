// L1B idle-close race regression (final-judge finding on e51b775).
//
// Bug being guarded against, in daemon/src/ecosystem/eights-client.ts:
// `shutdown()` (invoked either by the idle timer in `scheduleIdleClose()`, or
// explicitly) awaited `state.client.close()` while `state.kind` was still
// `"available"`, only flipping to `"uninit"` AFTER that await resolved. Any
// `safeCall` whose `ensureReady()` ran during that awaited window read
// `state.kind === "available"` and was handed back the very client instance
// mid-close — that call then failed against the closing/closed transport,
// recorded a namespace breaker failure, and re-armed `scheduleIdleClose()`.
// `shutdown()` also unconditionally zeroed `inFlightCallCount`, stomping on
// an in-flight call's own bookkeeping.
//
// Two scenarios, both against ONLY the fake-eights-daemon fixture (no real
// TheEights entry is ever referenced by this file — grep-verifiable, see the
// last test below):
//
//   (A) An idle-close timer fires WHILE a safeCall is genuinely in flight
//       (the fixture is told to delay its `eights.memory.add` response past
//       the idle deadline). Asserts the client is never closed mid-call and
//       the call still succeeds.
//   (B) A NEW safeCall starts in the window an idle-triggered `shutdown()`
//       is awaiting the (deliberately slow-to-exit) fixture's close. Asserts
//       the new call still succeeds (via the fix's re-probe path) and
//       records zero breaker failures — this is the literal race the final
//       judge's finding described.
//
// Deterministic by construction, not by timing luck: the fixture's
// `callDelayMs`/`closeDelayMs` (via the `<EIGHTS_HOME>/fixture-control.json`
// carrier file — see fixtures/fake-eights-daemon.mjs) are set an order of
// magnitude larger than `PP_ECOSYSTEM_IDLE_CLOSE_MS`, so the race window each
// scenario needs is wide open by the time this test's own `safeCall` lands
// in it; no fake timers or manual clock stepping needed.

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DIST = join(__dirname, "..", "dist");
const FIXTURE = join(__dirname, "fixtures", "fake-eights-daemon.mjs");
const importDist = (relPath) => import(pathToFileURL(join(DIST, relPath)).href);

const isolatedHome = mkdtempSync(join(tmpdir(), "pp-idle-race-home-"));
const eightsHomeDir = join(isolatedHome, ".eights-home-marker");
const ppHomeDir = join(isolatedHome, "pp-home");
const ppDbPath = join(ppHomeDir, ".pair-programmer", "state.db");

// Isolated env, set BEFORE importing anything under dist/ (module-load-time
// env reads). Never touches the real ~/.eights or ~/.pair-programmer.
process.env.HOME = isolatedHome;
process.env.USERPROFILE = isolatedHome;
process.env.HOMEDRIVE = isolatedHome.slice(0, 2);
process.env.HOMEPATH = isolatedHome.slice(2);
delete process.env.PP_ECOSYSTEM_DISABLED;
process.env.PP_HOME = ppHomeDir;
process.env.PP_DB_PATH = ppDbPath;
process.env.PP_EIGHTS_DAEMON = FIXTURE;
process.env.PP_ECOSYSTEM_PROBE_TIMEOUT_MS = "20000";
process.env.EIGHTS_HOME = eightsHomeDir;

// Idle-close fires fast; the fixture takes far longer than that to actually
// respond to a call / finish closing — this is what turns "a race that could
// happen" into "a race that WILL happen every run".
const IDLE_CLOSE_MS = 60;
const CALL_DELAY_MS = 400; // > IDLE_CLOSE_MS: keeps scenario (A)'s call in flight past the idle deadline
const CLOSE_DELAY_MS = 1500; // > IDLE_CLOSE_MS and well under the MCP SDK's 2s close()-phase caps
process.env.PP_ECOSYSTEM_IDLE_CLOSE_MS = String(IDLE_CLOSE_MS);

mkdirSync(eightsHomeDir, { recursive: true });
writeFileSync(
  join(eightsHomeDir, "fixture-control.json"),
  JSON.stringify({ closeDelayMs: CLOSE_DELAY_MS, callDelayMs: 0 }),
  "utf8",
);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function testEnvelope(mod) {
  return mod.envelopeFor({ run_id: "idle-race-test", project_path: "idle-race-project" });
}

describe("eights-client idle-close / in-flight-call race (L1B final-judge finding)", () => {
  let mod;

  before(async () => {
    mod = await importDist("ecosystem/eights-client.js");
  });

  after(async () => {
    // Best-effort final close so no fixture process (spawned with a 1.5s
    // close delay) is left running past this file's own process exit.
    try { await mod.shutdown(); } catch { /* best-effort */ }
    try { rmSync(isolatedHome, { recursive: true, force: true }); } catch { /* best-effort */ }
  });

  it("(A) an idle-close timer firing while a safeCall is in flight does not close the client mid-call", async () => {
    // Start from a clean slate (no stale connection from a previous test).
    await mod.shutdown();
    // Rewrite the control file so EVERY call against this fixture instance
    // (baked in at ITS boot) is the slow one; close stays fast for this
    // scenario so we're isolating the in-flight-call guard specifically, not
    // the closing-state race (that's scenario B).
    writeFileSync(
      join(eightsHomeDir, "fixture-control.json"),
      JSON.stringify({ closeDelayMs: 0, callDelayMs: CALL_DELAY_MS }),
      "utf8",
    );

    const envelope = testEnvelope(mod);
    // Prime the connection first (this call is ALSO delayed CALL_DELAY_MS by
    // the fixture, but we simply await it to completion — its purpose is to
    // pay the one-time cold-spawn/connect cost up front, off the clock,
    // so the timing assertions below aren't confounded by spawn latency).
    const primer = await mod.memory.add({
      envelope,
      content: "scenario A primer call",
      type: "working",
      provenance: { actor: "idle-race-test" },
    });
    assert.notEqual(primer, null, "the priming call must succeed");
    assert.equal(mod.getInFlightCallCountForTesting(), 0, "priming call must have fully settled");

    // Now the connection is warm ("available", no spawn cost): this call
    // should register as in-flight almost immediately.
    const callPromise = mod.memory.add({
      envelope,
      content: "scenario A in-flight call",
      type: "working",
      provenance: { actor: "idle-race-test" },
    });

    // Give the idle-close timer a chance to fire WHILE the above call is
    // still in flight (it won't resolve for CALL_DELAY_MS).
    await sleep(IDLE_CLOSE_MS + 100);
    assert.equal(
      mod.getInFlightCallCountForTesting() >= 1,
      true,
      "the call must still be counted in-flight while the idle deadline elapses",
    );
    assert.equal(
      mod.isAvailableSync(),
      true,
      "an idle timer firing while a call is in flight must not close the connection",
    );

    const result = await callPromise;
    assert.notEqual(result, null, "the in-flight call must still succeed");
    assert.equal(
      mod.getBreakerStateForTesting("memory").consecutive_failures,
      0,
      "no breaker failure should be recorded for a call the idle timer correctly left alone",
    );
  });

  it("(B) a new safeCall started while an idle-triggered shutdown() is still awaiting close() succeeds without a breaker failure", async () => {
    // Force a clean disconnect first: a fixture process's close/call delay is
    // fixed at ITS OWN boot time (read once from the control file), so this
    // scenario's slow-close fixture must be a FRESH spawn, not a reused
    // connection left over from scenario (A) (which booted with
    // closeDelayMs: 0).
    await mod.shutdown();
    // Reset for this scenario: fast calls, slow close (so shutdown()'s
    // `await client.close()` stays pending long enough for a new call to
    // land in the window).
    writeFileSync(
      join(eightsHomeDir, "fixture-control.json"),
      JSON.stringify({ closeDelayMs: CLOSE_DELAY_MS, callDelayMs: 0 }),
      "utf8",
    );
    mod.resetBreakersForTesting();

    // Prime a fresh connection and let it settle back to idle so the idle
    // timer arms.
    const envelope = testEnvelope(mod);
    const primer = await mod.memory.add({
      envelope,
      content: "scenario B primer call",
      type: "working",
      provenance: { actor: "idle-race-test" },
    });
    assert.notEqual(primer, null, "the priming call must succeed to arm the idle-close timer");
    assert.equal(mod.getInFlightCallCountForTesting(), 0, "priming call must have fully settled");

    // Wait past the idle deadline. By now `scheduleIdleClose()`'s timer has
    // fired and (pre-fix) `state.kind` would still read `"available"` for
    // the full CLOSE_DELAY_MS while `shutdown()` awaits the slow fixture's
    // close — exactly the window this test's next call must race into.
    await sleep(IDLE_CLOSE_MS + 150);

    const raced = await mod.memory.add({
      envelope,
      content: "scenario B raced call",
      type: "working",
      provenance: { actor: "idle-race-test" },
    });

    assert.notEqual(
      raced,
      null,
      "a safeCall racing an expiring idle close must succeed (directly or via re-probe), never silently fail",
    );
    assert.equal(
      mod.getBreakerStateForTesting("memory").consecutive_failures,
      0,
      "a safeCall racing an expiring idle close must never be handed the closing client and record a breaker failure",
    );
  });

  it("(C) shutdown() installs the 'closing' state BEFORE client.close() is invoked, not merely before it first yields", async () => {
    // Cross-vendor review (2026-10-03): shutdown() used to call the async close
    // helper first and assign { kind: "closing" } afterwards. The helper runs
    // synchronously up to its `await client.close()`, so close() — and any
    // synchronous transport callback it fires — started while state still read
    // 'available'. The test-only hook records state.kind at the instant close()
    // is about to be called; pre-fix it records "available".
    await mod.shutdown();
    writeFileSync(
      join(eightsHomeDir, "fixture-control.json"),
      JSON.stringify({ closeDelayMs: 0, callDelayMs: 0 }),
      "utf8",
    );
    mod.resetBreakersForTesting();
    const primer = await mod.memory.add({
      envelope: testEnvelope(mod),
      content: "scenario C primer call",
      type: "working",
      provenance: { actor: "idle-race-test" },
    });
    assert.notEqual(primer, null, "the priming call must connect so shutdown() has a live client to close");

    const observed = [];
    mod.setBeforeClientCloseHookForTesting((kind) => observed.push(kind));
    try {
      await mod.shutdown();
    } finally {
      mod.setBeforeClientCloseHookForTesting(null);
    }
    assert.deepEqual(
      observed,
      ["closing"],
      "client.close() must be invoked exactly once, with state already 'closing'",
    );
  });

  it("this file never references the real TheEights entrypoint path (grep-verifiable, not just runtime-verifiable)", async () => {
    const { readFileSync } = await import("node:fs");
    const self = readFileSync(fileURLToPath(import.meta.url), "utf8");
    assert.doesNotMatch(
      self,
      /AiAppDeployments\\TheEights\\daemon\\dist\\index\.js/,
      "this race test must only ever talk to fake-eights-daemon.mjs, never the real TheEights entrypoint",
    );
  });
});
