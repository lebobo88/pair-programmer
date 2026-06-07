/**
 * eights-client — pp's single point of contact with TheEights memory +
 * governance + evolution fabric.
 *
 * Design invariants (Phase A spine):
 *   1. **Best-effort, never throws.** Every wrapper resolves to a typed value
 *      or `null`. pp callers MUST tolerate null without altering behavior;
 *      that's how graceful degradation is enforced.
 *   2. **One probe, cached for the session.** We try once to resolve and
 *      connect to the eights-daemon at first use; if that fails the client
 *      stays in degraded mode for the life of the process. No retry-in-loop.
 *   3. **Per-namespace circuit breaker.** Even when the daemon is reachable,
 *      a flaky tool (e.g., `cells.classify` LLM backend offline) will not
 *      poison sibling calls. After ECOSYSTEM_BREAKER_THRESHOLD consecutive
 *      failures the namespace is muted for ECOSYSTEM_BREAKER_COOLDOWN_MS.
 *   4. **No structural runtime dependency on TheEights.** If the eights
 *      executable isn't installed pp continues to compile, start, and run
 *      every existing flow. Tests under graceful-degradation MUST pass.
 *
 * What's deliberately NOT in this module:
 *   - Schema knowledge of any specific TheEights table. Callers pass payloads
 *     that this module forwards as opaque MCP tool arguments.
 *   - Persistence. Returned memory ids / handles are persisted by callers in
 *     the pp DB (artifacts.eights_memory_id, runs.eights_episodic_handle).
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { log } from "../util/logger.js";
import {
  ECOSYSTEM_PROBE_TIMEOUT_MS,
  ECOSYSTEM_BREAKER_THRESHOLD,
  ECOSYSTEM_BREAKER_COOLDOWN_MS,
  ECOSYSTEM_CALL_TIMEOUT_MS,
  type EightCell,
  type HydraRecordEnvelopeType,
} from "../config.js";

// ─── Public types ────────────────────────────────────────────────────────

/**
 * Caller-supplied envelope. TheEights wraps every memory write / read with
 * this tenant + actor + project + scope context. pp fills it in at the call
 * site from the active run's project_path and run_id. Mirrors the shape of
 * TheEights' `Envelope` type but kept structural to avoid coupling.
 */
export type EightsEnvelope = {
  tenant_id: string;        // "local" by default; pp does not yet multi-tenant
  actor_id: string;         // "pp-daemon" or the active agent slug
  project_id: string;       // typically the project_path basename
  domain: string;           // "code" (pp's domain)
  scope: string[];          // e.g., ["public"] | ["sensitive:no", "team:feature-team"]
  trace_id: string;         // run_id (OTEL-compatible)
};

/**
 * TheEights' MemoryType zod enum is `working|episodic|semantic|procedural|meta`
 * (schemas/memory.ts). pp's earlier Phase-A vocabulary
 * (episode|artifact|evaluation|…) never matched and would have been rejected
 * by AddArgs.type validation the moment a real daemon was reached. We adopt
 * TheEights' enum verbatim so writes validate.
 */
export type EightsMemoryType =
  | "working" | "episodic" | "semantic" | "procedural" | "meta";

export type MemoryAddInput = {
  envelope: EightsEnvelope;
  content: string;
  type: EightsMemoryType;
  summary?: string;
  scopes?: string[];
  provenance: { run_id?: string; actor: string; model?: string; source_uri?: string };
  cell?: EightCell;
  handle?: string;
  supersedes?: string[];
  confidence?: number;
};

export type MemorySearchInput = {
  envelope: EightsEnvelope;
  query: string;
  /** TheEights SearchArgs caps top_k at 100. Mapped to `top_k` at the boundary. */
  k?: number;
  /** TheEights SearchArgs.types is an array of MemoryType. */
  types?: EightsMemoryType[];
  scopes?: string[];
};

