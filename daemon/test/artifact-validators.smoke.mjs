// Artifact-validator smoke. Mirrors test/smoke.mjs structure: spawns
// `pp-daemon mcp`, drives the new MCP tools (artifact_validate,
// get_artifact_validation), and checks the finalize_stage gate refuses
// 'passed' when validation is missing or failed, but succeeds with
// 'surfaced' regardless. Step 1 covers the canonical adr_structure_lint
// validator. Subsequent landings will append per-validator blocks.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DAEMON = join(__dirname, "..", "dist", "index.js");

function pretty(json) { return JSON.stringify(json, null, 2); }

function makeRuntimeProject(root, name) {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  return dir;
}

async function callTool(client, name, args = {}) {
  const result = await client.callTool({ name, arguments: args });
  if (result.isError) throw new Error(`tool ${name} failed: ${pretty(result.content)}`);
  const text = result.content?.[0]?.text;
  return text ? JSON.parse(text) : null;
}

async function expectThrow(fn, predicate, label) {
  try {
    await fn();
  } catch (err) {
    if (predicate(err)) {
      console.log(`✓ ${label} (rejected as expected)`);
      return;
    }
    throw new Error(`${label}: rejected but predicate failed: ${err.message}`);
  }
  throw new Error(`${label}: expected rejection, got success`);
}

const VALID_ADR = `# ADR-0042: Adopt SQLite for local harness state

## Status

Accepted on 2026-05-09. Supersedes ADR-0033 which proposed RocksDB; that path
was abandoned after the on-disk corruption incident in late April.

## Context

The pair-programmer harness needs a local store for run / stage / attempt /
verdict / artifact rows. We considered three options. The store is single-writer
(one daemon process), embedded, and the access pattern is tiny ad-hoc queries
mixed with bulk artifact metadata writes. Operational simplicity matters more
than raw throughput at the scale we expect (thousands of rows per project, not
millions). We also need easy backup — a single file the user can zip.

## Decision

We will use SQLite in WAL mode with foreign keys enabled and a busy timeout
of five seconds. The daemon owns the only writer connection; the
\`better-sqlite3\` binding gives us synchronous access without a separate
process. Migrations are applied at boot via additive ALTER-TABLE statements;
schema is dumped to schema.sql and inlined as schema.ts string for the
compiled dist/.

## Consequences

Pros: zero ops, single-file backup, durable WAL semantics, fast on dev
laptops. Single-writer model trivially serializes the orchestrator. Cons:
no cross-host replication; future multi-daemon deployment would require
re-architecture or a Postgres swap. Schema migrations are append-only; no
DROP COLUMN. Acceptable for the indie / small-team profile we target.

## Alternatives considered

We rejected RocksDB after the corruption event. We rejected Postgres on
ergonomic grounds: an embedded daemon should not require a separate
service. We rejected DuckDB because the workload is not analytical. A
flat-file JSON log was rejected because we need transactional consistency
across the runs/stages/attempts cascade.

## References

- https://www.sqlite.org/wal.html
- ADR-0033 (RocksDB experiment, retired)
- Incident postmortem 2026-04-22
`;

const BAD_ADR_NO_DECISION = `# ADR-0099: Some change with missing structure

## Status

Proposed.

## Context

We need to do something.

## Consequences

Some consequences will follow.

## References

- nothing important
`;

