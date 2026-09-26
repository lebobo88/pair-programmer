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
import {
  getDefaultEnvironment,
  StdioClientTransport,
} from "@modelcontextprotocol/sdk/client/stdio.js";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { log } from "../util/logger.js";
import {
  ecosystemProbeTimeoutMs,
  ecosystemIdleCloseMs,
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
  // v10 (J4): judge_model_source / judge_reasoning_effort carry which channel
  // selected the judge model and at what effort, so a memory written from a
  // non-default judge selection is distinguishable from the vendor pin.
  provenance: {
    run_id?: string; actor: string; model?: string; source_uri?: string;
    judge_model_source?: string | null;
    judge_reasoning_effort?: string | null;
  };
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
   * Must be a member of the UPPER_SNAKE canonical vocabulary (Phase 3b).
   * Full set: C_SUITE_DECISION_PACKET | PRD | ARCH_RFC | DEV_TASK |
   * CREATIVE_BRIEF | SHOT_LIST | ASSET_JOB | DECISION_RECORD |
   * HITL_REQUEST | HANDOFF. All values are UPPER_SNAKE — CamelCase aliases
   * are rejected by TheEights' zod schema after the Phase 3b migration.
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
  | { kind: "available"; client: Client; transport: StdioClientTransport }
  | { kind: "unavailable"; reason: string };

let state: ClientState = { kind: "uninit" };

// ─── Process lifecycle (L1B) ─────────────────────────────────────────────
//
// The l1a process inventory (.harness/evidence/eights-process-inventory.md)
// found exactly two runtime paths that reach `probe()`/spawn a TheEights
// child, and each leaks it a different way:
//
//   1. `pp-daemon mcp` (long-lived): torn down via `transport.onclose` /
//      stdin "end" -> `shutdownAndExit` (util/shutdown.ts). That helper
//      aborts CLI children and releases locks but never called
//      `eights-client.shutdown()`, so a connected TheEights child outlived
//      the pp-daemon process that spawned it.
//   2. `pp-daemon hook <event> <name>` (short-lived): every handler ends in
//      `reply()` -> `process.exit()` directly (hooks/dispatcher.ts) — a
//      synchronous, immediate exit that cannot await any async cleanup at
//      all, so `shutdownAndExit` is never even reachable from this path.
//
// Four mechanisms close both gaps with the smallest correct combination:
//
//   (a) IDLE AUTO-CLOSE — `scheduleIdleClose()`/`cancelIdleClose()` below.
//       Fixes path 1's steady-state case: a long-lived `pp-daemon mcp`
//       process that connects once and then sits idle between hook/tool
//       invocations no longer holds the TheEights child open indefinitely;
//       it self-closes after `PP_ECOSYSTEM_IDLE_CLOSE_MS` (config.ts,
//       default 30s) of no in-flight `safeCall`. The timer is `.unref()`'d
//       so its mere existence never keeps the daemon process alive.
//   (b) REF/UNREF THE CHILD WHILE IDLE VS BUSY — `refChild()`/`unrefChild()`
//       below, toggled around every `safeCall`. Fixes path 2's "script just
//       returns from main" shape (see eights-lifecycle.unit.mjs case (i)):
//       the MCP SDK's `StdioClientTransport` refs the spawned child and its
//       stdio pipes by default, which alone would keep a short caller's
//       event loop non-empty (and thus the process alive) even after its
//       one fire-and-forget call resolves and `main()` returns — forcing
//       every such caller to remember an explicit `process.exit()`. We
//       unref the child + its pipes as soon as no call is in flight (and
//       ref them back for the duration of each call, so an in-flight
//       request is never starved of an event-loop tick), so a caller that
//       does one call and returns exits naturally.
//   (c) `shutdownAndExit` AWAITS `eights-client.shutdown()` WITH A BOUNDED
//       TIMEOUT — see util/shutdown.ts. Fixes path 1's teardown case: the
//       graceful MCP `client.close()` path (stdin end -> 2s SIGTERM grace ->
//       SIGKILL, all with the SDK's own `.unref()`'d timers) now actually
//       runs before the daemon process exits, instead of never running at
//       all. The bound is a *separate* cap from `ABORT_TOTAL_CAP_MS` (CLI
//       child abort) — a hung TheEights child must not extend or block that
//       existing, already-tuned budget.
//   (d) BEST-EFFORT SYNCHRONOUS KILL ON `process.exit` — the
//       `process.on("exit", ...)` handler below. Fixes path 2 directly:
//       since `reply()` calls `process.exit()` synchronously with no
//       opportunity for `await`, the *only* place left to reach the child
//       from a hook invocation is Node's synchronous `'exit'` event. This is
//       deliberately best-effort (fire a signal, don't wait for confirmation
//       — `'exit'` handlers cannot run async code) and is also registered as
//       a backstop for path 1 in case (a)/(c) above ever leave a connection
//       open at the moment the process actually exits (e.g. a hung
//       `client.close()` that the (c) timeout gave up on).
//
// Explicitly NOT used: `spawn(..., { detached: false })`-style process-group
// tricks, or killing by PID from a totally separate watchdog process. Both
// add real complexity (process groups behave differently for `cross-spawn`
// on Windows vs POSIX) to solve exactly the two paths above, which (a)-(d)
// already cover with mechanisms already idiomatic to this codebase (unref'd
// timers, bounded awaits, `process.on("exit")`).

let idleCloseTimer: NodeJS.Timeout | null = null;
let inFlightCallCount = 0;

/**
 * The MCP SDK's public `StdioClientTransport` type exposes only `.pid` and
 * `.stderr` (see node_modules/@modelcontextprotocol/sdk/dist/esm/client/
 * stdio.js) — there is no public API to unref, ref, or synchronously signal
 * the spawned child. `_process` is a plain (TypeScript-private-only, not
 * JS-private `#`) field on the class instance; reaching into it is the only
 * way to implement (b) and (d) above. Guarded with try/catch and optional
 * chaining everywhere it's used below: if a future SDK version renames or
 * removes the field this silently degrades to a no-op (the mechanisms above
 * stop firing) rather than throwing — never a crash, and never worse than
 * pp's pre-L1B behavior.
 */
type UnderlyingChild = {
  pid?: number;
  kill?: (signal?: string) => boolean;
  unref?: () => void;
  ref?: () => void;
  stdin?: { unref?: () => void; ref?: () => void } | null;
  stdout?: { unref?: () => void; ref?: () => void } | null;
  stderr?: { unref?: () => void; ref?: () => void } | null;
};

function underlyingChild(transport: StdioClientTransport): UnderlyingChild | null {
  try {
    // ANTI-PATTERN-OK: no public SDK accessor exists for the spawned child
    // (see comment above); this is a deliberate, guarded reach into a known
    // private field, not a shortcut around a typed API that already exists.
    const child = (transport as unknown as { _process?: UnderlyingChild })._process;
    return child ?? null;
  } catch {
    return null;
  }
}

/** (b): unref the connected child + its stdio pipes (no call in flight). */
function unrefChild(): void {
  if (state.kind !== "available") return;
  const child = underlyingChild(state.transport);
  if (!child) return;
  try { child.unref?.(); } catch { /* ignore */ }
  try { child.stdin?.unref?.(); } catch { /* ignore */ }
  try { child.stdout?.unref?.(); } catch { /* ignore */ }
  try { child.stderr?.unref?.(); } catch { /* ignore */ }
}

/** (b): ref the connected child + its stdio pipes (a call is in flight). */
function refChild(): void {
  if (state.kind !== "available") return;
  const child = underlyingChild(state.transport);
  if (!child) return;
  try { child.ref?.(); } catch { /* ignore */ }
  try { child.stdin?.ref?.(); } catch { /* ignore */ }
  try { child.stdout?.ref?.(); } catch { /* ignore */ }
  try { child.stderr?.ref?.(); } catch { /* ignore */ }
}

/** (a): cancel any pending idle-close timer (a call is starting). */
function cancelIdleClose(): void {
  if (idleCloseTimer) {
    clearTimeout(idleCloseTimer);
    idleCloseTimer = null;
  }
}

/** (a): (re)arm the idle-close timer (no call is in flight). */
function scheduleIdleClose(): void {
  cancelIdleClose();
  if (state.kind !== "available") return;
  const ms = ecosystemIdleCloseMs();
  const timer = setTimeout(() => {
    idleCloseTimer = null;
    // Belt-and-suspenders: only close if still idle and still connected —
    // a call that started between scheduling and firing already cancelled
    // this timer via cancelIdleClose(), but guard anyway against any future
    // call site that forgets to.
    if (inFlightCallCount === 0 && state.kind === "available") {
      void shutdown();
    }
  }, ms);
  timer.unref();
  idleCloseTimer = timer;
}

/** (d): best-effort, synchronous — 'exit' handlers cannot await anything. */
process.on("exit", () => {
  if (state.kind !== "available") return;
  const child = underlyingChild(state.transport);
  const pid = child?.pid;
  if (!pid) return;
  try {
    if (child?.kill) child.kill("SIGTERM");
    else process.kill(pid, "SIGTERM");
  } catch { /* best-effort: process may already be gone (ESRCH) */ }
});

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

/**
 * Lenient replacement for the SDK's `ListToolsResultSchema`. The stock schema
 * (`types.js` `ToolSchema.inputSchema`) requires every listed tool's
 * `inputSchema.type` to be the zod literal `"object"`. TheEights' hand-rolled
 * `zodToJsonSchema` (daemon/src/mcp/zod-to-json.ts, TheEights repo) has no
 * case for a top-level `ZodEffects` node — the shape produced by
 * `z.object({...}).refine(...)` — and falls through to `default: return {}`,
 * emitting an `inputSchema` with NO `type` field at all for
 * `eights.evolution.register` (`RegisterArgs`, evolution.ts:24-38). One
 * malformed tool anywhere in TheEights' ~60-tool surface then fails
 * `client.listTools()`'s per-tool zod parse and throws, which `probe()`
 * catches and reports as `unavailable` — indistinguishable from "daemon not
 * running". We only need tool *names* to confirm the `eights.memory.*`
 * surface is present, so we bypass the SDK's strict per-tool validation with
 * our own name-only schema for this one call.
 */
const LenientListToolsResultSchema = z
  .object({
    tools: z.array(z.object({ name: z.string() }).passthrough()),
  })
  .passthrough();

/**
 * The subprocess env is an explicit, exact-name ALLOWLIST layered on top of
 * the MCP SDK's own `getDefaultEnvironment()` baseline (a short OS-inherit
 * safelist — on Windows: APPDATA/HOMEDRIVE/HOMEPATH/LOCALAPPDATA/PATH/
 * PROCESSOR_ARCHITECTURE/SYSTEMDRIVE/SYSTEMROOT/TEMP/USERNAME/USERPROFILE/
 * PROGRAMFILES) — NOT a full parent-env copy and NOT a prefix match.
 * Forwarding the whole parent environment (or an open-ended `EIGHTS_*`
 * prefix) would let any future `EIGHTS_`-prefixed secret or credential name
 * pp doesn't know about leak into a third-party subprocess by construction;
 * an exact list means adding a name is a deliberate, reviewable diff.
 *
 * Every name below is verified against TheEights' own source
 * (`C:\AiAppDeployments\TheEights\daemon\src`, `grep -rnoE
 * 'process\.env(\.|\[["'"'"'])EIGHTS_[A-Z_]+' daemon/src | sort -u`, run
 * 2026-09-25 — this pattern catches BOTH `process.env.X` dot-access AND
 * `process.env["X"]` / `process.env['X']` bracket-access reads; a dot-only
 * pattern previously missed four bracket-access names, corrected here.
 * Full output saved at `.harness/evidence/eights-env-inventory.txt`):
 *
 *   EIGHTS_ALLOW_CLOUD_PROVIDERS       (config.ts:37)
 *   EIGHTS_DB_BLOAT_BYTES              (cognitive/memory-steward.ts:97)
 *   EIGHTS_DISABLE_WATCHERS            (index.ts:277)
 *   EIGHTS_EMBEDDING_DIM               (config.ts:33, embeddings.ts:25)
 *   EIGHTS_EMBEDDING_MODEL             (embeddings.ts:24)
 *   EIGHTS_EMBED_PROVIDER              (config.ts:35)
 *   EIGHTS_EXEC_OUTPUT_ROOT            (engines/execsuite-watcher.ts:36)
 *   EIGHTS_GRAPH_DRIVER                (config.ts:32)
 *   EIGHTS_HOME                        (config.ts:23, index.ts:570, paths.ts:34)
 *   EIGHTS_LLM_COMPLETIONS             (engines/eval/completer.ts:35)
 *   EIGHTS_LLM_FALLBACK                (engines/eval/completer.ts:29)
 *   EIGHTS_LLM_MODEL                   (engines/eval/completer.ts:28)
 *   EIGHTS_LLM_PROVIDER                (config.ts:36)
 *   EIGHTS_LOG_LEVEL                   (logger.ts:10)
 *   EIGHTS_MEMORY_BLOAT_RATE_PER_HOUR  (cognitive/memory-steward.ts:98)
 *   EIGHTS_MEMORY_BLOAT_ROWS           (cognitive/memory-steward.ts:96)
 *   EIGHTS_MEM_GAUGE_MS                (index.ts:430)
 *   EIGHTS_OLLAMA_TIMEOUT_MS           (embeddings.ts:28, engines/eval/completer.ts:32)
 *   EIGHTS_OLLAMA_URL                  (embeddings.ts:23, engines/eval/completer.ts:27)
 *   EIGHTS_OPERATOR_ACTOR_ID           (index.ts:356)
 *   EIGHTS_OTEL_ENABLED                (index.ts:252)
 *   EIGHTS_OTEL_ENDPOINT               (index.ts:253)
 *   EIGHTS_PROVIDER                    (config.ts:34)
 *   EIGHTS_RLM_ROOT                    (engines/rlm-watcher.ts:34)
 *   EIGHTS_SKIP_AUDIT_CHECK            (index.ts:383, cognitive/audit-verifier.ts:49)
 *   EIGHTS_TOOL_DEADLINE_MS            (index.ts:483)
 *   EIGHTS_TOOL_SLOW_WARN_MS           (index.ts:484)
 *   EIGHTS_XENIA_ROOT                  (engines/registrars/xenia-registrar.ts:28,
 *                                       engines/xenia-watcher.ts:40)
 *
 * Plus `AIAPP_BASE` — TheEights' `paths.ts:83` reads it for ecosystem-relative
 * path resolution (the AIAPP_BASE portability convention shared across the
 * AiAppDeployments repos; see MEMORY project_aiapp_base_portability).
 *
 * Explicitly EXCLUDED, even though TheEights reads it: `HYDRA_OPERATOR_KEY`
 * and `HYDRA_OPERATOR_KEY_ID` (TheEights `auth/capability.ts:150,159` —
 * `deriveSigningKey()`/`configuredKeyId()`, used to mint/verify capability
 * tokens). `HYDRA_OPERATOR_KEY` is a signing secret, not ecosystem
 * configuration; forwarding it would hand the spawned subprocess the
 * operator's capability-minting key. Before this allowlist existed the SDK's
 * own default env (`getDefaultEnvironment()`) never forwarded it either — this
 * is a defended exclusion, not a functional regression. If TheEights ever
 * requires this daemon to mint capability tokens, that needs an explicit,
 * separately-reviewed decision, not an accidental sweep-in via a namespace or
 * prefix match.
 *
 * Everything else — credentials, unrelated API keys, other tools'
 * configuration, and any `EIGHTS_`-prefixed name not cited above — is
 * intentionally NOT forwarded. Adding a name to this list requires a fresh
 * grep citation against TheEights' source, not just a prefix match.
 */
const EIGHTS_FORWARDED_ENV_VARS = Object.freeze([
  "EIGHTS_ALLOW_CLOUD_PROVIDERS",
  "EIGHTS_DB_BLOAT_BYTES",
  "EIGHTS_DISABLE_WATCHERS",
  "EIGHTS_EMBEDDING_DIM",
  "EIGHTS_EMBEDDING_MODEL",
  "EIGHTS_EMBED_PROVIDER",
  "EIGHTS_EXEC_OUTPUT_ROOT",
  "EIGHTS_GRAPH_DRIVER",
  "EIGHTS_HOME",
  "EIGHTS_LLM_COMPLETIONS",
  "EIGHTS_LLM_FALLBACK",
  "EIGHTS_LLM_MODEL",
  "EIGHTS_LLM_PROVIDER",
  "EIGHTS_LOG_LEVEL",
  "EIGHTS_MEMORY_BLOAT_RATE_PER_HOUR",
  "EIGHTS_MEMORY_BLOAT_ROWS",
  "EIGHTS_MEM_GAUGE_MS",
  "EIGHTS_OLLAMA_TIMEOUT_MS",
  "EIGHTS_OLLAMA_URL",
  "EIGHTS_OPERATOR_ACTOR_ID",
  "EIGHTS_OTEL_ENABLED",
  "EIGHTS_OTEL_ENDPOINT",
  "EIGHTS_PROVIDER",
  "EIGHTS_RLM_ROOT",
  "EIGHTS_SKIP_AUDIT_CHECK",
  "EIGHTS_TOOL_DEADLINE_MS",
  "EIGHTS_TOOL_SLOW_WARN_MS",
  "EIGHTS_XENIA_ROOT",
  "AIAPP_BASE",
]);

function scopedEightsEnv(): Record<string, string> {
  const env: Record<string, string> = { ...getDefaultEnvironment() };
  for (const name of EIGHTS_FORWARDED_ENV_VARS) {
    const v = process.env[name];
    if (v !== undefined) env[name] = v;
  }
  return env;
}

/**
 * Regression guard (cross-vendor judge finding, 2026-09-25): before the
 * listTools() lenient-schema fix (1385c2c), probe() failed FAST against a
 * real TheEights install because the strict schema threw on TheEights'
 * malformed `eights.evolution.register` tool -- so pp's unit tests that
 * exercise runs.ts code paths calling the eights-writes.ts fire-and-forget
 * helpers (archiveArtifact/recordVerdict/finalizeRun -> memory.add etc.,
 * never awaited) got "unavailable" near-instantly and moved on. Once probe()
 * started tolerating the malformed schema, those same fire-and-forget calls
 * could reach and actually CONNECT to a real TheEights daemon (the
 * `C:\AiAppDeployments\TheEights` sibling-fallback in resolveDaemonEntry()
 * step 4 exists on dev boxes) -- and because a fire-and-forget caller never
 * calls `shutdown()`, the spawned child was left running, holding its
 * parent `node --test` file's process alive past every synchronous
 * assertion until the file's own test-runner timeout killed it. Reproduced
 * directly: `[eights-daemon] booting pid=...` in a unit test's own log, with
 * that pid still alive when node forcibly cancelled the file.
 *
 * `PP_ECOSYSTEM_DISABLED=1` short-circuits probe() to "unavailable" before
 * `resolveDaemonEntry()` is even called -- no transport is constructed, no
 * subprocess is spawned, period. `scripts/run-tests.mjs` sets this for the
 * batched `*.unit.mjs` run (alongside its existing PP_DB_PATH/PP_HOME
 * scrub); a unit test that legitimately needs to exercise probe() against a
 * fixture or a real daemon (eights-client-listtools.unit.mjs,
 * eights-integration.smoke.mjs) explicitly clears it first, the same way
 * those files already set PP_EIGHTS_DAEMON before importing dist/.
 */
const ECOSYSTEM_DISABLED_REASON = "ecosystem probe disabled (PP_ECOSYSTEM_DISABLED=1)";
function ecosystemProbeDisabled(): boolean {
  return process.env.PP_ECOSYSTEM_DISABLED === "1";
}

async function probe(): Promise<boolean> {
  if (ecosystemProbeDisabled()) {
    state = { kind: "unavailable", reason: ECOSYSTEM_DISABLED_REASON };
    return false;
  }
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
      env: scopedEightsEnv(),
    });
    const client = new Client(
      { name: "pp-daemon-eights-client", version: "0.1.0" },
      { capabilities: {} }
    );
    const probeTimeoutMs = ecosystemProbeTimeoutMs();
    // L1B: previously a raw `Promise.race([connectPromise, timeout])` whose
    // `timeout` promise's `setTimeout` was NEVER cleared when `connectPromise`
    // won the race — a real, non-`.unref()`'d timer left running for the
    // full `probeTimeoutMs` (production default 3000ms, but test suites that
    // widen it for concurrent-spawn tolerance push this well past 10s) after
    // every successful connect. On its own this only delayed process exit by
    // a few seconds, but combined with mechanism (b) below (which correctly
    // unrefs the child) a short-lived caller would still hang until this
    // stray timer fired — `withTimeout()` (defined below) already clears its
    // internal timer via `clearTimeout` in both the resolve and reject
    // branches, so reusing it here closes the leak the same way `probe()`'s
    // own `tools/list` call two lines down already relies on it.
    await withTimeout(client.connect(transport), probeTimeoutMs);
    // Sanity-check: listTools must include at least one eights.memory.* tool.
    // TheEights namespaces every tool under `eights.*` (canonical since v0.2.0),
    // so the memory surface presents as `eights.memory.add` etc. Uses the raw
    // request + lenient schema above (see comment) instead of
    // `client.listTools()` so one malformed tool elsewhere in TheEights'
    // surface can't fail the whole probe.
    const tools = await withTimeout(
      client.request({ method: "tools/list", params: {} }, LenientListToolsResultSchema),
      probeTimeoutMs
    );
    const names = (tools.tools ?? []).map(t => t.name);
    const hasMemory = names.some(n => n.startsWith(`${EIGHTS_TOOL_PREFIX}memory.`));
    if (!hasMemory) {
      state = { kind: "unavailable", reason: "no eights.memory.* tool surface" };
      try { await client.close(); } catch { /* ignore */ }
      return false;
    }
    state = { kind: "available", client, transport };
    log.info({ tool_count: names.length }, "eights-client: connected");
    // (b)/(a): freshly connected, no call in flight yet — unref immediately
    // and arm the idle-close timer so a caller that never issues another
    // call (or a script that does one and returns) doesn't keep this
    // process alive on the strength of the eights child alone.
    unrefChild();
    scheduleIdleClose();
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
  // (a)/(b): a call is starting — cancel the idle-close timer and ref the
  // child back so this in-flight request is never starved of an event-loop
  // tick or raced by a self-close. Always restored in `finally` below.
  cancelIdleClose();
  refChild();
  inFlightCallCount += 1;
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
  } finally {
    // (a)/(b): call settled — if nothing else is in flight, unref the child
    // again and re-arm the idle-close timer.
    inFlightCallCount = Math.max(0, inFlightCallCount - 1);
    if (inFlightCallCount === 0) {
      unrefChild();
      scheduleIdleClose();
    }
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
  // (a): whether this call came from the idle timer firing or an explicit
  // caller (shutdownAndExit, a test), cancel any pending timer so it can't
  // fire again against the now-reset state.
  cancelIdleClose();
  inFlightCallCount = 0;
  if (state.kind === "available") {
    // (b): re-ref the child for the duration of this explicit, awaited
    // close. If the connection was idle (the common case — shutdown() is
    // usually called with no call in flight), (a)/(b) already unref'd the
    // child; without re-referencing it here, this awaited `close()` races
    // against Node's own "nothing left ref'd, may as well finish the tick"
    // exit heuristic and can lose — the caller's `await shutdown()` would
    // then never observe the graceful close complete even though the
    // underlying 'close' event does eventually fire. An explicit shutdown is
    // exactly the kind of "operation in flight" (b)'s ref/unref toggle
    // exists to protect.
    refChild();
    // client.close() -> transport.close() already performs the graceful
    // stdin-end -> 2s SIGTERM grace -> 2s SIGKILL fallback sequence with its
    // own .unref()'d timers (MCP SDK stdio.js) — no separate kill needed
    // here on the happy path; mechanism (d) below is strictly the backstop
    // for when this await never runs at all (the hook `process.exit()` path).
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

/**
 * Diagnostics-only accessor for the currently-connected daemon subprocess's
 * PID, or `null` if no connection is established. Used by
 * eights-integration.smoke.mjs to prove the spawned child is actually
 * terminated (not just orphaned) after a mid-test failure triggers cleanup.
 */
export function getConnectedDaemonPidForTesting(): number | null {
  return state.kind === "available" ? (state.transport.pid ?? null) : null;
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
