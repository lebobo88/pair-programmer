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
      type: "episodic",
      provenance: { actor: "pp-daemon" },
    }),
    null,
    "memory.add → null"
  );
  assert.equal(await mod.memory.search({ envelope, query: "hello" }), null, "memory.search → null");
  assert.equal(await mod.audit.bom(envelope, "run_test_001"), null, "audit.bom → null");
  assert.equal(await mod.constitution.get(envelope, "pp"), null, "constitution.get → null");
  assert.equal(
    await mod.cells.classify({ envelope, text: "some content" }),
    null,
    "cells.classify → null"
  );
  assert.equal(
    await mod.hydra.envelopeRecord({
      envelope_id: "e1",
      workflow_id: "wf",
      type: "DecisionRecord",
      origin_squad: "engineering",
      payload: {},
    }),
    null,
    "hydra.envelopeRecord → null"
  );

  await mod.shutdown();
  console.log("✓ eights-client.ts: graceful degradation — no peer, no throws, all calls null");
}

async function testWritePathDegradedMode() {
  // With no eights peer, every write-path wrapper must resolve to undefined
  // (or return value irrelevant) WITHOUT throwing, and back-write paths
  // must silently no-op rather than corrupting pp's DB.
  const mod = await importDist("ecosystem/eights-writes.js");

  // writeRunStartEpisode — no DB exists in this test context, but the
  // wrapper's outer try/catch should swallow the resulting error.
  await mod.writeRunStartEpisode({
    run_id: "run_test_b1",
    project_path: "C:\\tmp\\fake-b1",
    request_text: "test request",
    mode: "single",
    team: null,
    forum: null,
    hydra_workflow_id: null,
    hydra_origin_squad: null,
  });

  // listPriorCritiques — must return [] when peer absent, never throw.
  const prior = await mod.listPriorCritiques({
    stage_kind: "code",
    project_path: "C:\\tmp\\fake-b1",
    k: 3,
  });
  assert.deepEqual(prior, [], "listPriorCritiques returns [] when peer absent");

  // recallProjectContext — must return null when peer absent.
  const ctx = await mod.recallProjectContext("C:\\tmp\\fake-b1", 10);
  assert.equal(ctx, null, "recallProjectContext returns null when peer absent");

  // recallByQuery — must return null when peer absent.
  const byQuery = await mod.recallByQuery("C:\\tmp\\fake-b1", "find a bug", 5);
  assert.equal(byQuery, null, "recallByQuery returns null when peer absent");

  console.log("✓ eights-writes.ts: write & recall paths degrade gracefully");
}