/**
 * Audit trace is a READ/query tool in TheEights (audit.ts TraceArgs):
 * `{trace_id?, run_id?, kind?, limit}` — NO envelope, no artifact-sha write.
 * pp previously sent a write-shaped payload that the daemon silently treated
 * as an over-spec'd query (extra keys are dropped by zod's default object
 * parse). Artifact provenance is recorded via `audit.bom` / the memory fabric;
 * this wrapper only queries the event ledger.
 */
export type AuditTraceInput = {
  trace_id?: string;
  run_id?: string;
  kind?: string;
  limit?: number;
};

/**
 * Constitution attest in TheEights (constitution.ts AttestArgs) is
 * `{envelope, consumer}` — it binds a *consumer* (e.g. "pp") to the current
 * constitution and returns a hash-chained receipt. It does NOT take artifact
 * shas; the local pp constitution check remains authoritative for refusal.
 */
export type ConstitutionAttestInput = {
  envelope: EightsEnvelope;
  consumer: string;
};

export type HydraEnvelopeRecordInput = {
  envelope_id: string;
  workflow_id: string;
  /**
   * Must be a member of TheEights' HydraEnvelopeType enum
   * (schemas/hydra-envelope.ts): C_SUITE_DECISION_PACKET | PRD | ArchRFC |
   * DevTask | CreativeBrief | ShotList | AssetJob | DecisionRecord |
   * HITLRequest | Handoff. Note `DecisionRecord` (NOT `DECISION_RECORD`).
   */
  type: HydraRecordEnvelopeType;
  origin_squad: string;
  target_squad?: string;
  parent_id?: string;
  /**
   * Type-specific body. The hydra_envelope zod object is `.passthrough()`, so
   * these fields are spread directly onto `hydra_envelope` to mirror exactly
   * how Hydra writes/reads envelopes (hydra_core/eights/attestation.py
   * envelope_record + query). pp and Hydra MUST write the same shape.
   */
  payload: Record<string, unknown>;
};

export type EvolutionProposeInput = {
  envelope: EightsEnvelope;
  /** TheEights ProposeArgs uses `rid` + `candidate_content`, not resource_rid/candidate_version. */
  rid: string;
  candidate_content: string;
  justification: string;
  evidence_memory_ids?: string[];
};

export type CellsClassifyInput = {
  envelope: EightsEnvelope;
  text: string;
  summary?: string;
};

export type BudgetChargeInput = {
  envelope: EightsEnvelope;
  run_id: string;
  cost_usd: number;
  tokens?: number;
};

export type HitlRequestInput = {
  envelope: EightsEnvelope;
  run_id?: string;
  kind: string;
  payload: unknown;
};

// ─── TheEights tool-name contract ────────────────────────────────────────

/**
 * TheEights namespaces every MCP tool under `eights.*` (e.g. `eights.memory.add`,
 * `eights.hydra.envelope.record`) and has since v0.2.0. pp's Phase-A spine was
 * written against bare names (`memory.add`) which never matched the real surface,
 * so the connect probe always failed and the client lived permanently in
 * degraded mode. We prefix the canonical bare names at the single call boundary
 * (`safeCall`) so the rest of the module reads against the logical tool names.
 */
const EIGHTS_TOOL_PREFIX = "eights.";

function eightsTool(bareName: string): string {
  return `${EIGHTS_TOOL_PREFIX}${bareName}`;
}

/**
 * TheEights' `handle` field is validated against the MemoryHandle URI regex
 * (schemas/memory-handle.ts): it MUST match `^(ep|sem|proc|meta|mem)://...`.
 * pp's historical handles (`pp:run:<id>`, `pp:artifact:<sha>`, `pp:verdict:<id>`)
 * are NOT URIs and were silently rejected by AddArgs the moment a real daemon
 * was reached (that is the memory.add recorded:false failure this fix closes).
 *
 * We normalize any non-URI handle to the opaque `mem://` scheme, which is the
 * canonical fallback. This keeps pp's deterministic, human-readable handle
 * bodies (so supersedes-by-handle chains still converge) while satisfying the
 * schema: `pp:run:abc` → `mem://pp:run:abc`.
 */
