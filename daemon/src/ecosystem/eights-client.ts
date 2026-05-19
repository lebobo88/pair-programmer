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
  type HydraEnvelopeType,
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

export type MemoryAddInput = {
  envelope: EightsEnvelope;
  content: string;
  type: "episode" | "artifact" | "evaluation" | "incident" | "summary" | "proposal" | "decision-record";
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
  k?: number;
  type?: MemoryAddInput["type"];
  cell?: EightCell;
  project_id?: string;
};

export type AuditTraceInput = {
  run_id: string;
  artifact_id: string;
  sha256: string;
  parent_artifact_ids?: string[];
  generator_agent?: string;
  model_id?: string;
  model_version?: string;
};

export type ConstitutionAttestInput = {
  project_id: string;
  run_id: string;
  artifact_shas: string[];
  constitution_sha: string;
};

export type HydraEnvelopeRecordInput = {
  envelope_id: string;
  workflow_id: string;
  type: HydraEnvelopeType | "DECISION_RECORD" | "CreativeBrief";
  origin_squad: string;
  target_squad?: string;
  payload: Record<string, unknown>;
};

export type EvolutionProposeInput = {
  envelope: EightsEnvelope;
  resource_rid: string;
  candidate_version: string;
  justification: string;
};

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
  const explicit = process.env.PP_EIGHTS_DAEMON;
  if (explicit && existsSync(explicit)) {
    return { command: process.execPath, args: [explicit, "mcp"] };
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
    // Sanity-check: listTools must include at least one eights.* namespace.
    const tools = await withTimeout(client.listTools(), ECOSYSTEM_PROBE_TIMEOUT_MS);
    const names = (tools.tools ?? []).map(t => t.name);
    const hasMemory = names.some(n => n.startsWith("memory.") || n === "memory.add");
    if (!hasMemory) {
      state = { kind: "unavailable", reason: "no memory.* tool surface" };
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
      client.callTool({ name: toolName, arguments: args }),
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
    return safeCall("memory", "memory.add", input as unknown as Record<string, unknown>);
  },
  search(input: MemorySearchInput): Promise<{ results: Array<Record<string, unknown>> } | null> {
    return safeCall("memory", "memory.search", input as unknown as Record<string, unknown>);
  },
  resolveBatch(handles: string[]): Promise<{ memories: Array<Record<string, unknown>> } | null> {
    return safeCall("memory", "memory.resolve_batch", { handles });
  },
};

export const evolution = {
  propose(input: EvolutionProposeInput): Promise<{ proposal_id: string; status: string } | null> {
    return safeCall("evolution", "evolution.propose", input as unknown as Record<string, unknown>);
  },
  listPending(project_id: string): Promise<{ proposals: Array<Record<string, unknown>> } | null> {
    return safeCall("evolution", "evolution.list_pending", { project_id });
  },
};

export const audit = {
  trace(input: AuditTraceInput): Promise<{ trace_id: string } | null> {
    return safeCall("audit", "audit.trace", input as unknown as Record<string, unknown>);
  },
  bom(run_id: string): Promise<{ bom_handle: string } | null> {
    return safeCall("audit", "audit.bom", { run_id });
  },
  verify(run_id: string): Promise<{ verified: boolean; broken_links?: string[] } | null> {
    return safeCall("audit", "audit.verify", { run_id });
  },
};

export const constitution = {
  get(project_id: string): Promise<{ sha: string; body: string } | null> {
    return safeCall("constitution", "constitution.get", { project_id });
  },
  attest(input: ConstitutionAttestInput): Promise<{ attestation_id: string; verdict: "pass" | "fail" } | null> {
    return safeCall("constitution", "constitution.attest", input as unknown as Record<string, unknown>);
  },
};

export const cells = {
  classify(content: string): Promise<{ cell: EightCell; confidence: number } | null> {
    return safeCall("cells", "cells.classify", { content });
  },
};

export const hydra = {
  envelopeRecord(input: HydraEnvelopeRecordInput): Promise<{ recorded: boolean } | null> {
    return safeCall("hydra", "hydra.envelope.record", input as unknown as Record<string, unknown>);
  },
  envelopeQuery(workflow_id: string): Promise<{ envelopes: Array<Record<string, unknown>> } | null> {
    return safeCall("hydra", "hydra.envelope.query", { workflow_id });
  },
};

export const governance = {
  budgetCharge(run_id: string, kind: string, delta: number): Promise<{ total: number; cap?: number } | null> {
    return safeCall("governance", "governance.budget.charge", { run_id, kind, delta });
  },
  hitlRequest(payload: Record<string, unknown>): Promise<{ request_id: string } | null> {
    return safeCall("governance", "governance.hitl.request", payload);
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
