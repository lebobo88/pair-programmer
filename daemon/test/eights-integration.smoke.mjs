// Live integration smoke test for pp's eights-client against the REAL
// TheEights daemon over stdio.
//
// This is the test that would have caught the argument-shape drift between
// pp's call sites and TheEights' zod schemas (the drift survived because the
// Phase-A spine had ZERO integration coverage — every degraded-mode test runs
// with no peer, so a wrong arg shape returns null indistinguishably from
// "daemon offline").
//
// It spawns C:\AiAppDeployments\TheEights\daemon\dist\index.js with arg "mcp"
// through pp's compiled eights-client (PP_EIGHTS_DAEMON points at the dist),
// and asserts the wire contract:
//   1. probe connects (isAvailable() === true) and lists eights.memory.* tools.
//   2. memory.add round-trips WITHOUT isError (returns a memory id).
//   3. hydra.envelope.record of a DECISION_RECORD returns recorded/ok.
//   4. hydra.envelope.query(workflow_id) finds the just-recorded envelope.
//   5. audit.trace accepts its (read) args and returns an array.
//   6. constitution.attest accepts its args, OR returns a DOMAIN error
//      (e.g. "consumer not registered") — never a zod VALIDATION error.
//
// CI portability: if the TheEights dist is absent, the whole suite SKIPS
// cleanly (exit 0). A null from any wrapper while the peer IS reachable is a
// HARD FAILURE — that is exactly the drift signal we are guarding against.

