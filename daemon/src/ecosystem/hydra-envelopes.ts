/**
 * hydra-envelopes — pp's outbound envelope emitters.
 *
 * pp now speaks Hydra's cross-squad message protocol when it has
 * something to say to the rest of the ecosystem:
 *
 *   - DECISION_RECORD       — fired at finalize_run when the run was
 *                             invoked by Hydra (hydra_workflow_id set).
 *                             Tells Hydra "the engineering work this
 *                             workflow asked for is done; here's how".
 *   - CSuiteDecisionPacket  — fired at triage when scope=major and the
 *                             profile is enterprise/ai-agentic/data-product.
 *                             Asks the executive crown for strategic
 *                             framing before pp authors a PRD.
 *   - CreativeBrief         — fired by the ux-team's new stages on
 *                             customer-facing surfaces: brand-narrative
 *                             review (MarketBliss) + visual direction
 *                             (RLM-Creative).
 *
 * All emissions go through TheEights' hydra.envelope.record API. Hydra's
 * supervisor subscribes to that store via eights.hydra.envelope.query
 * (already wired in Hydra's squad_node.py).
 *
 * Graceful-degradation contract: every emitter returns { recorded: boolean,
 * envelope_id: string }. When TheEights is offline, recorded=false but
 * the envelope_id is still allocated locally — pp can show it to the
 * operator so they know what *would have been* dispatched. The local
 * boardroom-agent fallback is opt-in via the spawn_local parameter; we
 * never silently substitute a local execution for an ecosystem dispatch.
 */

import { nanoid } from "nanoid";
import { log } from "../util/logger.js";
import { hydra, envelopeFor } from "./eights-client.js";

export type EnvelopeResult = {
  envelope_id: string;
  recorded: boolean;
  reason?: string;
};

export type DecisionRecordContext = {
  run_id: string;
  project_path: string;
  workflow_id: string;
  origin_squad: string | null;
  request_text: string;
  status: string;
  summary_md: string | null;
  artifact_count: number;
  hydra_envelope_id_in?: string | null;     // the envelope Hydra sent us
};

/**
 * Wrap a finalized pp run into a DECISION_RECORD envelope and post it to
 * TheEights' hydra envelope store. Hydra's supervisor reads from there
 * via eights.hydra.envelope.query(workflow_id) — no direct Hydra
 * dependency from pp.
 */
export async function emitDecisionRecord(ctx: DecisionRecordContext): Promise<EnvelopeResult> {
  const envelope_id = `env_pp_dr_${nanoid(10)}`;
  const env = envelopeFor({ run_id: ctx.run_id, project_path: ctx.project_path });

  // DECISION_RECORD payload mirrors Hydra/hydra_core/schemas.py:DecisionRecord.
  // The supervisor expects: decision (string), rationale, artifacts (list of
  // MemoryRef), and a status hint.
  const payload = {
    decision: `pp run ${ctx.run_id} finalized as ${ctx.status}`,
    rationale: ctx.summary_md
      ? ctx.summary_md.slice(0, 4_000)
      : `pp ran ${ctx.run_id} on request: ${ctx.request_text.slice(0, 200)}`,
    artifacts: [
      { tier: "episodic", key: `pp:run:${ctx.run_id}:final` },
    ],
    status: ctx.status,
    run_id: ctx.run_id,
    artifact_count: ctx.artifact_count,
    project_id: env.project_id,
    in_reply_to: ctx.hydra_envelope_id_in ?? null,
  };

  try {
    const result = await hydra.envelopeRecord({
      envelope_id,
      workflow_id: ctx.workflow_id,
      type: "DecisionRecord",
      origin_squad: "engineering",
      target_squad: ctx.origin_squad ?? "executive",
      parent_id: ctx.hydra_envelope_id_in ?? undefined,
      payload,
    });
    if (result?.recorded) {
      log.info(
        { run_id: ctx.run_id, workflow_id: ctx.workflow_id, envelope_id },
        "hydra DECISION_RECORD emitted"
      );
      return { envelope_id, recorded: true };
    }
    return { envelope_id, recorded: false, reason: "TheEights offline or refused record" };
  } catch (err) {
    log.debug({ err, run_id: ctx.run_id }, "emitDecisionRecord swallowed");
    return { envelope_id, recorded: false, reason: "throw swallowed" };
  }
}

