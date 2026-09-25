// Unit test for eights-client.ts's probe() robustness fixes:
//
//   1. `probe()` uses a raw `tools/list` request + a LENIENT result schema
//      instead of `client.listTools()`, so one malformed tool anywhere on
//      the peer's tool surface (a real condition on TheEights — see
//      `fixtures/fake-eights-daemon.mjs` header) does not fail the whole
//      probe / make `isAvailable()` return false.
//   2. `probe()` passes an explicit `env` (the full parent env) to
//      `StdioClientTransport`, so a var like `PP_UNIT_TEST_ENV_MARKER` (not
//      on the MCP SDK's default inherited-env safelist) reaches the spawned
//      child.
//
// Self-contained: spawns its own fake MCP stdio server (fixtures/
// fake-eights-daemon.mjs), no live TheEights daemon, no network.

import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import assert from "node:assert/strict";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DIST = join(__dirname, "..", "dist");
const importDist = (relPath) => import(pathToFileURL(join(DIST, relPath)).href);

const FIXTURE = join(__dirname, "fixtures", "fake-eights-daemon.mjs");

// Point eights-client at the fixture BEFORE importing it (module captures
// resolution at first use) and set an env marker the SDK's default
// inherited-env safelist would drop unless eights-client explicitly forwards
// the parent env.
process.env.PP_EIGHTS_DAEMON = FIXTURE;
process.env.PP_UNIT_TEST_ENV_MARKER = "pp-unit-test-marker-" + Date.now();

// Test-only extension of the probe timeout (config.ts `ecosystemProbeTimeoutMs()`,
// default 3000ms in production). `node --test` runs every `*.unit.mjs` file
// concurrently, and several of them spawn their own `pp-daemon`/`eights-daemon`
// subprocesses too — under that concurrent process-spawn load a trivial fixture
// child's own connect handshake can occasionally exceed 3s even though it does
// almost no work. This does NOT touch the production default; it only widens
// THIS test's own probe window via the documented env var.
process.env.PP_ECOSYSTEM_PROBE_TIMEOUT_MS = "20000";

async function main() {
  const mod = await importDist("ecosystem/eights-client.js");

  // ── The fix under test: probe survives a malformed sibling tool ────────
  const ok = await mod.isAvailable();
  assert.equal(
    ok,
    true,
    "isAvailable() must be true even though the fixture's eights.evolution.register " +
      "tool has a malformed inputSchema (no `type` field) — a strict client.listTools() " +
      "call would throw here and this would be false"
  );
  assert.equal(mod.isAvailableSync(), true, "isAvailableSync() true after successful probe");
  console.log("✓ probe tolerates a malformed sibling tool's inputSchema");

  // ── The fix under test: env forwarding ──────────────────────────────────
  const envelope = mod.envelopeFor({
    run_id: "run_unit_listtools",
    project_path: "C:\\tmp\\fake-project",
  });
  const added = await mod.memory.add({
    envelope,
    content: "unit test content",
    type: "semantic",
    provenance: { actor: "pp-unit-test" },
  });
  assert.ok(added, "memory.add must succeed against the fixture daemon");
  assert.equal(
    added.env_marker,
    process.env.PP_UNIT_TEST_ENV_MARKER,
    "the spawned fixture child must have received PP_UNIT_TEST_ENV_MARKER via explicit " +
      "env forwarding in probe()'s StdioClientTransport call — a missing/undefined " +
      "env_marker here means eights-client stopped passing env"
  );
  console.log("✓ probe forwards the parent env to the spawned peer");

  await mod.shutdown();
  console.log("✓ eights-client-listtools.unit.mjs: all assertions passed");
}

main().catch((err) => {
  console.error("✗ eights-client-listtools.unit.mjs failed:", err);
  process.exit(1);
});