async function testConstitution() {
  const mod = await importDist("orchestrator/constitution.js");
  const { mkdtempSync, readFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");

  const proj = mkdtempSync(join(tmpdir(), "pp-constitution-"));

  // 1. ensureConstitution scaffolds when absent.
  const first = mod.ensureConstitution(proj);
  assert.equal(first.created, true, "first ensure scaffolds");
  assert.ok(first.sha, "first ensure returns sha");
  assert.ok(readFileSync(first.path, "utf8").includes("Constitution"));

  // 2. ensureConstitution is idempotent.
  const second = mod.ensureConstitution(proj);
  assert.equal(second.created, false, "second ensure is no-op");
  assert.equal(second.sha, first.sha, "sha unchanged on idempotent ensure");

  // 3. constitutionSha agrees with ensure.
  assert.equal(mod.constitutionSha(proj), first.sha);

  // 4. forbiddenPatterns extracts Article III bullets from the template.
  const forbidden = mod.forbiddenPatterns(proj);
  assert.ok(Array.isArray(forbidden), "forbiddenPatterns returns array");
  assert.ok(forbidden.length >= 2, "template ships >=2 forbidden-op examples");

  // 5. readConstitution returns null for projects without one.
  const empty = mkdtempSync(join(tmpdir(), "pp-no-constitution-"));
  assert.equal(mod.readConstitution(empty), null);
  assert.equal(mod.constitutionSha(empty), null);

  console.log("✓ constitution.ts: scaffold + sha + idempotency + forbidden-extract");
}

async function testAuditDegradedMode() {
  // T6 audit chain — when TheEights is offline, materializeAuditBom and
  // verifyAuditChain must return null without throwing. Callers MUST
  // treat null as "could not verify" (or "no BOM materialized"), not
  // "verified" / "BOM exists".
  const mod = await importDist("ecosystem/eights-writes.js");

  const bom = await mod.materializeAuditBom("run_phase_d_test");
  assert.equal(bom, null, "materializeAuditBom returns null with no peer");

  const verify = await mod.verifyAuditChain("run_phase_d_test");
  assert.equal(verify, null, "verifyAuditChain returns null with no peer");

  console.log("✓ audit chain (T6): degrades gracefully when peer absent");
}

async function testHydraEnvelopeEmitters() {
  // T3 — Phase E. With no TheEights peer, every emitter must allocate
  // an envelope_id locally and return recorded=false without throwing.
  const mod = await importDist("ecosystem/hydra-envelopes.js");

  const dr = await mod.emitDecisionRecord({
    run_id: "run_phase_e_1",
    project_path: "C:\\tmp\\fake-e",
    workflow_id: "wf_e_1",
    origin_squad: "executive",
    request_text: "test request",
    status: "complete",
    summary_md: "# done",
    artifact_count: 0,
  });
  assert.ok(dr.envelope_id?.startsWith("env_pp_dr_"), "DR envelope_id allocated");
  assert.equal(dr.recorded, false, "DR not recorded (no peer)");

  const csp = await mod.emitStrategicFramingRequest({
    run_id: "run_phase_e_2",
    project_path: "C:\\tmp\\fake-e",
    request_text: "redesign auth across all tiers",
    profile: "enterprise",
    hydra_workflow_id: null,
  });
  assert.ok(csp.envelope_id?.startsWith("env_pp_csp_"), "CSP envelope_id allocated");
  assert.equal(csp.recorded, false);

  const cb = await mod.emitCreativeBrief({
    run_id: "run_phase_e_3",
    project_path: "C:\\tmp\\fake-e",
    workflow_id: null,
    target: "creative",
    brief_kind: "visual-direction-advisory",
    surface_description: "new onboarding hero",
    payload_excerpt: "Welcome — get started in 60 seconds.",
  });
  assert.ok(cb.envelope_id?.startsWith("env_pp_cb_"), "CB envelope_id allocated");
  assert.equal(cb.recorded, false);

  console.log("✓ hydra-envelopes.ts: 3 emitters allocate ids, degrade gracefully");
}

async function testAutogenesisAnalyzer() {
  // T4 — Phase F. Pure-function tests against the analyzer's DB queries.
  // We can't easily seed the analyzer's project_path query without
  // touching the real DB at ~/.pair-programmer/state.db, so this is
  // an integration smoke test: the analyzer must return [] when no
  // matching project history exists, and never throw.
  const mod = await importDist("orchestrator/autogenesis-analyzer.js");

  // Empty/unknown project — analyzer must return [] without throwing.
  const proposals = await mod.analyzeAndPropose({
    run_id: "run_phase_f_synthetic",
    project_path: "C:\\tmp\\fake-phase-f-no-history",
  });
  assert.ok(Array.isArray(proposals), "analyzeAndPropose returns array");
  assert.equal(proposals.length, 0, "empty history → 0 proposals");

  // listProposals on the same unknown project — must return [].
  const list = mod.listProposals({ project_path: "C:\\tmp\\fake-phase-f-no-history" });
  assert.ok(Array.isArray(list));
  assert.equal(list.length, 0);

  // setProposalStatus on a non-existent id — must return false (no rows updated).
  const updated = mod.setProposalStatus("prop_nonexistent", "approved");
  assert.equal(updated, false, "setProposalStatus on missing id → false");

  console.log("✓ autogenesis-analyzer.ts: empty-history + missing-id paths");
}

async function main() {
  await testHydraContext();
  await testEightsClientDegradedMode();
  await testWritePathDegradedMode();
  await testConstitution();
  await testAuditDegradedMode();
  await testHydraEnvelopeEmitters();
  await testAutogenesisAnalyzer();
  console.log("✓ ecosystem.unit.mjs: all assertions passed");
}

main().catch(err => {
  console.error("✗ ecosystem.unit.mjs failed:", err);
  process.exit(1);
});
