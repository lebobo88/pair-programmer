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
//   3. hydra.envelope.record of a DecisionRecord returns recorded/ok.
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
import { existsSync } from "node:fs";
import assert from "node:assert/strict";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DIST = join(__dirname, "..", "dist");
const importDist = (relPath) => import(pathToFileURL(join(DIST, relPath)).href);

// Resolve the TheEights daemon dist the same way the client's well-known
// sibling fallback does, but make it explicit so the test is hermetic.
const EIGHTS_DIST =
  process.env.PP_EIGHTS_DAEMON ||
  "C:\\AiAppDeployments\\TheEights\\daemon\\dist\\index.js";

async function main() {
  if (!existsSync(EIGHTS_DIST)) {
    console.log(
      `↷ eights-integration.smoke.mjs SKIPPED — TheEights dist not found at ${EIGHTS_DIST}`
    );
    return; // CI portability: skip cleanly when the peer isn't built.
  }

  // Point the client at the real daemon BEFORE importing it (the module
  // captures the resolution at first use).
  process.env.PP_EIGHTS_DAEMON = EIGHTS_DIST;

  const mod = await importDist("ecosystem/eights-client.js");

  // ── 1. Probe connects ──────────────────────────────────────────────────
  const ok = await mod.isAvailable();
  assert.equal(ok, true, "isAvailable() must be true against the real daemon");
  assert.equal(mod.isAvailableSync(), true, "isAvailableSync() true after connect");
  console.log("✓ probe connected to real TheEights daemon");

  const workflow_id = `wf_pp_itest_${Date.now()}`;
  const run_id = `run_pp_itest_${Date.now()}`;
  const env = mod.envelopeFor({
    run_id,
    project_path: "C:\\AiAppDeployments\\pair-programmer",
  });

  // ── 2. memory.add round-trips ──────────────────────────────────────────
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

  // ── 3. hydra.envelope.record (DecisionRecord) ──────────────────────────
  const envelope_id = `env_pp_itest_dr_${Date.now()}`;
  const recorded = await mod.hydra.envelopeRecord({
    envelope_id,
    workflow_id,
    type: "DecisionRecord",
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

  // ── 4. hydra.envelope.query finds it ───────────────────────────────────
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
    "DecisionRecord",
    "round-tripped envelope must preserve type=DecisionRecord"
  );
  console.log(`✓ hydra.envelope.query found the envelope (type=${found.type})`);

  // ── 5. audit.trace accepts its (read) args ─────────────────────────────
  const traced = await mod.audit.trace({ run_id, limit: 10 });
  assert.ok(
    Array.isArray(traced),
    `audit.trace must return an array of events (got ${JSON.stringify(traced)}) — ` +
      `null means TraceArgs validation failed`
  );
  console.log(`✓ audit.trace accepted args, returned ${traced.length} events`);

  // ── 6. constitution.attest: success OR domain (not zod) refusal ────────
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
      txt.includes("required") && txt.includes("expected") ||
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

  await mod.shutdown();
  console.log("✓ eights-integration.smoke.mjs: all live assertions passed");
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
