// Unit test for eights-client.ts's probe() robustness fixes:
//
//   1. `probe()` uses a raw `tools/list` request + a LENIENT result schema
//      instead of `client.listTools()`, so one malformed tool anywhere on
//      the peer's tool surface (a real condition on TheEights — see
//      `fixtures/fake-eights-daemon.mjs` header) does not fail the whole
//      probe / make `isAvailable()` return false.
//   2. `probe()` passes an explicit `env` to `StdioClientTransport` built by
//      `scopedEightsEnv()` — an exact-name ALLOWLIST (SDK's
//      `getDefaultEnvironment()` baseline + the frozen `EIGHTS_FORWARDED_ENV_VARS`
//      list + `AIAPP_BASE`), not a prefix match and not a full parent-env
//      copy. This test proves BOTH sides of that allowlist:
//        - `EIGHTS_HOME` (on the frozen list, not on the SDK's default
//          safelist) DOES reach the spawned child, with the parent's value.
//        - `EIGHTS_API_KEY` (`EIGHTS_*`-prefixed but NOT on the frozen list)
//          does NOT reach the spawned child — i.e. the allowlist is an exact
//          list, not a prefix match, and it actually excludes things.
//        - `HYDRA_OPERATOR_KEY` (a real secret TheEights itself reads to mint
//          capability tokens, auth/capability.ts:150 — explicitly excluded,
//          see eights-client.ts's doc comment) does NOT reach the spawned
//          child either, even though TheEights genuinely consumes it.
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
// resolution at first use). `PP_EIGHTS_DAEMON` is the explicit, top-priority
// override in `resolveDaemonEntry()`, so setting `EIGHTS_HOME` here does NOT
// affect which daemon is spawned — it's purely a forwarding-allowlist probe.
//   - `EIGHTS_HOME` is on the frozen `EIGHTS_FORWARDED_ENV_VARS` list: must
//     reach the spawned child, with this exact parent value.
//   - `EIGHTS_API_KEY` is `EIGHTS_*`-prefixed but NOT on the list: must NOT
//     reach the spawned child.
//   - `HYDRA_OPERATOR_KEY` is a real secret TheEights itself reads
//     (capability-token signing key) but is explicitly excluded from the
//     allowlist: must NOT reach the spawned child.
//
// `scripts/run-tests.mjs` sets PP_ECOSYSTEM_DISABLED=1 around the batched
// unit-file run so a fire-and-forget eights-writes.ts call from an unrelated
// test can never reach/spawn a real TheEights (see eights-client.ts's
// probe() guard comment). THIS file is the one exception that legitimately
// needs probe() to run -- against the fixture above, never a real daemon --
// so it explicitly clears the flag before importing dist/.
delete process.env.PP_ECOSYSTEM_DISABLED;
process.env.PP_EIGHTS_DAEMON = FIXTURE;
process.env.EIGHTS_HOME = "C:\\tmp\\pp-unit-test-eights-home-" + Date.now();
process.env.EIGHTS_API_KEY = "sk-fake-secret-" + Date.now();
process.env.HYDRA_OPERATOR_KEY = "hok-fake-signing-key-" + Date.now();

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
    added.eights_home_marker,
    process.env.EIGHTS_HOME,
    "the spawned fixture child must have received EIGHTS_HOME (with the parent's exact " +
      "value) via the EIGHTS_FORWARDED_ENV_VARS allowlist in probe()'s StdioClientTransport " +
      "call — a missing/mismatched eights_home_marker here means eights-client stopped " +
      "forwarding a listed EIGHTS_* var"
  );
  console.log("✓ probe forwards a listed EIGHTS_* var (EIGHTS_HOME) to the spawned peer, unchanged");
  assert.equal(
    added.eights_api_key_marker,
    null,
    "the spawned fixture child must NOT have received EIGHTS_API_KEY — it is EIGHTS_*-" +
      "prefixed but not on EIGHTS_FORWARDED_ENV_VARS, so a non-null eights_api_key_marker " +
      "here means scopedEightsEnv() regressed to prefix matching (or a full parent-env copy)"
  );
  console.log("✓ probe does NOT forward an EIGHTS_*-prefixed var absent from the frozen allowlist");
  assert.equal(
    added.hydra_operator_key_marker,
    null,
    "the spawned fixture child must NOT have received HYDRA_OPERATOR_KEY — TheEights itself " +
      "reads it (auth/capability.ts:150) but it is a capability-token signing secret, " +
      "explicitly excluded from EIGHTS_FORWARDED_ENV_VARS; a non-null marker here means that " +
      "exclusion regressed"
  );
  console.log("✓ probe does NOT forward HYDRA_OPERATOR_KEY (explicitly excluded secret)");

  await mod.shutdown();
  console.log("✓ eights-client-listtools.unit.mjs: all assertions passed");
}

main().catch((err) => {
  console.error("✗ eights-client-listtools.unit.mjs failed:", err);
  process.exit(1);
});