import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { existsSync, mkdtempSync } from "node:fs";
import assert from "node:assert/strict";
import { getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";
import { shutdownAndCleanup } from "./fixtures/eights-cleanup.mjs";

// TheEights' own `index.ts main()` constructs `AuditEngine` (which eagerly
// `db.prepare()`s statements against the `events` table) BEFORE calling
// `sql.migrate()` (that call lives inside `bootstrapAuditedRuntime`, invoked
// later in boot) — so spawning the real daemon against a genuinely empty
// EIGHTS_HOME crashes on boot with `SqliteError: no such table: events`
// before the MCP transport ever comes up. This is a TheEights-side boot
// ordering bug (confirmed by reproduction and by TheEights' own
// `audit-checkpoint.test.ts`, which pre-migrates for the identical reason);
// we don't patch TheEights source here, so the temp EIGHTS_HOME's
// `state.db` is pre-migrated the same way TheEights' own tests do, via
// TheEights' own `SqliteStore.migrate()` (read-only use of its migration
// logic, no schema knowledge duplicated on the pp side).
async function preMigrateEightsHome(eightsDist, eightsHome) {
  const sqliteStorePath = join(dirname(eightsDist), "stores", "sqlite.js");
  const { SqliteStore } = await import(pathToFileURL(sqliteStorePath).href);
  const store = new SqliteStore(join(eightsHome, "state.db"));
  store.migrate();
  store.db.close();
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const DIST = join(__dirname, "..", "dist");
const importDist = (relPath) => import(pathToFileURL(join(DIST, relPath)).href);

// Resolve the TheEights daemon dist the same way the client's well-known
// sibling fallback does, but make it explicit so the test is hermetic.
const EIGHTS_DIST =
  process.env.PP_EIGHTS_DAEMON ||
  "C:\\AiAppDeployments\\TheEights\\daemon\\dist\\index.js";

async function main() {
  // OPT-IN live-daemon gate: this test spawns a REAL TheEights daemon
  // subprocess and fails the whole `npm test` `&&` chain when that peer is
  // unavailable. Default `npm test` must stay green without a live daemon
  // on the box, so this test only runs when the operator explicitly asks
  // for it via PP_LIVE_EIGHTS=1 (see AGENTS.md live-daemon test contract).
  if (process.env.PP_LIVE_EIGHTS !== "1") {
    console.log(
      "↷ eights-integration.smoke.mjs SKIPPED — set PP_LIVE_EIGHTS=1 to run against a live TheEights daemon"
    );
    return;
  }

  if (!existsSync(EIGHTS_DIST)) {
    console.log(
      `↷ eights-integration.smoke.mjs SKIPPED — TheEights dist not found at ${EIGHTS_DIST}`
    );
    return; // CI portability: skip cleanly when the peer isn't built.
  }

  // Point the client at the real daemon BEFORE importing it (the module
  // captures the resolution at first use).
  process.env.PP_EIGHTS_DAEMON = EIGHTS_DIST;

  // HERMETIC: the spawned TheEights daemon subprocess receives pp's
  // `scopedEightsEnv()` allowlist (see src/ecosystem/eights-client.ts),
  // which forwards every `EIGHTS_*`-prefixed var plus `AIAPP_BASE` — NOT the
  // full parent env. `EIGHTS_HOME` is `EIGHTS_*`-prefixed, so it IS
  // forwarded (this is the fix for root cause #1: previously `probe()`
  // passed no explicit `env` at all, so the MCP SDK's built-in Windows
  // safelist silently dropped `EIGHTS_HOME` and the spawned daemon fell back
  // to the operator's real ~/.eights regardless of this setting). Setting
  // `EIGHTS_HOME` here BEFORE the probe spawns it redirects TheEights' own
  // state.db (TheEights daemon/src/config.ts:
  // `join(process.env.EIGHTS_HOME ?? homedir(), "state.db")`-style override)
  // into a throwaway temp dir instead of the operator's real ~/.eights.
  const eightsHome = mkdtempSync(join(tmpdir(), "pp-itest-eights-home-"));
  process.env.EIGHTS_HOME = eightsHome;

  // Everything from here on must guarantee the spawned daemon is closed and
  // the temp EIGHTS_HOME is removed on EVERY path (success, an assertion
  // throw, or the readiness-poll timeout) — not just the success path at the
  // bottom of the old linear script, which leaked the temp dir on any
  // mid-test failure.
  let mod;
  try {
    // Pre-migrate the temp home's schema before the probe spawns the daemon —
    // see `preMigrateEightsHome` above (root cause #2).
    await preMigrateEightsHome(EIGHTS_DIST, eightsHome);

    mod = await importDist("ecosystem/eights-client.js");

    // ── 1. Probe connects ────────────────────────────────────────────────
    const ok = await mod.isAvailable();
    assert.equal(ok, true, "isAvailable() must be true against the real daemon");
    assert.equal(mod.isAvailableSync(), true, "isAvailableSync() true after connect");
    console.log("✓ probe connected to real TheEights daemon");

    // Escape hatch for the forced-failure cleanup demonstration (see the
    // engineer's changelog note below main()): PP_ITEST_FORCE_FAIL_AFTER_SPAWN=1
    // throws immediately after the FIRST isAvailable() call — i.e. AFTER the
    // daemon subprocess has actually spawned and connected, not before — so
    // the finally block's cleanup path is exercised against a real live
    // child (temp EIGHTS_HOME removal + child-process termination), not a
    // no-op. (Injecting the failure before isAvailable() — the prior
    // position — never spawns a child at all, which this test also
    // demonstrates below for contrast.)
    if (process.env.PP_ITEST_FORCE_FAIL_AFTER_SPAWN === "1") {
      const pid = mod.getConnectedDaemonPidForTesting();
      console.log(`↷ PP_ITEST_FORCE_FAIL_AFTER_SPAWN injected after spawn (pid=${pid})`);
      throw new Error("PP_ITEST_FORCE_FAIL_AFTER_SPAWN injected failure");
    }

    // TheEights' fail-closed readiness gate (mcp/health.ts, index.ts) re-arms
    // on every fresh stdio spawn: the transport comes up before the audit hash
    // chain finishes verifying, and every gated tool (memory.add included)
    // refuses with `{status:"not_ready", retry_after_ms}` until it opens —
    // root cause #3 (`eights.health` itself is the one ungated probe for this
    // state, by design). Poll it here rather than weakening the memory.add
    // assertion below.
    await waitForAuditReady(EIGHTS_DIST, 15_000);
    console.log("✓ audit readiness gate open");

    const workflow_id = `wf_pp_itest_${Date.now()}`;
    const run_id = `run_pp_itest_${Date.now()}`;
    const env = mod.envelopeFor({
      run_id,
      project_path: "C:\\AiAppDeployments\\pair-programmer",
    });

    // ── 2. memory.add round-trips ────────────────────────────────────────
    const added = await mod.memory.add({
      envelope: env,
      content: "pp integration smoke: a semantic memory written by the fixed client",
      type: "semantic",
      summary: "pp itest memory",
      scopes: ["pp:kind:itest"],
      provenance: { run_id, actor: "pp-itest" },
      cell: "context",
      handle: `pp:itest:${run_id}`,
    });
    assert.ok(
      added && typeof added.id === "string" && added.id.length > 0,
      `memory.add must return a memory id (got ${JSON.stringify(added)}) — ` +
        `null here means the arg shape failed AddArgs zod validation`
    );
    console.log(`✓ memory.add round-tripped: id=${added.id}`);

    // ── 3. hydra.envelope.record (DECISION_RECORD) ──────────────────────
    const envelope_id = `env_pp_itest_dr_${Date.now()}`;
    const recorded = await mod.hydra.envelopeRecord({
      envelope_id,
      workflow_id,
      type: "DECISION_RECORD",
      origin_squad: "engineering",
      target_squad: "executive",
      payload: {
        decision: "pp itest decision",
        rationale: "verifying envelope.record arg shape end-to-end",
        artifacts: [{ tier: "episodic", key: `pp:itest:${run_id}` }],
        status: "complete",
        run_id,
      },
    });
    assert.ok(
      recorded !== null,
      "hydra.envelope.record returned null — RecordArgs (envelope + hydra_envelope) " +
        "rejected by zod. This is the original report_hydra_completion recorded:false bug."
    );
    // The engine returns its own ack shape; accept recorded:true | ok:true | an id.
    const recordedOk =
      recorded.recorded === true ||
      recorded.ok === true ||
      typeof recorded.id === "string";
    assert.ok(
      recordedOk,
      `hydra.envelope.record must ack success, got ${JSON.stringify(recorded)}`
    );
    console.log(`✓ hydra.envelope.record acked: ${JSON.stringify(recorded)}`);

    // ── 4. hydra.envelope.query finds it ─────────────────────────────────
    const queried = await mod.hydra.envelopeQuery(workflow_id, { limit: 50 });
    assert.ok(
      Array.isArray(queried),
      `hydra.envelope.query must return an array (got ${JSON.stringify(queried)}) — ` +
        `null means QueryArgs failed validation`
    );
    const found = queried.find(
      (e) => e && (e.id === envelope_id || e.envelope_id === envelope_id)
    );
    assert.ok(
      found,
      `hydra.envelope.query(${workflow_id}) must find the just-recorded ` +
        `envelope ${envelope_id}. Got ${queried.length} envelopes: ` +
        JSON.stringify(queried.map((e) => e && (e.id ?? e.envelope_id)))
    );
    assert.equal(
      found.type,
      "DECISION_RECORD",
      "round-tripped envelope must preserve type=DECISION_RECORD"
    );
    console.log(`✓ hydra.envelope.query found the envelope (type=${found.type})`);

    // ── 5. audit.trace accepts its (read) args ───────────────────────────
    const traced = await mod.audit.trace({ run_id, limit: 10 });
    assert.ok(
      Array.isArray(traced),
      `audit.trace must return an array of events (got ${JSON.stringify(traced)}) — ` +
        `null means TraceArgs validation failed`
    );
    console.log(`✓ audit.trace accepted args, returned ${traced.length} events`);

    // ── 6. constitution.attest: success OR domain (not zod) refusal ──────
    // attest needs a registered consumer; if "pp" isn't registered the daemon
    // returns a DOMAIN error (engine.attest throws "resource missing"), which
    // our safeCall maps to null. We distinguish: a zod VALIDATION failure would
    // also be null, so we additionally probe the raw client to inspect the error
    // text and assert it is NOT a zod issue.
    const attested = await mod.constitution.attest({ envelope: env, consumer: "pp" });
    if (attested === null) {
      // Inspect the raw refusal to confirm it is a domain error, not zod.
      const rawErr = await rawCallError(mod, "constitution.attest", {
        envelope: env,
        consumer: "pp",
      });
      const txt = (rawErr || "").toLowerCase();
      const looksLikeZod =
        txt.includes("invalid_type") ||
        (txt.includes("required") && txt.includes("expected")) ||
        txt.includes("zoderror") ||
        txt.includes("invalid input");
      assert.ok(
        !looksLikeZod,
        `constitution.attest refusal must be a DOMAIN error, not zod validation. Got: ${rawErr}`
      );
      console.log(
        `✓ constitution.attest refused with a DOMAIN error (not zod): ${truncate(rawErr, 160)}`
      );
    } else {
      assert.ok(
        typeof attested === "object",
        `constitution.attest returned a non-object: ${JSON.stringify(attested)}`
      );
      console.log(`✓ constitution.attest succeeded: ${JSON.stringify(attested)}`);
    }

    console.log("✓ eights-integration.smoke.mjs: all live assertions passed");
  } finally {
    // Cleanup runs on EVERY path — success, an assertion throw above, or the
    // forced-failure injection. `shutdownAndCleanup` (fixtures/eights-cleanup.mjs)
    // guarantees the temp EIGHTS_HOME removal step ALWAYS runs even when
    // mod.shutdown() throws (a prior version threw straight out of the
    // shutdown catch block, which skipped removal entirely on that path —
    // the exact leak the isolation requirement forbids), and rethrows
    // whichever step(s) failed rather than swallowing them.
    const spawnedPid = mod ? mod.getConnectedDaemonPidForTesting() : null;
    await shutdownAndCleanup(mod, eightsHome);
    console.log(`✓ temp EIGHTS_HOME removed: ${eightsHome}`);
    if (spawnedPid !== null) {
      await assertPidGone(spawnedPid, 5_000);
      console.log(`✓ spawned daemon pid ${spawnedPid} is gone`);
    }
  }
}

/**
 * Assert a PID is no longer alive, distinguishing ESRCH (process gone — the
 * only condition that actually proves it) from EPERM (process exists but
 * this user can't signal it — NOT proof of death) per the Windows-liveness
 * guidance in this run's operating contract. `process.kill(pid, 0)` sends no
 * signal, just probes existence; retries briefly because Windows can take a
 * moment to fully reap a child after transport.close()'s SIGTERM/2s-timeout
 * path.
 */
async function assertPidGone(pid, maxWaitMs) {
  const deadline = Date.now() + maxWaitMs;
  for (;;) {
    try {
      process.kill(pid, 0);
      // No throw means the PID is still alive (or, ambiguously, EPERM would
      // have thrown a *different* code below) — keep polling until timeout.
    } catch (e) {
      if (e && e.code === "ESRCH") return; // proven gone
      if (e && e.code === "EPERM") {
        throw new Error(
          `pid ${pid} exists but is not signalable (EPERM) — this does NOT prove it exited; ` +
            `treating as still-alive for isolation purposes`
        );
      }
      throw e;
    }
    if (Date.now() >= deadline) {
      throw new Error(`pid ${pid} still alive ${maxWaitMs}ms after cleanup`);
    }
    await new Promise((r) => setTimeout(r, 200));
  }
}

/**
 * Env for any raw (non-eights-client) subprocess this test spawns directly
 * (the health-poll and raw-error-capture helpers below, which open their own
 * `StdioClientTransport` rather than going through eights-client.ts's
 * `scopedEightsEnv()`). Forwards only `EIGHTS_HOME` — the one var these
 * helpers actually need (this test's temp-home override, set in main()
 * before the probe) — HERMETIC: without an explicit `env` at all, a raw
 * `StdioClientTransport` spawn defaults to the MCP SDK's Windows safelist,
 * which drops `EIGHTS_HOME`, and the raw subprocess would silently open the
 * operator's real ~/.eights/state.db. This mirrors src/ecosystem/
 * eights-client.ts's `scopedEightsEnv()` allowlist approach rather than
 * forwarding the full parent env.
 */
function childEnv() {
  const env = { ...getDefaultEnvironment() };
  if (process.env.EIGHTS_HOME !== undefined) env.EIGHTS_HOME = process.env.EIGHTS_HOME;
  return env;
}

/**
 * Poll `eights.health` (the one tool exempt from TheEights' fail-closed
 * audit-readiness gate, mcp/health.ts) via a short-lived raw client until
 * `ready:true`, `failed:true`, or `maxWaitMs` elapses. Throws on timeout or
 * `failed:true` so a genuinely broken chain surfaces as a hard failure
 * rather than a silent null downstream.
 */
async function waitForAuditReady(eightsDist, maxWaitMs) {
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { StdioClientTransport } = await import(
    "@modelcontextprotocol/sdk/client/stdio.js"
  );
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [eightsDist, "mcp"],
    env: childEnv(),
  });
  const client = new Client(
    { name: "pp-itest-health-poll", version: "0.1.0" },
    { capabilities: {} }
  );
  await client.connect(transport);
  const deadline = Date.now() + maxWaitMs;
  try {
    for (;;) {
      const res = await client.callTool({ name: "eights.health", arguments: {} });
      const text = res.content?.[0]?.text;
      const health = text ? JSON.parse(text) : {};
      if (health.ready === true) return;
      if (health.failed === true) {
        throw new Error(`TheEights audit gate reports failed: ${JSON.stringify(health)}`);
      }
      if (Date.now() >= deadline) {
        throw new Error(
          `TheEights audit readiness gate did not open within ${maxWaitMs}ms: ${JSON.stringify(health)}`
        );
      }
      await new Promise((r) => setTimeout(r, Math.min(health.retry_after_ms ?? 500, 1000)));
    }
  } finally {
    try { await client.close(); } catch { /* ignore */ }
  }
}

