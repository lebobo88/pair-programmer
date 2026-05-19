/**
 * hydra-context — captures Hydra's calling context on start_run and
 * propagates it into sub-agent prompts.
 *
 * Today (pre-spine) pp's start_run receives Hydra envelope data as part of
 * `request_text` only; the supervisor's `workflow_id`, `envelope_id`,
 * `origin_squad`, and `envelope_type` get dropped. This module lifts them
 * into first-class fields:
 *
 *   1. **Parse** — `parseHydraContext()` reads optional fields off start_run
 *      input. All four are optional; absence means pp was invoked standalone
 *      (CLI / IDE / direct MCP), not via Hydra.
 *   2. **Persist** — runs.ts INSERTs them into runs.hydra_* columns (v7
 *      schema). pp DBs from before v7 tolerate NULLs via additive migration.
 *   3. **Surface** — `renderHydraContextBlock()` formats the context for
 *      injection into agent system prompts via the `${HYDRA_CONTEXT}`
 *      template variable. Empty string when no context present, so
 *      standalone runs are unaffected.
 *
 * This module is pure data — no I/O, no MCP calls. Safe to import
 * everywhere.
 */

import { HYDRA_ENVELOPE_TYPES, type HydraEnvelopeType } from "../config.js";

export type HydraContext = {
  workflow_id: string;
  envelope_id: string | null;
  origin_squad: string | null;
  envelope_type: HydraEnvelopeType | null;
};

export type HydraContextInput = {
  hydra_workflow_id?: string | null;
  hydra_envelope_id?: string | null;
  hydra_origin_squad?: string | null;
  hydra_envelope_type?: string | null;
};

/**
 * Parse the four optional Hydra fields off any object (typically a parsed
 * start_run payload). Returns null when no `workflow_id` is present — the
 * workflow_id is the load-bearing identifier; without it we cannot join
 * back to Hydra's supervisor graph and the context is meaningless.
 */
export function parseHydraContext(input: HydraContextInput | undefined | null): HydraContext | null {
  if (!input) return null;
  const workflow_id = input.hydra_workflow_id?.trim();
  if (!workflow_id) return null;

  const raw_type = input.hydra_envelope_type?.trim();
  const envelope_type: HydraEnvelopeType | null =
    raw_type && (HYDRA_ENVELOPE_TYPES as readonly string[]).includes(raw_type)
      ? (raw_type as HydraEnvelopeType)
      : null;

  return {
    workflow_id,
    envelope_id: input.hydra_envelope_id?.trim() || null,
    origin_squad: input.hydra_origin_squad?.trim() || null,
    envelope_type,
  };
}

/**
 * Render a Hydra context block for prompt injection. Empty string when no
 * context — callers MAY then strip the surrounding template region rather
 * than emit a blank section.
 *
 * Format is deliberately compact and machine-readable; sub-agents are
 * expected to parse the YAML-like header when reasoning about provenance.
 */
export function renderHydraContextBlock(ctx: HydraContext | null): string {
  if (!ctx) return "";
  const lines = [
    "## Hydra context",
    "",
    "This pair-programmer run was invoked by Hydra. Treat the inbound request as the",
    "downstream of an upstream squad's envelope. Honor any constraints already established.",
    "",
    "```yaml",
    `workflow_id:   ${ctx.workflow_id}`,
    `envelope_id:   ${ctx.envelope_id ?? "(none)"}`,
    `origin_squad:  ${ctx.origin_squad ?? "(unspecified)"}`,
    `envelope_type: ${ctx.envelope_type ?? "(unspecified)"}`,
    "```",
    "",
  ];
  return lines.join("\n");
}

/**
 * Stringified summary for log lines / structured fields. Order-stable so
 * log indexers can cheap-grep by workflow_id.
 */
export function hydraContextSummary(ctx: HydraContext | null): string {
  if (!ctx) return "standalone";
  return `wf=${ctx.workflow_id};squad=${ctx.origin_squad ?? "?"};type=${ctx.envelope_type ?? "?"}`;
}