const HANDLE_URI_RE = /^(ep|sem|proc|meta|mem):\/\/.+/;
function toMemoryHandleUri(handle: string): string {
  return HANDLE_URI_RE.test(handle) ? handle : `mem://${handle}`;
}

// ─── Namespace breaker state ─────────────────────────────────────────────

type NamespaceKey =
  | "memory" | "evolution" | "audit" | "constitution"
  | "cells" | "hydra" | "governance";

type BreakerState = {
  consecutive_failures: number;
  tripped_until_ms: number | null;
};

const breakers: Record<NamespaceKey, BreakerState> = {
  memory:       { consecutive_failures: 0, tripped_until_ms: null },
  evolution:    { consecutive_failures: 0, tripped_until_ms: null },
  audit:        { consecutive_failures: 0, tripped_until_ms: null },
  constitution: { consecutive_failures: 0, tripped_until_ms: null },
  cells:        { consecutive_failures: 0, tripped_until_ms: null },
  hydra:        { consecutive_failures: 0, tripped_until_ms: null },
  governance:   { consecutive_failures: 0, tripped_until_ms: null },
};

function isBreakerOpen(ns: NamespaceKey): boolean {
  const s = breakers[ns];
  if (s.tripped_until_ms === null) return false;
  if (Date.now() >= s.tripped_until_ms) {
    // Cool-down elapsed; half-open the breaker (one trial permitted).
    s.tripped_until_ms = null;
    s.consecutive_failures = 0;
    return false;
  }
  return true;
}

function recordSuccess(ns: NamespaceKey): void {
  breakers[ns].consecutive_failures = 0;
  breakers[ns].tripped_until_ms = null;
}

function recordFailure(ns: NamespaceKey): void {
  const s = breakers[ns];
  s.consecutive_failures += 1;
  if (s.consecutive_failures >= ECOSYSTEM_BREAKER_THRESHOLD) {
    s.tripped_until_ms = Date.now() + ECOSYSTEM_BREAKER_COOLDOWN_MS;
    log.warn(
      { namespace: ns, cooldown_ms: ECOSYSTEM_BREAKER_COOLDOWN_MS },
      "eights-client: namespace breaker tripped"
    );
  }
}

// ─── Connection state ────────────────────────────────────────────────────

type ClientState =
  | { kind: "uninit" }
  | { kind: "probing"; promise: Promise<boolean> }
  | { kind: "available"; client: Client }
  | { kind: "unavailable"; reason: string };

let state: ClientState = { kind: "uninit" };

/**
 * Read the current state without carrying TypeScript's narrowing from the
 * caller's branch. Needed when we mutate `state` from an awaited probe and
 * then want to re-inspect it; flow analysis can't see through the mutation
 * so a fresh getter call is the cleanest unmarrowing point.
 */
function currentState(): ClientState {
  return state;
}

function resolveDaemonEntry(): { command: string; args: string[] } | null {
  // 1) Explicit override: PP_EIGHTS_DAEMON points at the dist/index.js file.
  //    When set, it is AUTHORITATIVE: if the path is missing we fail closed
  //    (return null → unavailable) rather than silently falling through to a
  //    well-known sibling. An operator who pins a specific daemon must not get
  //    a different one behind their back; this also keeps test isolation honest
  //    (tests point this at a bogus path to force degraded mode).
  const explicit = process.env.PP_EIGHTS_DAEMON;
  if (explicit) {
    return existsSync(explicit)
      ? { command: process.execPath, args: [explicit, "mcp"] }
      : null;
  }
  // 2) EIGHTS_HOME root with conventional layout.
  const homeRoot = process.env.EIGHTS_HOME;
  if (homeRoot) {
    const candidate = join(homeRoot, "daemon", "dist", "index.js");
    if (existsSync(candidate)) {
      return { command: process.execPath, args: [candidate, "mcp"] };
    }
  }
  // 3) Standard sibling layout under <homedir>/.eights/.
  const dotEights = join(homedir(), ".eights", "daemon", "dist", "index.js");
  if (existsSync(dotEights)) {
    return { command: process.execPath, args: [dotEights, "mcp"] };
  }
  // 4) Well-known sibling at C:\AiAppDeployments\TheEights (windows-only;
  //    used during co-development before the user has installed a release).
  const siblingWin = "C:\\AiAppDeployments\\TheEights\\daemon\\dist\\index.js";
  if (existsSync(siblingWin)) {
    return { command: process.execPath, args: [siblingWin, "mcp"] };
  }
  // 5) Fall back to a `eights-daemon` binary on PATH. Spawning will fail
  //    fast if the shim isn't installed; treated as unavailable.
  return { command: "eights-daemon", args: ["mcp"] };
}

