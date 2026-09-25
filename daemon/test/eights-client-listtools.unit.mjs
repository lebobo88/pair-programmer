// Unit test for eights-client.ts's probe() robustness fixes:
//
//   1. `probe()` uses a raw `tools/list` request + a LENIENT result schema
//      instead of `client.listTools()`, so one malformed tool anywhere on
//      the peer's tool surface (a real condition on TheEights — see
//      `fixtures/fake-eights-daemon.mjs` header) does not fail the whole
//      probe / make `isAvailable()` return false.
//   2. `probe()` passes an explicit `env` to `StdioClientTransport` built by
//      `scopedEightsEnv()` — an ALLOWLIST (SDK's `getDefaultEnvironment()`
//      baseline + the `EIGHTS_*` namespace + `AIAPP_BASE`), not a full
//      parent-env copy. This test proves BOTH sides of that allowlist:
//        - an `EIGHTS_*`-prefixed var (not on the SDK's default safelist)
//          DOES reach the spawned child.
//        - a secret-shaped var that is NOT `EIGHTS_*`-prefixed does NOT
//          reach the spawned child — i.e. the allowlist actually excludes
//          things, it isn't a relabeled full-env copy.
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
// resolution at first use). Set one `EIGHTS_*` marker (must be forwarded by
// the allowlist) and one secret-shaped marker that is deliberately NOT
// `EIGHTS_*`-prefixed (must NOT be forwarded).
process.env.PP_EIGHTS_DAEMON = FIXTURE;
process.env.EIGHTS_UNIT_TEST_MARKER = "pp-unit-test-marker-" + Date.now();
process.env.PP_TEST_FAKE_SECRET_TOKEN = "sk-fake-secret-" + Date.now();

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
    added.eights_env_marker,
    process.env.EIGHTS_UNIT_TEST_MARKER,
    "the spawned fixture child must have received EIGHTS_UNIT_TEST_MARKER via the " +
      "EIGHTS_* allowlist in probe()'s StdioClientTransport call — a missing/undefined " +
      "eights_env_marker here means eights-client stopped forwarding EIGHTS_* vars"
  );
  console.log("✓ probe forwards EIGHTS_*-prefixed vars to the spawned peer");
  assert.equal(
    added.secret_env_marker,
    null,
    "the spawned fixture child must NOT have received PP_TEST_FAKE_SECRET_TOKEN — it is " +
      "not EIGHTS_*-prefixed and not in ADDITIONAL_FORWARDED_ENV_VARS, so a non-null " +
      "secret_env_marker here means scopedEightsEnv() regressed back to a full parent-env " +
      "copy (the leak this allowlist exists to prevent)"
  );
  console.log("✓ probe does NOT forward unrelated/secret-shaped vars to the spawned peer");

  await mod.shutdown();
  console.log("✓ eights-client-listtools.unit.mjs: all assertions passed");
}

main().catch((err) => {
  console.error("✗ eights-client-listtools.unit.mjs failed:", err);
  process.exit(1);
});
