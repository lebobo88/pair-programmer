// Phase 1 smoke test for the pp_harness MCP server.
// Spawns `pp-daemon mcp` as a subprocess, drives it through the StdioClientTransport,
// exercises start_run → start_stage → record_attempt → record_verdict → finalize_*,
// then prints the resulting state.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync, writeFileSync, existsSync } from "node:fs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DAEMON = join(__dirname, "..", "dist", "index.js");

function pretty(json) {
  return JSON.stringify(json, null, 2);
}

async function callTool(client, name, args = {}) {
  const result = await client.callTool({ name, arguments: args });
  if (result.isError) throw new Error(`tool ${name} failed: ${pretty(result.content)}`);
  const text = result.content?.[0]?.text;
  return text ? JSON.parse(text) : null;
}

async function main() {
  const transport = new StdioClientTransport({
    command: process.execPath,        // node
    args: [DAEMON, "mcp"],
  });
  const client = new Client({ name: "smoke-test", version: "0.0.1" }, { capabilities: {} });
  await client.connect(transport);

  try {
    // 0. List tools — confirms the server registered them.
    const tools = await client.listTools();
    console.log(`✓ listTools -> ${tools.tools.length} tools registered`);

    // 1. Doctor.
    const health = await callTool(client, "doctor");
    console.log(`✓ doctor: db_reachable=${health.db_reachable}, cross_vendor_ready=${health.cross_vendor_ready}`);

    // 2. Start a run inside a temp dir (so we don't litter the project).
    const projectPath = mkdtempSync(join(tmpdir(), "pp-smoke-"));
    const run = await callTool(client, "start_run", {
      request_text: "smoke test request: do nothing",
      project_path: projectPath,
      mode: "single",
    });
    console.log(`✓ start_run -> ${run.run_id}`);

    // 3. Start a code stage.
    const stage = await callTool(client, "start_stage", {
      run_id: run.run_id,
      kind: "code",
      gate_type: "code_style",
    });
    console.log(`✓ start_stage -> ${stage.stage_id}`);

    // 4. Record an attempt (no real CLI call — synthetic data).
    const att = await callTool(client, "record_attempt", {
      stage_id: stage.stage_id,
      producer: "codex",
      model_id: "gpt-5.5",
      tokens_in: 1234,
      tokens_out: 567,
      cost_usd: 0.012,
      wall_ms: 4321,
      status: "ok",
    });
    console.log(`✓ record_attempt -> ${att.attempt_id}`);

    // 5. Archive a fake artifact.
    const artifact = await callTool(client, "archive_artifact", {
      run_id: run.run_id,
      stage_id: stage.stage_id,
      taxonomy_section: "4.8",
      kind: "diff",
      relative_path: "code/attempt-1.diff",
      bytes: "diff --git a/foo b/foo\n--- a/foo\n+++ b/foo\n@@ -1 +1 @@\n-old\n+new\n",
    });
    console.log(`✓ archive_artifact -> ${artifact.artifact_id} (${artifact.sha256.slice(0, 12)}…)`);

    // 6. Record a verdict — judge uses gpt-5.4 (different model, same vendor).
    //    critique_md must be ≥80 non-whitespace chars to satisfy the
    //    anti-vacuous-pass refine on RecordVerdictSchema.
    const verdict = await callTool(client, "record_verdict", {
      attempt_id: att.attempt_id,
      judge_producer: "codex",
      judge_model_id: "gpt-5.4",
      outcome: "pass",
      critique_md: "Smoke verdict: synthetic attempt accepted. Diff is single-line, no logic risk, and rubric dimensions correctness/minimality both satisfied for this no-op artifact.",
      score_json: { correctness: 0.9, minimality: 0.95 },
    });
    console.log(`✓ record_verdict -> ${verdict.verdict_id} (cross_vendor=${verdict.cross_vendor})`);

    // 7. Finalize stage and run.
    await callTool(client, "finalize_stage", {
      stage_id: stage.stage_id,
      status: "passed",
      winner_attempt_id: att.attempt_id,
    });
    console.log(`✓ finalize_stage`);
    await callTool(client, "finalize_run", {
      run_id: run.run_id,
      status: "complete",
      summary_md: "# Run summary\n\nSmoke test complete.\n",
    });
    console.log(`✓ finalize_run`);

    // 8. Read back the run tree.
    const tree = await callTool(client, "get_run", { run_id: run.run_id });
    if (!tree?.run) throw new Error("get_run returned no run");
    if (tree.stages.length !== 1)   throw new Error(`expected 1 stage, got ${tree.stages.length}`);
    if (tree.attempts.length !== 1) throw new Error(`expected 1 attempt, got ${tree.attempts.length}`);
    if (tree.verdicts.length !== 1) throw new Error(`expected 1 verdict, got ${tree.verdicts.length}`);
    if (tree.artifacts.length !== 1) throw new Error(`expected 1 artifact, got ${tree.artifacts.length}`);
    console.log(`✓ get_run roundtrip: 1 stage, 1 attempt, 1 verdict, 1 artifact`);

    // 9. Budgets should reflect the attempt cost.
    const budget = await callTool(client, "budget_status", { scope: `run:${run.run_id}` });
    if (!budget || budget.cost_usd !== 0.012) throw new Error(`budget mismatch: ${pretty(budget)}`);
    console.log(`✓ budget_status: $${budget.cost_usd} for ${budget.tokens_in} in / ${budget.tokens_out} out`);

    // 10. Phase 2: gate_eligible_judges — same-vendor on plain code_style.
    const gate1 = await callTool(client, "gate_eligible_judges", {
      gate_type: "code_style",
      generator_producer: "codex",
      prompt_keywords: "rename a variable from foo to bar",
    });
    if (gate1.required_cross_vendor) throw new Error(`expected same-vendor for plain code_style, got: ${pretty(gate1)}`);
    if (gate1.allowed_judges[0].agent !== "judge-same-vendor") throw new Error(`expected judge-same-vendor first`);
    console.log(`✓ gate_eligible_judges (code_style/plain) -> ${gate1.base_tier}, judges=[${gate1.allowed_judges.map(j => j.agent).join(",")}]`);

    // 11. Phase 2: cross-vendor required when prompt mentions security keywords.
    const gate2 = await callTool(client, "gate_eligible_judges", {
      gate_type: "code_style",
      generator_producer: "codex",
      prompt_keywords: "fix the auth token leak in the password reset flow",
    });
    if (!gate2.required_cross_vendor) throw new Error(`expected cross-vendor on auth/password keywords, got: ${pretty(gate2)}`);
    if (!gate2.upgraded) throw new Error(`expected upgraded=true after content escalation`);
    console.log(`✓ gate_eligible_judges (security keywords) -> upgraded=true, reason="${gate2.reason}"`);

    // 12. Phase 2: enterprise profile forces cross-vendor on every gate.
    const gate3 = await callTool(client, "gate_eligible_judges", {
      gate_type: "docs_polish",
      generator_producer: "claude",
      prompt_keywords: "polish the changelog",
      profile: "enterprise",
    });
    if (!gate3.required_cross_vendor) throw new Error(`expected cross-vendor on enterprise profile, got: ${pretty(gate3)}`);
    console.log(`✓ gate_eligible_judges (enterprise profile) -> required_cross_vendor=true`);

    // 13a. Phase 3: triage classifier.
    const tri1 = await callTool(client, "triage_request", { request_text: "fix typo in README" });
    if (tri1.scope !== "trivial") throw new Error(`expected trivial for typo, got ${tri1.scope}`);
    const tri2 = await callTool(client, "triage_request", { request_text: "redesign the auth subsystem with new threat model" });
    if (tri2.scope !== "major") throw new Error(`expected major for security redesign, got ${tri2.scope}`);
    console.log(`✓ triage_request: typo→trivial, redesign+security→major`);

    // 13b. Phase 3: taxonomy mapper.
    const mapping = await callTool(client, "map_taxonomy", { request_text: "add an OAuth login endpoint with new tests" });
    const ids = mapping.sections.map(s => s.id).sort();
    if (!ids.includes("4.13")) throw new Error(`every mapping must include 4.13 (changelog); got ${ids}`);
    if (!ids.includes("4.7"))  throw new Error(`api/endpoint should pull 4.7; got ${ids}`);
    if (!ids.includes("4.9"))  throw new Error(`auth should pull 4.9; got ${ids}`);
    if (!ids.includes("4.10")) throw new Error(`tests should pull 4.10; got ${ids}`);
    console.log(`✓ map_taxonomy: ${ids.join(",")} (missability=${mapping.missability_required.length})`);

    // 13c. Phase 3: record_taxonomy_mapping needs an active run.
    const run3 = await callTool(client, "start_run", { request_text: "phase3 mapping test", project_path: projectPath, mode: "single" });
    await callTool(client, "record_taxonomy_mapping", {
      run_id: run3.run_id,
      scope: mapping.scope,
      signals: mapping.signals,
      sections: mapping.sections,
      missability_required: mapping.missability_required,
    });
    const tree3 = await callTool(client, "get_run", { run_id: run3.run_id });
    if (!tree3.run.taxonomy_mapping_json) throw new Error(`record_taxonomy_mapping did not persist`);
    console.log(`✓ record_taxonomy_mapping persisted on run row`);
    await callTool(client, "finalize_run", { run_id: run3.run_id, status: "complete" });

    // 13d. Phase 3: master plan ensure + patch + status.
    // Use a fresh tmpdir for this block: the shared `projectPath` already has
    // PROJECT_MASTER.md from prior finalize_run calls (autoPatchMasterPlan ->
    // ensureMasterPlan is invoked on every finalize, even when no artifacts
    // exist). Reusing it would make the `created: true` assertion impossible.
    const mpDir = mkdtempSync(join(tmpdir(), "pp-smoke-mp-"));
    const mp1 = await callTool(client, "ensure_master_plan", { project_path: mpDir });
    if (!mp1.created) throw new Error(`ensure_master_plan should have created the file in fresh tmp dir`);
    const mp2 = await callTool(client, "ensure_master_plan", { project_path: mpDir });
    if (mp2.created) throw new Error(`ensure_master_plan should be idempotent`);
    console.log(`✓ ensure_master_plan: created=${mp1.created}, then idempotent`);

    const patch = await callTool(client, "apply_master_plan_patch", {
      run_id: run3.run_id,
      project_path: mpDir,
      section: "11. Architecture and technical strategy",
      kind: "append",
      content_md: "### Run smoke-1\n- Decision: use TypeScript for the daemon\n- Rationale: matches Claude Code's runtime\n",
    });
    if (!patch.patch_id) throw new Error(`apply_master_plan_patch returned no patch_id`);
    console.log(`✓ apply_master_plan_patch: ${patch.patch_id} (sha ${patch.new_sha.slice(0, 12)}…)`);

    const status = await callTool(client, "master_plan_status", { project_path: mpDir });
    const archSection = status.sections.find(s => s.section === "11. Architecture and technical strategy");
    if (!archSection?.populated) throw new Error(`section 11 should be populated after patch`);
    console.log(`✓ master_plan_status: ${status.sections.filter(s => s.populated).length}/${status.sections.length} populated, ${status.completion_checklist.filter(c => c.pass).length}/${status.completion_checklist.length} checklist passing`);

    // 14. Phase 2: spec gates are cross-vendor by default.
    const gate4 = await callTool(client, "gate_eligible_judges", {
      gate_type: "spec",
      generator_producer: "codex",
      prompt_keywords: "draft the PRD section",
    });
    if (!gate4.required_cross_vendor) throw new Error(`expected cross-vendor for spec base tier`);
    if (gate4.upgraded) throw new Error(`expected base tier (not upgraded) for spec`);
    console.log(`✓ gate_eligible_judges (spec base tier) -> required_cross_vendor=true, rubric_id=${gate4.rubric_id}`);

    // 15. Phase 4: missability library is the right size.
    const checks = await callTool(client, "list_missability_checks");
    if (checks.length !== 54) throw new Error(`expected 54 missability checks, got ${checks.length}`);
    console.log(`✓ list_missability_checks: ${checks.length} checks`);

    // 16. Phase 4: run_missability_checks runs and returns results.
    const missRun = await callTool(client, "start_run", { request_text: "phase4 missability test", project_path: projectPath, mode: "single" });
    const missStage = await callTool(client, "start_stage", { run_id: missRun.run_id, kind: "code", gate_type: "code_style" });
    await callTool(client, "archive_artifact", {
      run_id: missRun.run_id,
      stage_id: missStage.stage_id,
      kind: "diff",
      relative_path: "code/foo.diff",
      bytes: "Decision log: chose latency over availability for cache layer (rationale documented). Owner: oncall@example.com.",
    });
    const missResult = await callTool(client, "run_missability_checks", {
      run_id: missRun.run_id,
      required_check_ids: ["decision-logging", "doc-ownership", "nfrs-declared"],
    });
    if (missResult.results.length !== 54) throw new Error(`expected 54 results, got ${missResult.results.length}`);
    const dl = missResult.results.find(r => r.check_id === "decision-logging");
    if (dl?.status !== "pass") throw new Error(`decision-logging should pass on artifact mentioning "Decision log"`);
    console.log(`✓ run_missability_checks: ${missResult.pass_count} pass, ${missResult.fail_count} fail, ${missResult.na_count} n/a`);
    await callTool(client, "finalize_stage", { stage_id: missStage.stage_id, status: "passed" });
    await callTool(client, "finalize_run", { run_id: missRun.run_id, status: "complete" });

    // 17. Phase 4: loop_ceiling_status reflects the verdict count.
    const ceil = await callTool(client, "loop_ceiling_status", { run_id: run3.run_id });
    if (ceil.ceiling !== 6) throw new Error(`expected default ceiling 6`);
    if (ceil.validator_calls < 0) throw new Error(`unexpected validator_calls`);
    console.log(`✓ loop_ceiling_status: ${ceil.validator_calls}/${ceil.ceiling} (remaining ${ceil.remaining}, blocked=${ceil.blocked})`);

    // 18. Phase 4: retry_with_critique enforces Reflexion ×1.
    // Use the original attempt from step 4. Should be eligible (retry_index=0).
    const retry1 = await callTool(client, "retry_with_critique", {
      attempt_id: att.attempt_id,
      critique_md: "needs more tests",
    });
    if (!retry1.ok) throw new Error(`first retry should be eligible: ${retry1.reason}`);
    console.log(`✓ retry_with_critique: first call ok=true (parent=${retry1.parent_attempt_id})`);

    // Record a retry attempt with retry_index=1 — second retry attempt should be rejected.
    const retryAtt = await callTool(client, "record_attempt", {
      stage_id: stage.stage_id,
      producer: "codex",
      model_id: "gpt-5.5",
      tokens_in: 100, tokens_out: 50, cost_usd: 0.001,
      retry_index: 1,
      parent_attempt_id: att.attempt_id,
    });
    const retry2 = await callTool(client, "retry_with_critique", {
      attempt_id: retryAtt.attempt_id,
      critique_md: "still wrong",
    });
    if (retry2.ok) throw new Error(`second retry should be rejected (×1 invariant)`);
    if (!/×1 invariant/.test(retry2.reason)) throw new Error(`expected ×1 invariant message, got: ${retry2.reason}`);
    console.log(`✓ retry_with_critique: second call rejected (Reflexion ×1)`);

    // 19. Phase 5: Borda count.
    const borda = await callTool(client, "borda_count", {
      candidate_ids: ["c1", "c2", "c3"],
      rankings: [
        ["c1", "c2", "c3"],   // judge A: c1 best
        ["c2", "c1", "c3"],   // judge B: c2 best
        ["c1", "c3", "c2"],   // judge C: c1 best
      ],
    });
    if (borda.winner !== "c1") throw new Error(`Borda should pick c1 (2 firsts + 1 second), got ${borda.winner}`);
    console.log(`✓ borda_count: winner=${borda.winner}, scores=${borda.scores.map(s => `${s.candidate_id}:${s.total_points}`).join(",")}`);

    // 20. Phase 5: diff_entropy detects identical candidates.
    const ent1 = await callTool(client, "diff_entropy", {
      candidate_texts: [
        "function add(a, b) { return a + b; }",
        "function add(a, b) { return a + b; }",
        "function add(a, b) { return a + b; }",
      ],
    });
    if (ent1.max_similarity < 0.99) throw new Error(`identical candidates should have similarity ~1.0, got ${ent1.max_similarity}`);
    if (!ent1.warning) throw new Error(`identical candidates should trigger low-diversity warning`);
    console.log(`✓ diff_entropy (identical) -> max_similarity=${ent1.max_similarity.toFixed(3)}, warning fired`);

    const ent2 = await callTool(client, "diff_entropy", {
      candidate_texts: [
        "function add(a, b) { return a + b; }",
        "const sum = (x, y) => x + y;",
        "def add(a, b):\n    return a + b",
      ],
    });
    if (ent2.warning) throw new Error(`distinct candidates should not warn`);
    console.log(`✓ diff_entropy (diverse) -> max_similarity=${ent2.max_similarity.toFixed(3)}, no warning`);

    // 20a. Defensive serialization regression nets.
    //
    // (a) Per-field defensive parse: record_verdict.score_json accepts either an
    //     object or a JSON-encoded string. Locks down the precedent pattern at
    //     harness-server.ts lines 82-87. Uses a fresh attempt so the
    //     anti-vacuous-pass refine isn't tripped.
    const serialRun = await callTool(client, "start_run", { request_text: "phase5a serialization regression", project_path: projectPath, mode: "single" });
    const serialStage = await callTool(client, "start_stage", { run_id: serialRun.run_id, kind: "code", gate_type: "code_style" });
    const serialAtt = await callTool(client, "record_attempt", {
      stage_id: serialStage.stage_id,
      producer: "codex", model_id: "gpt-5.5",
      tokens_in: 1, tokens_out: 1, cost_usd: 0.0001, status: "ok",
    });
    const serialVerdict = await callTool(client, "record_verdict", {
      attempt_id: serialAtt.attempt_id,
      judge_producer: "codex", judge_model_id: "gpt-5.4",
      outcome: "pass",
      critique_md: "Serialization regression: score_json arrived as a JSON-encoded string from a non-typed MCP client and the per-field defensive parse converted it back to an object before the refine ran. " +
                   "This locks down the precedent the dispatch-layer defensive parse mirrors.",
      score_json: JSON.stringify({ correctness: 0.9, minimality: 0.9 }),
    });
    if (!serialVerdict.verdict_id) throw new Error(`record_verdict should accept score_json as a JSON string`);
    console.log(`✓ record_verdict accepts score_json as a JSON-encoded string (per-field defensive parse precedent)`);
    await callTool(client, "finalize_stage", { stage_id: serialStage.stage_id, status: "passed", winner_attempt_id: serialAtt.attempt_id });
    await callTool(client, "finalize_run", { run_id: serialRun.run_id, status: "complete" });
    //
    // (b) Dispatch-layer defensive parse (harness-server.ts line ~746) handles
    //     the case where the entire `arguments` field arrives as a JSON-encoded
    //     string from a non-SDK MCP client. The official MCP SDK validates
    //     arguments as Record<string, unknown> at CallToolRequestSchema BEFORE
    //     our dispatch handler runs (see node_modules/.../server/index.js
    //     safeParse(CallToolRequestSchema, request)), so we cannot exercise
    //     that path through Client.callTool here — it's defensive code for
    //     raw JSON-RPC clients.

    // 21. Phase 6: rubric registry has 25 rubrics.
    const rubricList = await callTool(client, "list_rubrics");
    if (rubricList.length !== 25) throw new Error(`expected 25 rubrics, got ${rubricList.length}`);
    const wcag = await callTool(client, "get_rubric", { id: "wcag-2.2-aa@1" });
    if (!wcag?.markdown.includes("8-state matrix")) throw new Error(`wcag rubric body missing expected content`);
    const wrv2 = await callTool(client, "get_rubric", { id: "web-runtime-validation@2" });
    if (!wrv2?.markdown.includes("carve_outs")) throw new Error(`web-runtime-validation@2 rubric body missing carve_outs language`);
    console.log(`✓ list_rubrics: ${rubricList.length} rubrics, get_rubric works (incl. web-runtime-validation@2 carve-outs)`);

    // 22. Phase 6: 10 built-in profiles.
    const profiles = await callTool(client, "list_profiles");
    if (profiles.length !== 16) throw new Error(`expected 16 profiles, got ${profiles.length}`);
    const ent = await callTool(client, "get_builtin_profile", { name: "enterprise" });
    if (!ent?.notes?.includes("cross-vendor")) throw new Error(`enterprise profile should mention cross-vendor`);
    console.log(`✓ list_profiles: ${profiles.length} profiles, get_builtin_profile works`);

    // 23. Phase 6: get_profile returns null when no profile.yaml present.
    const noProfile = await callTool(client, "get_profile", { project_path: projectPath });
    if (noProfile !== null) throw new Error(`expected null when no profile.yaml present`);
    console.log(`✓ get_profile: null when absent`);

    // 23a. Profile bootstrap: detect_profile on the empty smoke projectPath -> "none".
    const detectEmpty = await callTool(client, "detect_profile", { project_path: projectPath });
    if (detectEmpty.confidence !== "none") {
      throw new Error(`expected confidence=none on empty dir, got ${detectEmpty.confidence}`);
    }
    console.log(`✓ detect_profile (empty): confidence=${detectEmpty.confidence}`);

    // 23b. Profile bootstrap: package.json with next dep -> recommendation=web-ui, confidence=high.
    const webFixture = mkdtempSync(join(tmpdir(), "pp-smoke-webui-"));
    writeFileSync(join(webFixture, "package.json"), JSON.stringify({
      name: "web-fixture",
      dependencies: { next: "^14" },
    }));
    const detectWeb = await callTool(client, "detect_profile", { project_path: webFixture });
    if (detectWeb.recommendation !== "web-ui" || detectWeb.confidence !== "high") {
      throw new Error(`expected web-ui/high, got ${detectWeb.recommendation}/${detectWeb.confidence}`);
    }
    console.log(`✓ detect_profile (next dep): ${detectWeb.recommendation}/${detectWeb.confidence}`);

    // 23c. Profile bootstrap: write_profile persists with provenance header.
    const written = await callTool(client, "write_profile", {
      project_path: webFixture,
      name:         "web-ui",
      source:       "detected",
      signals:      ['package.json deps include "next"'],
    });
    if (!written.path || !existsSync(written.path)) {
      throw new Error(`write_profile did not produce a real file: ${pretty(written)}`);
    }
    if (!written.yaml.includes("Bootstrapped by pair-programmer harness")) {
      throw new Error(`write_profile yaml missing provenance header`);
    }
    console.log(`✓ write_profile: wrote ${written.path}`);

    // 23d. After write, get_profile reads it back as web-ui.
    const reread = await callTool(client, "get_profile", { project_path: webFixture });
    if (reread?.name !== "web-ui") {
      throw new Error(`get_profile after write expected web-ui, got ${reread?.name}`);
    }
    console.log(`✓ get_profile after write: ${reread.name}`);

    // 23e. Bin-only fixture -> recommendation=non-ui-cli, confidence=high.
    const cliFixture = mkdtempSync(join(tmpdir(), "pp-smoke-cli-"));
    writeFileSync(join(cliFixture, "package.json"), JSON.stringify({
      name: "cli-fixture",
      bin: { foo: "./cli.js" },
    }));
    const detectCli = await callTool(client, "detect_profile", { project_path: cliFixture });
    if (detectCli.recommendation !== "non-ui-cli" || detectCli.confidence !== "high") {
      throw new Error(`expected non-ui-cli/high, got ${detectCli.recommendation}/${detectCli.confidence}`);
    }
    console.log(`✓ detect_profile (bin only): ${detectCli.recommendation}/${detectCli.confidence}`);

    // 24. Phase 7: 15 built-in teams resolve.
    const teams = await callTool(client, "team_list", { project_path: projectPath });
    if (teams.length !== 20) throw new Error(`expected 20 builtin teams, got ${teams.length}: ${teams.map(t => t.name).join(",")}`);
    console.log(`✓ team_list: ${teams.length} teams`);
    const featureTeam = await callTool(client, "team_get", { name: "feature-team", project_path: projectPath });
    if (!featureTeam?.team || featureTeam.origin !== "builtin") throw new Error(`feature-team should resolve to builtin`);
    if (featureTeam.team.stages.length !== 7) throw new Error(`feature-team should have 7 stages, got ${featureTeam.team.stages.length}`);
    console.log(`✓ team_get feature-team: ${featureTeam.team.stages.length} stages, origin=${featureTeam.origin}`);

    // 25. Phase 8: design templates.
    const tplKinds = await callTool(client, "list_design_templates");
    if (!Array.isArray(tplKinds) || tplKinds.length < 5) throw new Error(`expected >=5 design templates`);
    const ssm = await callTool(client, "get_design_template", { kind: "screen_state_matrix" });
    if (!ssm || !ssm.includes("8/8 states")) throw new Error(`screen_state_matrix template missing expected text`);
    console.log(`✓ list/get_design_template: ${tplKinds.length} templates, screen_state_matrix renders 8/8`);

    // 26. Phase 9: 10 governance forums.
    const forums = await callTool(client, "list_forums");
    if (forums.length !== 10) throw new Error(`expected 10 forums, got ${forums.length}`);
    const threat = await callTool(client, "get_forum", { id: "threat" });
    if (!threat?.stages || threat.stages.length < 2) throw new Error(`threat forum should have stages`);
    if (threat.stages[0].rubric_id !== "owasp-asvs-l1@1") throw new Error(`threat stage should bind asvs-l1`);
    console.log(`✓ list_forums: ${forums.length}, get_forum threat: ${threat.stages.length} stages, rubric=${threat.stages[0].rubric_id}`);

    // 27. Phase 11: replay bundle for an existing run.
    const replay = await callTool(client, "replay", { run_id: run.run_id });
    if (!replay || replay.run_id !== run.run_id) throw new Error(`replay should return the bundle for ${run.run_id}`);
    if (typeof replay.reproduction_notes !== "string") throw new Error(`replay should include reproduction_notes`);
    console.log(`✓ replay: ${replay.stages.length} stage(s), ${replay.artifacts.length} artifact(s), notes "${replay.reproduction_notes.slice(0, 40)}…"`);

    // 28. Phase 11: janitor is idempotent and returns valid shape.
    const jan = await callTool(client, "janitor");
    if (!Array.isArray(jan.crashed_runs) || !Array.isArray(jan.swept_worktrees)) throw new Error(`janitor returned wrong shape`);
    console.log(`✓ janitor: crashed=${jan.crashed_runs.length}, worktrees=${jan.swept_worktrees.length}, branches=${jan.swept_branches.length}`);

    console.log("\nALL SMOKE CHECKS PASSED");
  } finally {
    await client.close();
  }
}

main().catch(err => {
  console.error("SMOKE FAILED:", err);
  process.exit(1);
});