async function probe(): Promise<boolean> {
  const entry = resolveDaemonEntry();
  if (!entry) {
    state = { kind: "unavailable", reason: "no eights-daemon entry resolved" };
    return false;
  }
  let transport: StdioClientTransport | null = null;
  try {
    transport = new StdioClientTransport({
      command: entry.command,
      args: entry.args,
    });
    const client = new Client(
      { name: "pp-daemon-eights-client", version: "0.1.0" },
      { capabilities: {} }
    );
    const connectPromise = client.connect(transport);
    const timeout = new Promise<never>((_resolve, reject) =>
      setTimeout(() => reject(new Error("probe timeout")), ECOSYSTEM_PROBE_TIMEOUT_MS)
    );
    await Promise.race([connectPromise, timeout]);
    // Sanity-check: listTools must include at least one eights.memory.* tool.
    // TheEights namespaces every tool under `eights.*` (canonical since v0.2.0),
    // so the memory surface presents as `eights.memory.add` etc.
    const tools = await withTimeout(client.listTools(), ECOSYSTEM_PROBE_TIMEOUT_MS);
    const names = (tools.tools ?? []).map(t => t.name);
    const hasMemory = names.some(n => n.startsWith(`${EIGHTS_TOOL_PREFIX}memory.`));
    if (!hasMemory) {
      state = { kind: "unavailable", reason: "no eights.memory.* tool surface" };
      try { await client.close(); } catch { /* ignore */ }
      return false;
    }
    state = { kind: "available", client };
    log.info({ tool_count: names.length }, "eights-client: connected");
    return true;
  } catch (err) {
    const reason = (err as Error)?.message ?? "unknown error";
    state = { kind: "unavailable", reason };
    log.info({ reason }, "eights-client: TheEights unavailable, pp running standalone");
    if (transport) {
      try { await transport.close(); } catch { /* ignore */ }
    }
    return false;
  }
}

async function ensureReady(): Promise<Client | null> {
  const s0 = currentState();
  if (s0.kind === "available") return s0.client;
  if (s0.kind === "unavailable") return null;
  if (s0.kind === "probing") {
    await s0.promise;
    const s1 = currentState();
    return s1.kind === "available" ? s1.client : null;
  }
  // s0.kind === "uninit" — start a probe and await it.
  const promise = probe();
  state = { kind: "probing", promise };
  await promise;
  const s2 = currentState();
  return s2.kind === "available" ? s2.client : null;
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("eights call timeout")), ms);
    p.then(v => { clearTimeout(t); resolve(v); }, e => { clearTimeout(t); reject(e); });
  });
}

async function safeCall<T = unknown>(
  ns: NamespaceKey,
  toolName: string,
  args: Record<string, unknown>,
): Promise<T | null> {
  if (isBreakerOpen(ns)) return null;
  const client = await ensureReady();
  if (!client) return null;
  try {
    const result = await withTimeout(
      client.callTool({ name: eightsTool(toolName), arguments: args }),
      ECOSYSTEM_CALL_TIMEOUT_MS
    );
    if (result.isError) {
      recordFailure(ns);
      log.debug({ tool: toolName, content: result.content }, "eights-client: tool returned error");
      return null;
    }
    recordSuccess(ns);
    // MCP tool results are an array of content blocks; convention in
    // TheEights (and pp) is one text block carrying JSON.
    const contentArray = (result.content ?? []) as Array<{ type?: string; text?: string }>;
    const text = contentArray[0]?.text;
    return text ? (JSON.parse(text) as T) : null;
  } catch (err) {
    recordFailure(ns);
    log.debug({ tool: toolName, err: (err as Error)?.message }, "eights-client: tool call failed");
    return null;
  }
}