/**
 * Open a short-lived raw MCP client to capture the exact error text of a tool
 * call (the public wrapper swallows it to null). Used only to classify an
 * attest refusal as domain-vs-zod. Returns the error text or "".
 */
async function rawCallError(mod, bareTool, args) {
  try {
    const { Client } = await import(
      "@modelcontextprotocol/sdk/client/index.js"
    );
    const { StdioClientTransport } = await import(
      "@modelcontextprotocol/sdk/client/stdio.js"
    );
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [EIGHTS_DIST, "mcp"],
      env: childEnv(),
    });
    const client = new Client(
      { name: "pp-itest-raw", version: "0.1.0" },
      { capabilities: {} }
    );
    await client.connect(transport);
    let errText = "";
    try {
      const res = await client.callTool({
        name: `eights.${bareTool}`,
        arguments: args,
      });
      if (res.isError) {
        const blocks = (res.content ?? []);
        errText = blocks.map((b) => b?.text ?? "").join(" ");
      }
    } catch (e) {
      errText = e?.message ?? String(e);
    }
    try { await client.close(); } catch { /* ignore */ }
    return errText;
  } catch (e) {
    return e?.message ?? String(e);
  }
}

function truncate(s, n) {
  s = String(s ?? "");
  return s.length > n ? s.slice(0, n) + "…" : s;
}

main().catch((err) => {
  console.error("✗ eights-integration.smoke.mjs failed:", err);
  process.exit(1);
});