async function main() {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [DAEMON, "mcp"],
  });
  const client = new Client({ name: "av-smoke", version: "0.0.1" }, { capabilities: {} });
  await client.connect(transport);
  const runtimeRoot = join(__dirname, ".artifact-validators-runtime", `${process.pid}-${Date.now()}`);
  mkdirSync(runtimeRoot, { recursive: true });

  try {
    const tools = await client.listTools();
    if (!tools.tools.find(t => t.name === "artifact_validate")) throw new Error("artifact_validate not registered");
    if (!tools.tools.find(t => t.name === "get_artifact_validation")) throw new Error("get_artifact_validation not registered");
    console.log(`✓ artifact_validate + get_artifact_validation registered (${tools.tools.length} tools total)`);

    const projectPath = makeRuntimeProject(runtimeRoot, "project");

    // ─── Happy path: valid ADR → verified → finalize_stage(passed) succeeds. ──
    {
      const run = await callTool(client, "start_run", { request_text: "av-smoke happy", project_path: projectPath, mode: "single" });
      const stage = await callTool(client, "start_stage", { run_id: run.run_id, kind: "architecture", gate_type: "design" });
      const att = await callTool(client, "record_attempt", {
        stage_id: stage.stage_id, producer: "claude", model_id: "claude-opus-4-7",
        tokens_in: 1, tokens_out: 1, cost_usd: 0.0001, status: "ok",
      });
      const archived = await callTool(client, "archive_artifact", {
        run_id: run.run_id, stage_id: stage.stage_id,
        taxonomy_section: "4.6", kind: "adr",
        relative_path: "architecture/adr-0042-sqlite.md",
        bytes: VALID_ADR,
      });
      if (archived.status !== "ok") throw new Error(`archive_artifact unexpected status: ${pretty(archived)}`);

      // No verdict needed for the validator gate itself, but finalize_stage
      // will refuse without one because of the anti-vacuous-pass rules — except
      // that's only on record_verdict. We need a verdict to mark passed cleanly.
      await callTool(client, "record_verdict", {
        attempt_id: att.attempt_id, judge_producer: "claude", judge_model_id: "claude-sonnet-4-6",
        outcome: "pass",
        critique_md: "Smoke verdict: ADR shape looks reasonable; structure check is delegated to the validator gate. This critique exists to satisfy the anti-vacuous-pass refine on record_verdict.",
        score_json: { structure: 0.9, decision_clarity: 0.85 },
      });

      const v = await callTool(client, "artifact_validate", { stage_id: stage.stage_id, kind: "adr_structure_lint" });
      if (v.status !== "verified") throw new Error(`expected verified for valid ADR, got ${pretty(v)}`);
      if (v.binary_resolved !== "in-process:adr-structure-lint") throw new Error(`unexpected binary_resolved: ${v.binary_resolved}`);
      console.log(`✓ artifact_validate adr_structure_lint (valid) → verified`);

      const got = await callTool(client, "get_artifact_validation", { stage_id: stage.stage_id, validator_kind: "adr_structure_lint" });
      if (got.check?.status !== "verified") throw new Error(`get_artifact_validation roundtrip failed: ${pretty(got)}`);

      await callTool(client, "finalize_stage", { stage_id: stage.stage_id, status: "passed", winner_attempt_id: att.attempt_id });
      console.log(`✓ finalize_stage(passed) succeeds when validator verified`);

      await callTool(client, "finalize_run", { run_id: run.run_id, status: "complete" });
    }

    // ─── Regression: explicit path binds an older ADR on a multi-ADR stage. ──
    {
      const run = await callTool(client, "start_run", { request_text: "av-smoke explicit older adr", project_path: projectPath, mode: "single" });
      const stage = await callTool(client, "start_stage", { run_id: run.run_id, kind: "architecture", gate_type: "design" });
      const att = await callTool(client, "record_attempt", {
        stage_id: stage.stage_id, producer: "claude", model_id: "claude-opus-4-7",
        tokens_in: 1, tokens_out: 1, cost_usd: 0.0001, status: "ok",
      });
      const older = await callTool(client, "archive_artifact", {
        run_id: run.run_id, stage_id: stage.stage_id,
        taxonomy_section: "4.6", kind: "adr",
        relative_path: "architecture/adr-0042-older.md",
        bytes: VALID_ADR,
      });
      const newer = await callTool(client, "archive_artifact", {
        run_id: run.run_id, stage_id: stage.stage_id,
        taxonomy_section: "4.6", kind: "adr",
        relative_path: "architecture/adr-0043-newer.md",
        bytes: VALID_ADR.replace("ADR-0042", "ADR-0043"),
      });
      if (older.status !== "ok" || newer.status !== "ok") {
        throw new Error(`expected both ADR archives to succeed: ${pretty({ older, newer })}`);
      }
      await callTool(client, "record_verdict", {
        attempt_id: att.attempt_id, judge_producer: "claude", judge_model_id: "claude-sonnet-4-6",
        outcome: "pass",
        critique_md: "Two ADRs were archived on the same stage. The older one will be validated by explicit path and must still bind back to its artifacts row so finalize_stage can see both validations.",
        score_json: { structure: 0.9, linkage: 0.9 },
      });

      const olderPath = process.platform === "win32"
        ? older.absolute_path.replaceAll("\\", "/")
        : older.absolute_path;
      const olderValidation = await callTool(client, "artifact_validate", {
        stage_id: stage.stage_id,
        kind: "adr_structure_lint",
        artifact_path: olderPath,
      });
      if (olderValidation.status !== "verified") throw new Error(`expected verified for older ADR, got ${pretty(olderValidation)}`);
      if (olderValidation.artifact_id !== older.artifact_id) {
        throw new Error(`expected older ADR validation to bind artifact_id ${older.artifact_id}, got ${pretty(olderValidation)}`);
      }
      const newerValidation = await callTool(client, "artifact_validate", { stage_id: stage.stage_id, kind: "adr_structure_lint" });
      if (newerValidation.status !== "verified") throw new Error(`expected verified for newer ADR, got ${pretty(newerValidation)}`);
      if (newerValidation.artifact_id !== newer.artifact_id) {
        throw new Error(`expected newest ADR validation to bind artifact_id ${newer.artifact_id}, got ${pretty(newerValidation)}`);
      }

      await callTool(client, "finalize_stage", { stage_id: stage.stage_id, status: "passed", winner_attempt_id: att.attempt_id });
      console.log(`✓ explicit artifact_path binds an older ADR on a multi-ADR stage`);
      await callTool(client, "finalize_run", { run_id: run.run_id, status: "complete" });
    }

    // ─── Negative: bad ADR → violation → finalize_stage(passed) refused. ─────
    {
      const run = await callTool(client, "start_run", { request_text: "av-smoke negative", project_path: projectPath, mode: "single" });
      const stage = await callTool(client, "start_stage", { run_id: run.run_id, kind: "architecture", gate_type: "design" });
      const att = await callTool(client, "record_attempt", {
        stage_id: stage.stage_id, producer: "claude", model_id: "claude-opus-4-7",
        tokens_in: 1, tokens_out: 1, cost_usd: 0.0001, status: "ok",
      });
      await callTool(client, "archive_artifact", {
        run_id: run.run_id, stage_id: stage.stage_id,
        taxonomy_section: "4.6", kind: "adr",
        relative_path: "architecture/adr-0099-bad.md",
        bytes: BAD_ADR_NO_DECISION,
      });
      await callTool(client, "record_verdict", {
        attempt_id: att.attempt_id, judge_producer: "claude", judge_model_id: "claude-sonnet-4-6",
        outcome: "pass",
        critique_md: "Anti-vacuous-pass placeholder; the validator gate is the real check here, and it should fire because Decision section is missing.",
        score_json: { structure: 0.5 },
      });

      const v = await callTool(client, "artifact_validate", { stage_id: stage.stage_id, kind: "adr_structure_lint" });
      if (v.status !== "violation") throw new Error(`expected violation for bad ADR, got ${pretty(v)}`);
      if (!/Decision/.test(v.reason ?? "")) throw new Error(`reason should mention missing Decision section, got: ${v.reason}`);
      console.log(`✓ artifact_validate adr_structure_lint (bad) → violation: ${v.reason.slice(0, 80)}`);

      const readiness = await callTool(client, "get_stage_finalize_readiness", { stage_id: stage.stage_id });
      if (readiness.can_pass) throw new Error(`expected blocked readiness for bad ADR, got ${pretty(readiness)}`);
      if (readiness.next_action !== "retry_or_surface") throw new Error(`expected retry_or_surface readiness, got ${pretty(readiness)}`);
      console.log(`✓ get_stage_finalize_readiness (validator violation) -> ${readiness.next_action}`);

      // The gate must refuse 'passed'.
      await expectThrow(
        () => callTool(client, "finalize_stage", { stage_id: stage.stage_id, status: "passed", winner_attempt_id: att.attempt_id }),
        err => /ValidatorGateViolation|adr_structure_lint|finalize_stage refused/i.test(err.message),
        "finalize_stage(passed) refused when validator in violation",
      );

      // 'surfaced' is the escape hatch.
      await callTool(client, "finalize_stage", { stage_id: stage.stage_id, status: "surfaced", winner_attempt_id: att.attempt_id });
      console.log(`✓ finalize_stage(surfaced) succeeds despite violation`);

      await callTool(client, "finalize_run", { run_id: run.run_id, status: "surfaced" });
    }

    // ─── Negative: artifact archived but no validator call → finalize refuses. ─
    {
      const run = await callTool(client, "start_run", { request_text: "av-smoke missing-call", project_path: projectPath, mode: "single" });
      const stage = await callTool(client, "start_stage", { run_id: run.run_id, kind: "architecture", gate_type: "design" });
      const att = await callTool(client, "record_attempt", {
        stage_id: stage.stage_id, producer: "claude", model_id: "claude-opus-4-7",
        tokens_in: 1, tokens_out: 1, cost_usd: 0.0001, status: "ok",
      });
      await callTool(client, "archive_artifact", {
        run_id: run.run_id, stage_id: stage.stage_id,
        kind: "adr",
        relative_path: "architecture/adr-no-validator-called.md",
        bytes: VALID_ADR,
      });
      await callTool(client, "record_verdict", {
        attempt_id: att.attempt_id, judge_producer: "claude", judge_model_id: "claude-sonnet-4-6",
        outcome: "pass",
        critique_md: "Critique long enough to satisfy the anti-vacuous-pass refine. The validator was intentionally not called to exercise the missing-row branch of the validator gate.",
        score_json: { structure: 0.9 },
      });

      const readiness = await callTool(client, "get_stage_finalize_readiness", { stage_id: stage.stage_id });
      if (readiness.can_pass) throw new Error(`expected blocked readiness when validator was never called, got ${pretty(readiness)}`);
      if (readiness.next_action !== "run_artifact_validate") throw new Error(`expected run_artifact_validate readiness, got ${pretty(readiness)}`);
      console.log(`✓ get_stage_finalize_readiness (missing validator call) -> ${readiness.next_action}`);

      await expectThrow(
        () => callTool(client, "finalize_stage", { stage_id: stage.stage_id, status: "passed", winner_attempt_id: att.attempt_id }),
        err => /artifact_validate/i.test(err.message),
        "finalize_stage(passed) refused when validator never called",
      );

      await callTool(client, "finalize_stage", { stage_id: stage.stage_id, status: "surfaced", winner_attempt_id: att.attempt_id });
      await callTool(client, "finalize_run", { run_id: run.run_id, status: "surfaced" });
    }

    // ─── Sanity: unrelated artifact kinds don't get gated. ───────────────────
    {
      const run = await callTool(client, "start_run", { request_text: "av-smoke unrelated", project_path: projectPath, mode: "single" });
      const stage = await callTool(client, "start_stage", { run_id: run.run_id, kind: "code", gate_type: "code_style" });
      const att = await callTool(client, "record_attempt", {
        stage_id: stage.stage_id, producer: "claude", model_id: "claude-opus-4-7",
        tokens_in: 1, tokens_out: 1, cost_usd: 0.0001, status: "ok",
      });
      await callTool(client, "archive_artifact", {
        run_id: run.run_id, stage_id: stage.stage_id,
        kind: "diff",
        relative_path: "code/foo.diff",
        bytes: "diff --git a/foo b/foo\n--- a/foo\n+++ b/foo\n@@ -1 +1 @@\n-old\n+new\n",
      });
      await callTool(client, "record_verdict", {
        attempt_id: att.attempt_id, judge_producer: "claude", judge_model_id: "claude-sonnet-4-6",
        outcome: "pass",
        critique_md: "Diff-only artifact that does NOT bind to any validator. finalize_stage(passed) should succeed without any validator calls. Anti-vacuous-pass guard text continues here to clear the 80-char floor.",
        score_json: { correctness: 0.9 },
      });

      await callTool(client, "finalize_stage", { stage_id: stage.stage_id, status: "passed", winner_attempt_id: att.attempt_id });
      await callTool(client, "finalize_run", { run_id: run.run_id, status: "complete" });
      console.log(`✓ unrelated artifact kinds (diff) bypass the validator gate`);
    }

    // ─── Schema sanity: artifact_validations table query works. ──────────────
    {
      const got = await callTool(client, "get_artifact_validation", { stage_id: "stage_does_not_exist", validator_kind: "adr_structure_lint" });
      if (got.check !== null) throw new Error(`expected null for unknown stage, got ${pretty(got)}`);
      console.log(`✓ get_artifact_validation returns null for unknown stage`);
    }

    // ─── contracts_lint: valid OpenAPI 3.1 → verified. ──────────────────────
    {
      const VALID_OPENAPI = `openapi: 3.1.0
info:
  title: Notes API
  version: 1.0.0
paths:
  /notes:
    get:
      summary: List notes
      responses:
        '200':
          description: ok
`;
      // Disable npx pass for deterministic offline behaviour.
      const env = process.env.PP_DISABLE_NPX_VALIDATORS;
      process.env.PP_DISABLE_NPX_VALIDATORS = "1";
      try {
        const run = await callTool(client, "start_run", { request_text: "av-smoke contracts ok", project_path: projectPath, mode: "single" });
        const stage = await callTool(client, "start_stage", { run_id: run.run_id, kind: "contracts", gate_type: "contract" });
        const att = await callTool(client, "record_attempt", {
          stage_id: stage.stage_id, producer: "claude", model_id: "claude-opus-4-7",
          tokens_in: 1, tokens_out: 1, cost_usd: 0.0001, status: "ok",
        });
        await callTool(client, "archive_artifact", {
          run_id: run.run_id, stage_id: stage.stage_id, kind: "openapi",
          relative_path: "contracts/openapi.yaml", bytes: VALID_OPENAPI,
        });
        await callTool(client, "record_verdict", {
          attempt_id: att.attempt_id, judge_producer: "claude", judge_model_id: "claude-sonnet-4-6",
          outcome: "pass",
          critique_md: "OpenAPI smoke artifact looks structurally fine; the contracts_lint validator is the real gate. Anti-vacuous-pass guard text continues here to clear the 80-char floor.",
          score_json: { schema_validity: 0.95 },
        });

        const v = await callTool(client, "artifact_validate", { stage_id: stage.stage_id, kind: "contracts_lint" });
        if (v.status !== "verified") throw new Error(`expected verified for valid OpenAPI, got ${pretty(v)}`);
        console.log(`✓ artifact_validate contracts_lint (valid OpenAPI) → verified (binary=${v.binary_resolved})`);
        await callTool(client, "finalize_stage", { stage_id: stage.stage_id, status: "passed", winner_attempt_id: att.attempt_id });
        await callTool(client, "finalize_run", { run_id: run.run_id, status: "complete" });
      } finally {
        if (env === undefined) delete process.env.PP_DISABLE_NPX_VALIDATORS;
        else process.env.PP_DISABLE_NPX_VALIDATORS = env;
      }
    }

    // ─── contracts_lint: missing info.version → violation. ──────────────────
    {
      const BAD_OPENAPI = `openapi: 3.1.0
info:
  title: Notes API
paths:
  /notes:
    get:
      responses:
        '200':
          description: ok
`;
      const env = process.env.PP_DISABLE_NPX_VALIDATORS;
      process.env.PP_DISABLE_NPX_VALIDATORS = "1";
      try {
        const run = await callTool(client, "start_run", { request_text: "av-smoke contracts bad", project_path: projectPath, mode: "single" });
        const stage = await callTool(client, "start_stage", { run_id: run.run_id, kind: "contracts", gate_type: "contract" });
        const att = await callTool(client, "record_attempt", {
          stage_id: stage.stage_id, producer: "claude", model_id: "claude-opus-4-7",
          tokens_in: 1, tokens_out: 1, cost_usd: 0.0001, status: "ok",
        });
        await callTool(client, "archive_artifact", {
          run_id: run.run_id, stage_id: stage.stage_id, kind: "openapi",
          relative_path: "contracts/openapi-bad.yaml", bytes: BAD_OPENAPI,
        });
        await callTool(client, "record_verdict", {
          attempt_id: att.attempt_id, judge_producer: "claude", judge_model_id: "claude-sonnet-4-6",
          outcome: "pass",
          critique_md: "Bad OpenAPI artifact (missing info.version). The judge passed it but the validator should catch it. Anti-vacuous-pass guard text continues here to clear the 80-char floor.",
          score_json: { schema_validity: 0.4 },
        });

        const v = await callTool(client, "artifact_validate", { stage_id: stage.stage_id, kind: "contracts_lint" });
        if (v.status !== "violation") throw new Error(`expected violation, got ${pretty(v)}`);
        if (!/version/.test(v.reason ?? "")) throw new Error(`expected reason mentioning version, got: ${v.reason}`);
        console.log(`✓ artifact_validate contracts_lint (missing version) → violation: ${v.reason.slice(0, 80)}`);

        await expectThrow(
          () => callTool(client, "finalize_stage", { stage_id: stage.stage_id, status: "passed", winner_attempt_id: att.attempt_id }),
          err => /contracts_lint|finalize_stage refused/i.test(err.message),
          "finalize_stage(passed) refused on contracts_lint violation",
        );
        await callTool(client, "finalize_stage", { stage_id: stage.stage_id, status: "surfaced", winner_attempt_id: att.attempt_id });
        await callTool(client, "finalize_run", { run_id: run.run_id, status: "surfaced" });
      } finally {
        if (env === undefined) delete process.env.PP_DISABLE_NPX_VALIDATORS;
        else process.env.PP_DISABLE_NPX_VALIDATORS = env;
      }
    }

    // ─── contracts_lint: AsyncAPI 3 valid → verified. ───────────────────────
    {
      const VALID_ASYNC = `asyncapi: 3.0.0
info:
  title: Order Events
  version: 0.1.0
channels:
  orderCreated:
    address: orders.created
operations:
  publishOrder:
    action: send
    channel:
      $ref: '#/channels/orderCreated'
`;
      const env = process.env.PP_DISABLE_NPX_VALIDATORS;
      process.env.PP_DISABLE_NPX_VALIDATORS = "1";
      try {
        const run = await callTool(client, "start_run", { request_text: "av-smoke asyncapi", project_path: projectPath, mode: "single" });
        const stage = await callTool(client, "start_stage", { run_id: run.run_id, kind: "contracts", gate_type: "contract" });
        const att = await callTool(client, "record_attempt", {
          stage_id: stage.stage_id, producer: "claude", model_id: "claude-opus-4-7",
          tokens_in: 1, tokens_out: 1, cost_usd: 0.0001, status: "ok",
        });
        await callTool(client, "archive_artifact", {
          run_id: run.run_id, stage_id: stage.stage_id, kind: "asyncapi",
          relative_path: "contracts/asyncapi.yaml", bytes: VALID_ASYNC,
        });
        await callTool(client, "record_verdict", {
          attempt_id: att.attempt_id, judge_producer: "claude", judge_model_id: "claude-sonnet-4-6",
          outcome: "pass",
          critique_md: "AsyncAPI 3 spec validates structurally with channels and operations populated. Anti-vacuous-pass guard text continues here to clear the 80-char floor.",
          score_json: { schema_validity: 0.95 },
        });
        const v = await callTool(client, "artifact_validate", { stage_id: stage.stage_id, kind: "contracts_lint" });
        if (v.status !== "verified") throw new Error(`expected verified for AsyncAPI, got ${pretty(v)}`);
        console.log(`✓ artifact_validate contracts_lint (AsyncAPI 3) → verified`);
        await callTool(client, "finalize_stage", { stage_id: stage.stage_id, status: "passed", winner_attempt_id: att.attempt_id });
        await callTool(client, "finalize_run", { run_id: run.run_id, status: "complete" });
      } finally {
        if (env === undefined) delete process.env.PP_DISABLE_NPX_VALIDATORS;
        else process.env.PP_DISABLE_NPX_VALIDATORS = env;
      }
    }

    // ─── tokens_build: valid Style Dictionary tree → verified. ──────────────
    {
      const VALID_TOKENS = JSON.stringify({
        color: {
          surface: {
            primary:   { value: "#0B1220", type: "color" },
            secondary: { value: "{color.surface.primary}", type: "color" },
          },
        },
        space: {
          sm: { value: "4px",  type: "dimension" },
          md: { value: "8px",  type: "dimension" },
          lg: { value: "16px", type: "dimension" },
        },
      }, null, 2);
      const env = process.env.PP_DISABLE_NPX_VALIDATORS;
      process.env.PP_DISABLE_NPX_VALIDATORS = "1";
      try {
        const run = await callTool(client, "start_run", { request_text: "av-smoke tokens ok", project_path: projectPath, mode: "single" });
        const stage = await callTool(client, "start_stage", { run_id: run.run_id, kind: "design_system", gate_type: "design" });
        const att = await callTool(client, "record_attempt", {
          stage_id: stage.stage_id, producer: "claude", model_id: "claude-opus-4-7",
          tokens_in: 1, tokens_out: 1, cost_usd: 0.0001, status: "ok",
        });
        await callTool(client, "archive_artifact", {
          run_id: run.run_id, stage_id: stage.stage_id, kind: "design_tokens",
          relative_path: "design_system/tokens.json", bytes: VALID_TOKENS,
        });
        await callTool(client, "record_verdict", {
          attempt_id: att.attempt_id, judge_producer: "claude", judge_model_id: "claude-sonnet-4-6",
          outcome: "pass",
          critique_md: "Tokens appear well-shaped (DTCG/Style Dictionary). The tokens_build validator handles the structural assertion. Anti-vacuous-pass guard text continues here to clear the 80-char floor.",
          score_json: { tokenization: 0.9 },
        });

        const v = await callTool(client, "artifact_validate", { stage_id: stage.stage_id, kind: "tokens_build" });
        if (v.status !== "verified") throw new Error(`expected verified for valid tokens, got ${pretty(v)}`);
        console.log(`✓ artifact_validate tokens_build (valid) → verified`);
        await callTool(client, "finalize_stage", { stage_id: stage.stage_id, status: "passed", winner_attempt_id: att.attempt_id });
        await callTool(client, "finalize_run", { run_id: run.run_id, status: "complete" });
      } finally {
        if (env === undefined) delete process.env.PP_DISABLE_NPX_VALIDATORS;
        else process.env.PP_DISABLE_NPX_VALIDATORS = env;
      }
    }

    // ─── tokens_build: scalar at non-leaf position → violation. ─────────────
    {
      const BAD_TOKENS = JSON.stringify({
        color: { primary: "#0B1220" }, // missing { value: ... } wrap
      });
      const env = process.env.PP_DISABLE_NPX_VALIDATORS;
      process.env.PP_DISABLE_NPX_VALIDATORS = "1";
      try {
        const run = await callTool(client, "start_run", { request_text: "av-smoke tokens bad", project_path: projectPath, mode: "single" });
        const stage = await callTool(client, "start_stage", { run_id: run.run_id, kind: "design_system", gate_type: "design" });
        const att = await callTool(client, "record_attempt", {
          stage_id: stage.stage_id, producer: "claude", model_id: "claude-opus-4-7",
          tokens_in: 1, tokens_out: 1, cost_usd: 0.0001, status: "ok",
        });
        await callTool(client, "archive_artifact", {
          run_id: run.run_id, stage_id: stage.stage_id, kind: "design_tokens",
          relative_path: "design_system/tokens-bad.json", bytes: BAD_TOKENS,
        });
        await callTool(client, "record_verdict", {
          attempt_id: att.attempt_id, judge_producer: "claude", judge_model_id: "claude-sonnet-4-6",
          outcome: "pass",
          critique_md: "Bad tokens (raw scalar at non-leaf position). Validator should catch the missing { value: ... } wrap. Anti-vacuous-pass guard text continues here to clear the 80-char floor.",
          score_json: { tokenization: 0.4 },
        });
        const v = await callTool(client, "artifact_validate", { stage_id: stage.stage_id, kind: "tokens_build" });
        if (v.status !== "violation") throw new Error(`expected violation, got ${pretty(v)}`);
        console.log(`✓ artifact_validate tokens_build (bad) → violation: ${v.reason.slice(0, 80)}`);
        await expectThrow(
          () => callTool(client, "finalize_stage", { stage_id: stage.stage_id, status: "passed", winner_attempt_id: att.attempt_id }),
          err => /tokens_build|finalize_stage refused/i.test(err.message),
          "finalize_stage(passed) refused on tokens_build violation",
        );
        await callTool(client, "finalize_stage", { stage_id: stage.stage_id, status: "surfaced", winner_attempt_id: att.attempt_id });
        await callTool(client, "finalize_run", { run_id: run.run_id, status: "surfaced" });
      } finally {
        if (env === undefined) delete process.env.PP_DISABLE_NPX_VALIDATORS;
        else process.env.PP_DISABLE_NPX_VALIDATORS = env;
      }
    }

    // ─── tokens_build: unresolved reference → violation. ────────────────────
    {
      const UNRESOLVED = JSON.stringify({
        color: {
          alias: { value: "{color.does-not-exist}", type: "color" },
        },
      });
      const env = process.env.PP_DISABLE_NPX_VALIDATORS;
      process.env.PP_DISABLE_NPX_VALIDATORS = "1";
      try {
        const run = await callTool(client, "start_run", { request_text: "av-smoke tokens ref", project_path: projectPath, mode: "single" });
        const stage = await callTool(client, "start_stage", { run_id: run.run_id, kind: "design_system", gate_type: "design" });
        const att = await callTool(client, "record_attempt", {
          stage_id: stage.stage_id, producer: "claude", model_id: "claude-opus-4-7",
          tokens_in: 1, tokens_out: 1, cost_usd: 0.0001, status: "ok",
        });
        await callTool(client, "archive_artifact", {
          run_id: run.run_id, stage_id: stage.stage_id, kind: "design_tokens",
          relative_path: "design_system/tokens-ref.json", bytes: UNRESOLVED,
        });
        await callTool(client, "record_verdict", {
          attempt_id: att.attempt_id, judge_producer: "claude", judge_model_id: "claude-sonnet-4-6",
          outcome: "pass",
          critique_md: "Tokens with an unresolved {ref}. Validator should catch the dangling alias. Anti-vacuous-pass guard text continues here to clear the 80-char floor.",
          score_json: { tokenization: 0.5 },
        });
        const v = await callTool(client, "artifact_validate", { stage_id: stage.stage_id, kind: "tokens_build" });
        if (v.status !== "violation") throw new Error(`expected violation, got ${pretty(v)}`);
        if (!/unresolved reference/i.test(v.reason ?? "")) throw new Error(`expected unresolved-reference reason, got: ${v.reason}`);
        console.log(`✓ artifact_validate tokens_build (unresolved ref) → violation`);
        await callTool(client, "finalize_stage", { stage_id: stage.stage_id, status: "surfaced", winner_attempt_id: att.attempt_id });
        await callTool(client, "finalize_run", { run_id: run.run_id, status: "surfaced" });
      } finally {
        if (env === undefined) delete process.env.PP_DISABLE_NPX_VALIDATORS;
        else process.env.PP_DISABLE_NPX_VALIDATORS = env;
      }
    }

    // ─── mermaid_render: artifact with no blocks → verified (nothing to render). ─
    {
      const env = process.env.PP_DISABLE_NPX_VALIDATORS;
      process.env.PP_DISABLE_NPX_VALIDATORS = "1";
      try {
        const run = await callTool(client, "start_run", { request_text: "av-smoke mermaid empty", project_path: projectPath, mode: "single" });
        const stage = await callTool(client, "start_stage", { run_id: run.run_id, kind: "architecture", gate_type: "design" });
        const att = await callTool(client, "record_attempt", {
          stage_id: stage.stage_id, producer: "claude", model_id: "claude-opus-4-7",
          tokens_in: 1, tokens_out: 1, cost_usd: 0.0001, status: "ok",
        });
        await callTool(client, "archive_artifact", {
          run_id: run.run_id, stage_id: stage.stage_id, kind: "c4_diagram",
          relative_path: "architecture/c4-empty.md",
          bytes: "# C4 placeholder\n\nNo diagram yet.\n",
        });
        await callTool(client, "record_verdict", {
          attempt_id: att.attempt_id, judge_producer: "claude", judge_model_id: "claude-sonnet-4-6",
          outcome: "pass",
          critique_md: "Placeholder C4 with no diagram block — validator should accept (nothing to render). Anti-vacuous-pass guard text continues here to clear the 80-char floor.",
          score_json: { coverage: 0.5 },
        });
        const v = await callTool(client, "artifact_validate", { stage_id: stage.stage_id, kind: "mermaid_render" });
        if (v.status !== "verified") throw new Error(`expected verified for empty c4_diagram, got ${pretty(v)}`);
        console.log(`✓ artifact_validate mermaid_render (no blocks) → verified`);
        await callTool(client, "finalize_stage", { stage_id: stage.stage_id, status: "passed", winner_attempt_id: att.attempt_id });
        await callTool(client, "finalize_run", { run_id: run.run_id, status: "complete" });
      } finally {
        if (env === undefined) delete process.env.PP_DISABLE_NPX_VALIDATORS;
        else process.env.PP_DISABLE_NPX_VALIDATORS = env;
      }
    }

    // ─── mermaid_render: empty fenced block → violation. ────────────────────
    {
      const env = process.env.PP_DISABLE_NPX_VALIDATORS;
      process.env.PP_DISABLE_NPX_VALIDATORS = "1";
      try {
        const run = await callTool(client, "start_run", { request_text: "av-smoke mermaid empty fence", project_path: projectPath, mode: "single" });
        const stage = await callTool(client, "start_stage", { run_id: run.run_id, kind: "architecture", gate_type: "design" });
        const att = await callTool(client, "record_attempt", {
          stage_id: stage.stage_id, producer: "claude", model_id: "claude-opus-4-7",
          tokens_in: 1, tokens_out: 1, cost_usd: 0.0001, status: "ok",
        });
        await callTool(client, "archive_artifact", {
          run_id: run.run_id, stage_id: stage.stage_id, kind: "c4_diagram",
          relative_path: "architecture/c4-empty-fence.md",
          bytes: "# C4 with empty fence\n\n```mermaid\n   \n```\n",
        });
        await callTool(client, "record_verdict", {
          attempt_id: att.attempt_id, judge_producer: "claude", judge_model_id: "claude-sonnet-4-6",
          outcome: "pass",
          critique_md: "Mermaid fence is opened but contains only whitespace. Validator must catch this. Anti-vacuous-pass guard text continues here to clear the 80-char floor.",
          score_json: { coverage: 0.4 },
        });
        const v = await callTool(client, "artifact_validate", { stage_id: stage.stage_id, kind: "mermaid_render" });
        if (v.status !== "violation") throw new Error(`expected violation for empty fence, got ${pretty(v)}`);
        console.log(`✓ artifact_validate mermaid_render (empty fence) → violation: ${v.reason.slice(0, 80)}`);
        await callTool(client, "finalize_stage", { stage_id: stage.stage_id, status: "surfaced", winner_attempt_id: att.attempt_id });
        await callTool(client, "finalize_run", { run_id: run.run_id, status: "surfaced" });
      } finally {
        if (env === undefined) delete process.env.PP_DISABLE_NPX_VALIDATORS;
        else process.env.PP_DISABLE_NPX_VALIDATORS = env;
      }
    }

    // ─── mermaid_render: valid block, mmdc disabled → verified (npx-pass off). ─
    {
      const env = process.env.PP_DISABLE_NPX_VALIDATORS;
      process.env.PP_DISABLE_NPX_VALIDATORS = "1";
      try {
        const run = await callTool(client, "start_run", { request_text: "av-smoke mermaid valid", project_path: projectPath, mode: "single" });
        const stage = await callTool(client, "start_stage", { run_id: run.run_id, kind: "architecture", gate_type: "design" });
        const att = await callTool(client, "record_attempt", {
          stage_id: stage.stage_id, producer: "claude", model_id: "claude-opus-4-7",
          tokens_in: 1, tokens_out: 1, cost_usd: 0.0001, status: "ok",
        });
        await callTool(client, "archive_artifact", {
          run_id: run.run_id, stage_id: stage.stage_id, kind: "c4_diagram",
          relative_path: "architecture/c4-valid.md",
          bytes: "# C4\n\n```mermaid\nflowchart LR\n  A --> B\n```\n",
        });
        await callTool(client, "record_verdict", {
          attempt_id: att.attempt_id, judge_producer: "claude", judge_model_id: "claude-sonnet-4-6",
          outcome: "pass",
          critique_md: "Mermaid block has plausible content; with mmdc disabled the validator falls back to in-process structural acceptance. Anti-vacuous-pass guard text continues here to clear the floor.",
          score_json: { coverage: 0.85 },
        });
        const v = await callTool(client, "artifact_validate", { stage_id: stage.stage_id, kind: "mermaid_render" });
        if (v.status !== "verified") throw new Error(`expected verified, got ${pretty(v)}`);
        console.log(`✓ artifact_validate mermaid_render (valid block, mmdc off) → verified`);
        await callTool(client, "finalize_stage", { stage_id: stage.stage_id, status: "passed", winner_attempt_id: att.attempt_id });
        await callTool(client, "finalize_run", { run_id: run.run_id, status: "complete" });
      } finally {
        if (env === undefined) delete process.env.PP_DISABLE_NPX_VALIDATORS;
        else process.env.PP_DISABLE_NPX_VALIDATORS = env;
      }
    }

    // ─── c4_render: markdown artifact without PlantUML → verified (deferred). ─
    {
      const run = await callTool(client, "start_run", { request_text: "av-smoke c4 deferred", project_path: projectPath, mode: "single" });
      const stage = await callTool(client, "start_stage", { run_id: run.run_id, kind: "architecture", gate_type: "design" });
      const att = await callTool(client, "record_attempt", {
        stage_id: stage.stage_id, producer: "claude", model_id: "claude-opus-4-7",
        tokens_in: 1, tokens_out: 1, cost_usd: 0.0001, status: "ok",
      });
      await callTool(client, "archive_artifact", {
        run_id: run.run_id, stage_id: stage.stage_id, kind: "c4_diagram",
        relative_path: "architecture/c4-mermaid.md",
        bytes: "# C4\n\n```mermaid\nC4Context\n  Person(u, \"User\")\n  System(s, \"Service\")\n  Rel(u, s, \"uses\")\n```\n",
      });
      await callTool(client, "record_verdict", {
        attempt_id: att.attempt_id, judge_producer: "claude", judge_model_id: "claude-sonnet-4-6",
        outcome: "pass",
        critique_md: "C4 diagram in Mermaid form; PlantUML validator should defer to mermaid_render coverage. Anti-vacuous-pass guard text continues here to clear the 80-char floor.",
        score_json: { coverage: 0.9 },
      });
      const v = await callTool(client, "artifact_validate", { stage_id: stage.stage_id, kind: "c4_render" });
      if (v.status !== "verified") throw new Error(`expected verified (deferred to mermaid_render), got ${pretty(v)}`);
      if (!/mermaid_render/.test(v.reason ?? "")) throw new Error(`expected reason to mention mermaid_render coverage, got: ${v.reason}`);
      console.log(`✓ artifact_validate c4_render (markdown without PlantUML) → verified (deferred)`);
      // Note: finalize_stage doesn't demand c4_render (not in defaults), so it's enough to call mermaid_render too:
      await callTool(client, "artifact_validate", { stage_id: stage.stage_id, kind: "mermaid_render" });
      await callTool(client, "finalize_stage", { stage_id: stage.stage_id, status: "passed", winner_attempt_id: att.attempt_id });
      await callTool(client, "finalize_run", { run_id: run.run_id, status: "complete" });
    }

    // ─── c4_render: .puml artifact, no java/plantuml on box → skipped. ──────
    {
      const run = await callTool(client, "start_run", { request_text: "av-smoke c4 puml skip", project_path: projectPath, mode: "single" });
      const stage = await callTool(client, "start_stage", { run_id: run.run_id, kind: "architecture", gate_type: "design" });
      const att = await callTool(client, "record_attempt", {
        stage_id: stage.stage_id, producer: "claude", model_id: "claude-opus-4-7",
        tokens_in: 1, tokens_out: 1, cost_usd: 0.0001, status: "ok",
      });
      await callTool(client, "archive_artifact", {
        run_id: run.run_id, stage_id: stage.stage_id, kind: "c4_diagram",
        relative_path: "architecture/system.puml",
        bytes: "@startuml\nactor User as u\nrectangle Service as s\nu --> s : uses\n@enduml\n",
      });
      await callTool(client, "record_verdict", {
        attempt_id: att.attempt_id, judge_producer: "claude", judge_model_id: "claude-sonnet-4-6",
        outcome: "pass",
        critique_md: "PlantUML form of the same diagram. On a box without java+PLANTUML_JAR the validator should skip (non-blocking). Anti-vacuous-pass guard text continues here to clear the floor.",
        score_json: { coverage: 0.9 },
      });
      // Hide PLANTUML_JAR if it happens to be set so this is deterministic.
      const savedJar = process.env.PLANTUML_JAR;
      delete process.env.PLANTUML_JAR;
      try {
        const v = await callTool(client, "artifact_validate", { stage_id: stage.stage_id, kind: "c4_render" });
        // Either skipped (no plantuml/java) OR verified (host has plantuml installed). Both acceptable.
        if (!["skipped", "verified", "violation"].includes(v.status)) {
          throw new Error(`unexpected status for .puml: ${pretty(v)}`);
        }
        console.log(`✓ artifact_validate c4_render (.puml) → ${v.status}${v.reason ? `: ${v.reason.slice(0, 80)}` : ""}`);
      } finally {
        if (savedJar !== undefined) process.env.PLANTUML_JAR = savedJar;
      }
      // c4_render is not in DEFAULT_VALIDATOR_BINDINGS, so we still need the
      // mermaid_render call (auto-bound for c4_diagram) before finalize_stage.
      await callTool(client, "artifact_validate", { stage_id: stage.stage_id, kind: "mermaid_render" });
      await callTool(client, "finalize_stage", { stage_id: stage.stage_id, status: "passed", winner_attempt_id: att.attempt_id });
      await callTool(client, "finalize_run", { run_id: run.run_id, status: "complete" });
    }

    // ─── c4_render: profile-strict promotion turns 'skipped' into hard fail. ─
    {
      const strictProj = makeRuntimeProject(runtimeRoot, "strict-project");
      mkdirSync(join(strictProj, ".harness"), { recursive: true });
      writeFileSync(join(strictProj, ".harness", "profile.yaml"), [
        "name: api-platform",
        "description: smoke override",
        "required_validators:",
        "  c4_diagram: [c4_render]",
        "required_validators_strict: [c4_render]",
        "",
      ].join("\n"));

      const run = await callTool(client, "start_run", { request_text: "av-smoke c4 strict", project_path: strictProj, mode: "single" });
      const stage = await callTool(client, "start_stage", { run_id: run.run_id, kind: "architecture", gate_type: "design" });
      const att = await callTool(client, "record_attempt", {
        stage_id: stage.stage_id, producer: "claude", model_id: "claude-opus-4-7",
        tokens_in: 1, tokens_out: 1, cost_usd: 0.0001, status: "ok",
      });
      await callTool(client, "archive_artifact", {
        run_id: run.run_id, stage_id: stage.stage_id, kind: "c4_diagram",
        relative_path: "architecture/strict.puml",
        bytes: "@startuml\nactor U\nrectangle S\nU --> S\n@enduml\n",
      });
      await callTool(client, "record_verdict", {
        attempt_id: att.attempt_id, judge_producer: "claude", judge_model_id: "claude-sonnet-4-6",
        outcome: "pass",
        critique_md: "Strict-opt-in test: validator skipped should be promoted to execution_error and block finalize. Anti-vacuous-pass guard text continues here to clear the floor.",
        score_json: { coverage: 0.9 },
      });
      const savedJar = process.env.PLANTUML_JAR;
      delete process.env.PLANTUML_JAR;
      try {
        const v = await callTool(client, "artifact_validate", { stage_id: stage.stage_id, kind: "c4_render" });
        // On a host with plantuml installed this would return verified; in that
        // case the strict-promotion test is not exercised. Skip the assertion
        // gracefully so the suite isn't host-dependent.
        if (v.status === "skipped" || v.status === "execution_error") {
          if (v.status === "skipped") throw new Error(`strict-promotion failed: expected execution_error, got skipped (${pretty(v)})`);
          console.log(`✓ artifact_validate c4_render (strict) → execution_error (skipped→promoted)`);
          // Also need mermaid_render for the c4_diagram artifact (default binding).
          await callTool(client, "artifact_validate", { stage_id: stage.stage_id, kind: "mermaid_render" });
          await expectThrow(
            () => callTool(client, "finalize_stage", { stage_id: stage.stage_id, status: "passed", winner_attempt_id: att.attempt_id }),
            err => /c4_render|finalize_stage refused/i.test(err.message),
            "finalize_stage(passed) refused on strict-promoted c4_render execution_error",
          );
          await callTool(client, "finalize_stage", { stage_id: stage.stage_id, status: "surfaced", winner_attempt_id: att.attempt_id });
        } else {
          console.log(`(skipping strict-promotion assertion: host has plantuml installed; status=${v.status})`);
          await callTool(client, "artifact_validate", { stage_id: stage.stage_id, kind: "mermaid_render" });
          await callTool(client, "finalize_stage", { stage_id: stage.stage_id, status: v.status === "verified" ? "passed" : "surfaced", winner_attempt_id: att.attempt_id });
        }
      } finally {
        if (savedJar !== undefined) process.env.PLANTUML_JAR = savedJar;
      }
      await callTool(client, "finalize_run", { run_id: run.run_id, status: "surfaced" });
    }

    console.log("\nALL ARTIFACT-VALIDATOR SMOKE CHECKS PASSED");
  } finally {
    await client.close();
    rmSync(runtimeRoot, { recursive: true, force: true });
  }
}

main().catch(err => {
  console.error("AV SMOKE FAILED:", err);
  process.exit(1);
});