// ─── Public API ──────────────────────────────────────────────────────────

/**
 * Synchronous capability indicator. Returns false until the first probe has
 * completed; callers that need accuracy should `await isAvailable()` instead.
 */
export function isAvailableSync(): boolean {
  return state.kind === "available";
}

/** Async capability probe; triggers the lazy connect if needed. */
export async function isAvailable(): Promise<boolean> {
  const c = await ensureReady();
  return c !== null;
}

/** Force-close the underlying MCP connection (used at daemon shutdown / tests). */
export async function shutdown(): Promise<void> {
  if (state.kind === "available") {
    try { await state.client.close(); } catch { /* ignore */ }
  }
  state = { kind: "uninit" };
  for (const ns of Object.keys(breakers) as NamespaceKey[]) {
    breakers[ns].consecutive_failures = 0;
    breakers[ns].tripped_until_ms = null;
  }
}

/** Reset breaker state without dropping the connection (test hook). */
export function resetBreakersForTesting(): void {
  for (const ns of Object.keys(breakers) as NamespaceKey[]) {
    breakers[ns].consecutive_failures = 0;
    breakers[ns].tripped_until_ms = null;
  }
}

export const memory = {
  add(input: MemoryAddInput): Promise<{ id: string; handle?: string } | null> {
    // AddArgs: { envelope, content, type, summary?, scopes, provenance,
    //   confidence?, supersedes?, handle?, cell? }. `scopes` defaults to []
    //   server-side; we omit undefined optionals so zod defaults apply.
    const args: Record<string, unknown> = {
      envelope: input.envelope,
      content: input.content,
      type: input.type,
      provenance: input.provenance,
    };
    if (input.summary !== undefined) args.summary = input.summary;
    if (input.scopes !== undefined) args.scopes = input.scopes;
    if (input.confidence !== undefined) args.confidence = input.confidence;
    // supersedes references are by handle/id. pp's handle-shaped entries
    // (pp:run:<id>, pp:artifact:<sha>, …) must be coerced to the same mem://
    // URI form `handle` uses so supersede-by-handle resolves; bare memory ids
    // (mem_abc123) and existing scheme URIs pass through toMemoryHandleUri
    // unchanged (it only rewrites strings that don't already match a scheme).
    if (input.supersedes !== undefined) {
      args.supersedes = input.supersedes.map(s =>
        s.startsWith("pp:") ? toMemoryHandleUri(s) : s,
      );
    }
    if (input.handle !== undefined) args.handle = toMemoryHandleUri(input.handle);
    if (input.cell !== undefined) args.cell = input.cell;
    return safeCall("memory", "memory.add", args);
  },
  search(input: MemorySearchInput): Promise<{ results: Array<Record<string, unknown>> } | null> {
    // SearchArgs: { envelope, query, types?, scopes?, top_k (<=100), fusion }.
    // pp's `k` maps to `top_k`; `type` (singular) is dropped in favor of `types`.
    const args: Record<string, unknown> = {
      envelope: input.envelope,
      query: input.query,
    };
    if (input.k !== undefined) args.top_k = input.k;
    if (input.types !== undefined) args.types = input.types;
    if (input.scopes !== undefined) args.scopes = input.scopes;
    return safeCall("memory", "memory.search", args);
  },
  resolveBatch(envelope: EightsEnvelope, handles: string[]): Promise<{ memories: Array<Record<string, unknown>> } | null> {
    // ResolveBatchArgs: { envelope, handles (1..256) }.
    return safeCall("memory", "memory.resolve_batch", { envelope, handles });
  },
};