export type CSuitePacketContext = {
  run_id: string;
  project_path: string;
  request_text: string;
  profile: string | null;
  hydra_workflow_id: string | null;          // optional; pp may originate
};

/**
 * Ask the executive crown for strategic framing on a major-tier request.
 * When Hydra is running, its supervisor will pick this up and route to
 * ExecutiveSuite's boardroom. The reply (a PRD envelope) appears in
 * TheEights' envelope store keyed by workflow_id; pp's spec-author can
 * poll via mcp__pp_harness__hydra_envelope_query.
 *
 * Returns the envelope_id pp emitted (always allocated, even when
 * TheEights refused the record). The driver agent is expected to wait
 * a bounded period before falling back to local boardroom invocation.
 */
export async function emitStrategicFramingRequest(ctx: CSuitePacketContext): Promise<EnvelopeResult> {
  const envelope_id = `env_pp_csp_${nanoid(10)}`;
  // If pp originated this (not Hydra-driven), allocate a synthetic
  // workflow_id so the round-trip can still be correlated.
  const workflow_id = ctx.hydra_workflow_id ?? `wf_pp_${ctx.run_id}`;
  const env = envelopeFor({ run_id: ctx.run_id, project_path: ctx.project_path });

  const payload = {
    objective: ctx.request_text,
    proposed_tasks: [],
    dissenting_opinions: [],
    project_id: env.project_id,
    project_profile: ctx.profile,
    pp_run_id: ctx.run_id,
    requested_by: "engineering",
  };

  try {
    const result = await hydra.envelopeRecord({
      envelope_id,
      workflow_id,
      type: "C_SUITE_DECISION_PACKET",
      origin_squad: "engineering",
      target_squad: "executive",
      payload,
    });
    if (result?.recorded) {
      log.info(
        { run_id: ctx.run_id, workflow_id, envelope_id },
        "hydra CSuiteDecisionPacket emitted (strategic framing requested)"
      );
      return { envelope_id, recorded: true };
    }
    return { envelope_id, recorded: false, reason: "TheEights offline" };
  } catch (err) {
    log.debug({ err, run_id: ctx.run_id }, "emitStrategicFramingRequest swallowed");
    return { envelope_id, recorded: false, reason: "throw swallowed" };
  }
}

export type CreativeBriefContext = {
  run_id: string;
  project_path: string;
  workflow_id: string | null;
  target: "marketing-strategy" | "creative";
  brief_kind: "brand-voice-check" | "visual-direction-advisory";
  surface_description: string;                 // e.g., "new onboarding flow copy"
  payload_excerpt: string;                     // truncated content being reviewed
};

/**
 * Fire a CreativeBrief envelope to Garland (RLM-Creative) or MarketBliss
 * (marketing-strategy squad). pp's ux-team stages emit these on
 * customer-facing surfaces. They are advisory by default — pp does NOT
 * block merge on a missing reply. The driver should poll for a returned
 * DecisionRecord within a short window and surface it as context, not
 * as a gate.
 */
export async function emitCreativeBrief(ctx: CreativeBriefContext): Promise<EnvelopeResult> {
  const envelope_id = `env_pp_cb_${nanoid(10)}`;
  const workflow_id = ctx.workflow_id ?? `wf_pp_${ctx.run_id}`;
  const env = envelopeFor({ run_id: ctx.run_id, project_path: ctx.project_path });

  const payload = {
    brief_kind: ctx.brief_kind,
    surface: ctx.surface_description,
    content_excerpt: ctx.payload_excerpt.slice(0, 4_000),
    project_id: env.project_id,
    pp_run_id: ctx.run_id,
    advisory: true,
  };

  try {
    const result = await hydra.envelopeRecord({
      envelope_id,
      workflow_id,
      type: "CreativeBrief",
      origin_squad: "engineering",
      target_squad: ctx.target,
      payload,
    });
    if (result?.recorded) {
      log.info(
        { run_id: ctx.run_id, workflow_id, target: ctx.target, brief_kind: ctx.brief_kind, envelope_id },
        "hydra CreativeBrief emitted"
      );
      return { envelope_id, recorded: true };
    }
    return { envelope_id, recorded: false, reason: "TheEights offline" };
  } catch (err) {
    log.debug({ err, run_id: ctx.run_id }, "emitCreativeBrief swallowed");
    return { envelope_id, recorded: false, reason: "throw swallowed" };
  }
}
