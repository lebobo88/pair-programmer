/**
 * Antigravity (agy) pinned-model verification (finding E2-1).
 *
 * `agy --model <id>` does NOT validate the id: an unrecognized model string is
 * silently accepted and the CLI falls back to its own default. That makes a
 * stale pin invisible at runtime — every critique keeps exiting 0 while the
 * ledger records `judge_model_id=<stale pin>` for a model that never served
 * the request. This module closes that hole by asking the CLI which ids it
 * actually serves (`agy models`) and comparing the pin against that list.
 *
 * Fail-soft by construction: if the probe cannot run (agy missing, timeout,
 * non-zero exit, unparseable output) the verdict is `null` ("unknown"), never
 * `false`. Only a successfully parsed served-list that omits the pin is
 * treated as a degradation.
 */

import { DEFAULT_MODELS } from "../config.js";
import { trackedExeca } from "../mcp/cli-runner.js";

/** Wall-clock cap on the `agy models` probe. Doctor must stay responsive. */
export const AGY_MODELS_TIMEOUT_MS = 15 * 1000;

export type AgyPinCheck = {
  /**
   * true  — the pinned critique model is in the CLI's served list.
   * false — the served list parsed cleanly and does NOT contain the pin.
   * null  — could not determine (probe failed / output unparseable).
   */
  agy_pin_served: boolean | null;
  /** The pin that was checked (`DEFAULT_MODELS.agy_critique`). */
  pinned_model: string;
  /** Ids parsed from `agy models`, or null when the probe did not yield any. */
  served_models: string[] | null;
  /** Operator-facing warning, or null when the pin is served. */
  note: string | null;
};

/**
 * Parse the id column out of `agy models` stdout.
 *
 * The CLI prints a `Fetching available models...` progress line followed by
 * one `\t`-separated `<id>\t<Human Label>` row per model. Be liberal: accept
 * any whitespace run as the separator, skip blank/progress lines, and keep
 * only tokens that look like model ids (no spaces, at least one `-` or `.`).
 */
export function parseAgyModels(stdout: string): string[] {
  const ids: string[] = [];
  for (const rawLine of (stdout ?? "").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    // Progress / status chatter, not a model row.
    if (line.endsWith("...") || /^(fetching|available models|loading)\b/i.test(line)) continue;
    const first = line.split(/\s+/)[0];
    if (!first) continue;
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(first)) continue;
    if (!/[-.]/.test(first)) continue;
    if (!ids.includes(first)) ids.push(first);
  }
  return ids;
}

/**
 * Pure decision function: given the pin and the parsed served list, decide
 * whether the pin is served and compose the operator warning.
 *
 * `servedModels === null` (probe failed) yields the unknown verdict; an empty
 * array is also treated as unknown, because a parse that found zero ids is
 * indistinguishable from an output-format change and must not be reported as
 * "the pin is gone".
 */
export function evaluateAgyPin(
  pinnedModel: string,
  servedModels: string[] | null,
  probeFailureReason?: string,
): AgyPinCheck {
  if (servedModels === null || servedModels.length === 0) {
    const why = probeFailureReason
      ? probeFailureReason
      : servedModels === null
        ? "`agy models` did not run"
        : "`agy models` returned no parseable model ids";
    return {
      agy_pin_served: null,
      pinned_model: pinnedModel,
      served_models: servedModels,
      note:
        `agy pinned-model check inconclusive (${why}). Could not confirm that ` +
        `"${pinnedModel}" is served; run \`agy models\` manually before trusting ` +
        `any agy judge_model_id in the ledger.`,
    };
  }
  if (servedModels.includes(pinnedModel)) {
    return {
      agy_pin_served: true,
      pinned_model: pinnedModel,
      served_models: servedModels,
      note: null,
    };
  }
  return {
    agy_pin_served: false,
    pinned_model: pinnedModel,
    served_models: servedModels,
    note:
      `agy pinned critique model "${pinnedModel}" is NOT served by the installed ` +
      `Antigravity CLI (served: ${servedModels.join(", ")}). agy does not reject an ` +
      `unknown --model, so critiques would silently run an unknown model while the ` +
      `ledger records the pin. Update DEFAULT_MODELS.agy_critique in ` +
      `daemon/src/config.ts to a served id.`,
  };
}

/** Run `agy models` (fail-soft). Returns null stdout when the probe fails. */
async function probeAgyModels(): Promise<{ stdout: string | null; reason?: string }> {
  try {
    const { stdout } = await trackedExeca("agy", ["models"], {
      windowsHide: true,
      timeout: AGY_MODELS_TIMEOUT_MS,
    });
    return { stdout: (stdout ?? "").toString() };
  } catch (err) {
    return { stdout: null, reason: `\`agy models\` failed: ${(err as Error).message}` };
  }
}

/**
 * Verify `DEFAULT_MODELS.agy_critique` against the installed CLI's served
 * list. Never throws; callers (doctor) can await it unconditionally.
 */
export async function checkAgyPinServed(
  pinnedModel: string = DEFAULT_MODELS.agy_critique,
): Promise<AgyPinCheck> {
  const { stdout, reason } = await probeAgyModels();
  if (stdout === null) return evaluateAgyPin(pinnedModel, null, reason);
  return evaluateAgyPin(pinnedModel, parseAgyModels(stdout), reason);
}