export const evolution = {
  propose(input: EvolutionProposeInput): Promise<{ proposal_id: string; status: string } | null> {
    // ProposeArgs: { envelope, rid, candidate_content, justification, evidence_memory_ids }.
    return safeCall("evolution", "evolution.propose", {
      envelope: input.envelope,
      rid: input.rid,
      candidate_content: input.candidate_content,
      justification: input.justification,
      evidence_memory_ids: input.evidence_memory_ids ?? [],
    });
  },
  listPending(): Promise<{ proposals: Array<Record<string, unknown>> } | null> {
    // list_pending takes the Empty schema {} — no args.
    return safeCall("evolution", "evolution.list_pending", {});
  },
};

export const audit = {
  /** Query the event ledger. TraceArgs: { trace_id?, run_id?, kind?, limit }. */
  trace(input: AuditTraceInput): Promise<Array<Record<string, unknown>> | null> {
    const args: Record<string, unknown> = {};
    if (input.trace_id !== undefined) args.trace_id = input.trace_id;
    if (input.run_id !== undefined) args.run_id = input.run_id;
    if (input.kind !== undefined) args.kind = input.kind;
    if (input.limit !== undefined) args.limit = input.limit;
    return safeCall("audit", "audit.trace", args);
  },
  bom(envelope: EightsEnvelope, run_id: string): Promise<{ bom_handle: string } | null> {
    return safeCall("audit", "audit.bom", { envelope, run_id });
  },
  verify(): Promise<{ verified: boolean; broken_links?: string[] } | null> {
    // VerifyArgs is the empty object; it verifies the full chain.
    return safeCall("audit", "audit.verify", {});
  },
};

export const constitution = {
  get(envelope: EightsEnvelope, consumer: string): Promise<{ sha: string; body: string } | null> {
    // GetArgs: { envelope, consumer }.
    return safeCall("constitution", "constitution.get", { envelope, consumer });
  },
  attest(input: ConstitutionAttestInput): Promise<{ attestation_id: string; verdict: "pass" | "fail" } | null> {
    // AttestArgs: { envelope, consumer }.
    return safeCall("constitution", "constitution.attest", {
      envelope: input.envelope,
      consumer: input.consumer,
    });
  },
};

export const cells = {
  classify(input: CellsClassifyInput): Promise<{ cell: EightCell } | null> {
    // ClassifyArgs: { envelope, text, summary? }. Note `text`, not `content`.
    const args: Record<string, unknown> = { envelope: input.envelope, text: input.text };
    if (input.summary !== undefined) args.summary = input.summary;
    return safeCall("cells", "cells.classify", args);
  },
};

