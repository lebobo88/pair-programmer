// Unit tests for the Phase-A ecosystem spine:
//   - hydra-context.ts (pure data, no I/O)
//   - eights-client.ts graceful-degradation contract (no peer → all wrappers
//     return null without throwing; isAvailable() resolves to false)
//
// Runs against the compiled dist/. Invoked by `npm test`.

import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import assert from "node:assert/strict";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DIST = join(__dirname, "..", "dist");
const importDist = (relPath) => import(pathToFileURL(join(DIST, relPath)).href);

// Point the eights-client at a path we know does not exist BEFORE importing.
// The module captures the resolution at first-use, so setting this env var
// in the parent process before dynamic import is sufficient.
process.env.PP_EIGHTS_DAEMON = join(__dirname, "this-file-does-not-exist.js");

async function testHydraContext() {
  const mod = await importDist("ecosystem/hydra-context.js");

  // 1. Standalone input → null.
  assert.equal(mod.parseHydraContext(undefined), null, "undefined input → null");
  assert.equal(mod.parseHydraContext({}), null, "empty object → null");
  assert.equal(
    mod.parseHydraContext({ hydra_envelope_id: "x" }),
    null,
    "no workflow_id → null (workflow_id is load-bearing)"
  );

  // 2. Happy path with all fields.
  const full = mod.parseHydraContext({
    hydra_workflow_id: "wf_001",
    hydra_envelope_id: "env_001",
    hydra_origin_squad: "executive",
    hydra_envelope_type: "PRD",
  });
  assert.ok(full, "full context parses");
  assert.equal(full.workflow_id, "wf_001");
  assert.equal(full.envelope_id, "env_001");
  assert.equal(full.origin_squad, "executive");
  assert.equal(full.envelope_type, "PRD");

  // 3. Unknown envelope_type is dropped to null (no schema poisoning).
  const unknown = mod.parseHydraContext({
    hydra_workflow_id: "wf_002",
    hydra_envelope_type: "MadeUpType",
  });
  assert.equal(unknown.envelope_type, null, "unknown envelope_type → null");
  assert.equal(unknown.workflow_id, "wf_002");

  // 4. Render block is empty for standalone, non-empty when a context exists.
  assert.equal(mod.renderHydraContextBlock(null), "", "null context → empty block");
  const block = mod.renderHydraContextBlock(full);
  assert.ok(block.includes("workflow_id:"), "block mentions workflow_id");
  assert.ok(block.includes("wf_001"), "block carries the workflow_id value");
  assert.ok(block.includes("Hydra context"), "block has the heading");

  // 5. Summary stringifier is stable and grep-friendly.
  assert.equal(mod.hydraContextSummary(null), "standalone");
  assert.match(mod.hydraContextSummary(full), /^wf=wf_001;squad=executive;type=PRD$/);

  console.log("✓ hydra-context.ts: parse + render + summary all behave");
}

async function testEightsClientDegradedMode() {
  const mod = await importDist("ecosystem/eights-client.js");

  // Before any call: isAvailableSync is false (no probe has run).
  assert.equal(mod.isAvailableSync(), false, "isAvailableSync starts false");

  // Async probe with the bogus binary path → unavailable, no throw.
  const ok = await mod.isAvailable();
  assert.equal(ok, false, "isAvailable() returns false when peer absent");
  assert.equal(mod.isAvailableSync(), false, "sync stays false after failed probe");

  // Every wrapper returns null and DOES NOT throw.
  const envelope = mod.envelopeFor({
    run_id: "run_test_001",
    project_path: "C:\\tmp\\fake-project",
  });
  assert.equal(envelope.tenant_id, "local");
  assert.equal(envelope.domain, "code");
  assert.equal(envelope.trace_id, "run_test_001");
  assert.equal(envelope.project_id, "fake-project", "project_id is basename");

  assert.equal(
    await mod.memory.add({
      envelope,
      content: "test",
      type: "episode",
      provenance: { actor: "pp-daemon" },
    }),
    null,
    "memory.add → null"
  );
  assert.equal(await mod.memory.search({ envelope, query: "hello" }), null, "memory.search → null");
  assert.equal(await mod.audit.bom("run_test_001"), null, "audit.bom → null");
  assert.equal(await mod.constitution.get("fake-project"), null, "constitution.get → null");
  assert.equal(await mod.cells.classify("some content"), null, "cells.classify → null");
  assert.equal(
    await mod.hydra.envelopeRecord({
      envelope_id: "e1",
      workflow_id: "wf",
      type: "DECISION_RECORD",
      origin_squad: "engineering",
      payload: {},
    }),
    null,
    "hydra.envelopeRecord → null"
  );

  await mod.shutdown();
  console.log("✓ eights-client.ts: graceful degradation — no peer, no throws, all calls null");
}

async function main() {
  await testHydraContext();
  await testEightsClientDegradedMode();
  console.log("✓ ecosystem.unit.mjs: all assertions passed");
}

main().catch(err => {
  console.error("✗ ecosystem.unit.mjs failed:", err);
  process.exit(1);
});
