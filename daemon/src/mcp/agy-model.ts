/**
 * agy (Antigravity CLI) model-id canonicalization.
 *
 * The CLI serves EFFORT-SUFFIXED model ids (`gemini-3.8-flash-medium`). Two
 * facts, probed directly against agy 1.1.24 on 2026-09-02, shape this module:
 *
 *  1. Passing a suffixed id together with `--effort` is an ERROR
 *     ("conflicts with --effort"). Passing a BARE family with `--effort` works.
 *  2. An unknown OR retired id is rejected outright (exit 1, status ERROR,
 *     "invalid model selection"). There is no silent fallback to a CLI
 *     default, so a bad id fails loudly rather than mispricing the ledger.
 *
 * Rather than teach every call site when `--effort` is legal, this resolver
 * collapses (model?, reasoning_effort?) into ONE canonical suffixed id drawn
 * from `JUDGE_MODEL_POLICY.agy.allowed_models`. The returned id never needs
 * `--effort`, so pp never passes it.
 *
 * Pure: no I/O, no subprocess, no env reads.
 */

import {
  JUDGE_MODEL_POLICY,
  type JudgeReasoningEffort,
} from "../config.js";

export type AgyInvocation = {
  /** Canonical effort-suffixed agy model id. Always in `allowed_models`. */
  model_id: string;
  /** The effort encoded by that id's suffix. Never passed as `--effort`. */
  effort: JudgeReasoningEffort;
};

/**
 * Read the agy policy lazily. config.ts imports THIS module (for
 * `resolveJudgeSelection`) while this module imports config.ts, so a
 * module-level `const POLICY = JUDGE_MODEL_POLICY.agy` would hit the TDZ
 * whenever agy-model.js is the module entered first. Every read happens inside
 * a function body instead, by which point both modules are fully evaluated.
 */
function policy(): typeof JUDGE_MODEL_POLICY.agy {
  return JUDGE_MODEL_POLICY.agy;
}

/** Effort suffixes recognized when splitting an id. Superset of agy's set. */
const SUFFIXES: readonly JudgeReasoningEffort[] = ["low", "medium", "high", "xhigh"];

/**
 * Split an effort-suffixed model id into its family and effort.
 * Returns null when the id carries no recognized effort suffix — that includes
 * a bare family (`gemini-3.7-flash`) and a retired non-effort suffix
 * (`gemini-3.1-pro-preview`).
 */
export function splitAgyModelId(id: string): { family: string; effort: JudgeReasoningEffort } | null {
  for (const suffix of SUFFIXES) {
    const tail = `-${suffix}`;
    if (id.length > tail.length && id.endsWith(tail)) {
      return { family: id.slice(0, id.length - tail.length), effort: suffix };
    }
  }
  return null;
}

/** Allow-listed ids belonging to `family`, in policy order. */
function servedForFamily(family: string): string[] {
  return policy().allowed_models.filter((id) => {
    const split = splitAgyModelId(id);
    return split !== null && split.family === family;
  });
}

function allowListMessage(): string {
  return `allowed agy models: ${policy().allowed_models.join(", ")}`;
}

/**
 * Canonicalize a caller's (model, reasoning_effort) pair into a single served,
 * effort-suffixed agy model id. Throws with an operator-readable message rather
 * than guessing — a wrong guess would be recorded in the ledger as provenance.
 */
export function resolveAgyInvocation(opts: {
  model?: string;
  reasoning_effort?: string;
}): AgyInvocation {
  const rawModel = opts.model?.trim();
  const rawEffort = opts.reasoning_effort?.trim();

  let effort: JudgeReasoningEffort | undefined;
  if (rawEffort !== undefined && rawEffort !== "") {
    if (!(policy().allowed_efforts as readonly string[]).includes(rawEffort)) {
      throw new Error(
        `reasoning_effort "${rawEffort}" is not served by agy. ` +
          `allowed agy efforts: ${policy().allowed_efforts.join(", ")}`,
      );
    }
    effort = rawEffort as JudgeReasoningEffort;
  }

  // Nothing given → the pinned default.
  if (rawModel === undefined || rawModel === "") {
    const family = splitAgyModelId(policy().default.model)?.family;
    if (effort === undefined || family === undefined) {
      return { model_id: policy().default.model, effort: policy().default.reasoning_effort };
    }
    // Only an effort was given: apply it to the default family.
    const candidate = `${family}-${effort}`;
    if (!(policy().allowed_models as readonly string[]).includes(candidate)) {
      throw new Error(
        `agy model "${candidate}" is not served. ` +
          `served ids for family "${family}": ${servedForFamily(family).join(", ")}`,
      );
    }
    return { model_id: candidate, effort };
  }

  const split = splitAgyModelId(rawModel);

  if (split !== null) {
    // Suffixed id.
    if (!(policy().allowed_models as readonly string[]).includes(rawModel)) {
      throw new Error(`agy model "${rawModel}" is not served. ${allowListMessage()}`);
    }
    if (effort !== undefined && effort !== split.effort) {
      throw new Error(
        `agy model "${rawModel}" encodes reasoning effort "${split.effort}" but ` +
          `reasoning_effort "${effort}" was requested — the two conflict. ` +
          `Pass the suffixed id alone, or pass the bare family "${split.family}" with the effort.`,
      );
    }
    return { model_id: rawModel, effort: split.effort };
  }

  // Bare family (or an id with an unrecognized suffix).
  const family = rawModel;
  const served = servedForFamily(family);
  if (served.length === 0) {
    throw new Error(`agy model "${rawModel}" is not served. ${allowListMessage()}`);
  }
  const chosenEffort: JudgeReasoningEffort = effort ?? "medium";
  const candidate = `${family}-${chosenEffort}`;
  if (!(policy().allowed_models as readonly string[]).includes(candidate)) {
    throw new Error(
      `agy model "${candidate}" is not served. ` +
        `served ids for family "${family}": ${served.join(", ")}`,
    );
  }
  return { model_id: candidate, effort: chosenEffort };
}