export const hydra = {
  envelopeRecord(input: HydraEnvelopeRecordInput): Promise<{ recorded: boolean } | null> {
    // RecordArgs: { envelope, hydra_envelope }. hydra_envelope is the
    // HydraEnvelope zod object (.passthrough()): { id, type, origin_squad,
    // target_squad?, workflow_id, parent_id?, context_refs?, constraints?,
    // created_at? } plus passthrough body fields. We spread `payload` onto
    // hydra_envelope to mirror Hydra's own record shape (attestation.py).
    const envelope = envelopeForHydra(input.workflow_id, input.origin_squad);
    const hydra_envelope: Record<string, unknown> = {
      id: input.envelope_id,
      type: input.type,
      origin_squad: input.origin_squad,
      workflow_id: input.workflow_id,
      created_at: new Date().toISOString(),
      ...input.payload,
    };
    if (input.target_squad !== undefined) hydra_envelope.target_squad = input.target_squad;
    if (input.parent_id !== undefined) hydra_envelope.parent_id = input.parent_id;
    // The daemon's HydraEngine.record ack is { envelope_id, memory_id,
    // workflow_id, type } — it has NO `recorded` field. pp's emitters check
    // result.recorded, so a successful record was being read as recorded:false
    // (the report_hydra_completion bug). Normalize: presence of the echoed
    // envelope_id (or id) is the success signal. Returns null only when the
    // daemon is unreachable / the call genuinely failed.
    return safeCall<Record<string, unknown>>("hydra", "hydra.envelope.record", { envelope, hydra_envelope })
      .then(ack => {
        if (ack === null) return null;
        const succeeded = ack.envelope_id !== undefined || ack.id !== undefined;
        return { recorded: succeeded, ...ack } as { recorded: boolean } & Record<string, unknown>;
      });
  },
  envelopeQuery(
    workflow_id: string,
    opts?: { type?: HydraRecordEnvelopeType; target_squad?: string; origin_squad?: string; since?: string; limit?: number },
  ): Promise<Array<Record<string, unknown>> | null> {
    // QueryArgs: { envelope, workflow_id?, type?, target_squad?, origin_squad?, since?, limit? }.
    const envelope = envelopeForHydra(workflow_id, opts?.origin_squad ?? "engineering");
    const args: Record<string, unknown> = { envelope, workflow_id };
    if (opts?.type !== undefined) args.type = opts.type;
    if (opts?.target_squad !== undefined) args.target_squad = opts.target_squad;
    if (opts?.origin_squad !== undefined) args.origin_squad = opts.origin_squad;
    if (opts?.since !== undefined) args.since = opts.since;
    if (opts?.limit !== undefined) args.limit = opts.limit;
    return safeCall("hydra", "hydra.envelope.query", args);
  },
};

export const governance = {
  budgetCharge(input: BudgetChargeInput): Promise<{ total: number; cap?: number } | null> {
    // BudgetChargeArgs: { envelope, run_id, cost_usd, tokens? }.
    const args: Record<string, unknown> = {
      envelope: input.envelope,
      run_id: input.run_id,
      cost_usd: input.cost_usd,
    };
    if (input.tokens !== undefined) args.tokens = input.tokens;
    return safeCall("governance", "governance.budget.charge", args);
  },
  hitlRequest(input: HitlRequestInput): Promise<{ request_id: string } | null> {
    // HitlRequestArgs: { envelope, run_id?, kind, payload }.
    const args: Record<string, unknown> = {
      envelope: input.envelope,
      kind: input.kind,
      payload: input.payload,
    };
    if (input.run_id !== undefined) args.run_id = input.run_id;
    return safeCall("governance", "governance.hitl.request", args);
  },
};

/**
 * Build a default envelope for a pp run. Callers can override any field;
 * trace_id always defaults to run_id so cross-system audit joins work.
 */
export function envelopeFor(params: {
  run_id: string;
  project_path: string;
  actor?: string;
  scope?: string[];
}): EightsEnvelope {
  // basename of the project path is a stable, human-readable project_id;
  // TheEights treats project_id as opaque so collisions are tolerable.
  const project_id =
    params.project_path.split(/[\\/]/).filter(Boolean).pop() ?? params.project_path;
  return {
    tenant_id: "local",
    actor_id: params.actor ?? "pp-daemon",
    project_id,
    domain: "code",
    scope: params.scope ?? ["public"],
    trace_id: params.run_id,
  };
}

/**
 * Build the audit `Envelope` for a Hydra cross-squad envelope record/query.
 * Unlike `envelopeFor` (run-scoped), this is workflow-scoped: trace_id is the
 * workflow_id so cross-consumer audit joins land on the same lineage Hydra's
 * own supervisor uses (hydra_core/eights/attestation.py uses trace_id =
 * workflow_id, domain = orchestration). pp stamps domain "code" since pp is the
 * engineering squad's executor; project_id stays "pair-programmer".
 */
function envelopeForHydra(workflow_id: string, origin_squad: string): EightsEnvelope {
  return {
    tenant_id: "local",
    actor_id: `pp.${origin_squad}`,
    project_id: "pair-programmer",
    domain: "code",
    scope: [],
    trace_id: workflow_id || "no-workflow",
  };
}
