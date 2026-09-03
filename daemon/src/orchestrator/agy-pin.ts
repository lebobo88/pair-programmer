/**
 * Antigravity (agy) pinned-model verification (finding E2-1, extended by J7).
 *
 * WHAT THE CLI ACTUALLY DOES — verified by direct probe against agy 1.1.24 on
 * 2026-09-02/03: `agy --model <id>` REJECTS both unknown and retired ids. The
 * process exits 1, the envelope carries status ERROR, and the message is
 * "invalid model selection". There is NO silent fallback to a CLI default —
 * the E2-1 retired id `gemini-3.1-pro-preview` is rejected exactly like any
 * other unknown string. (The earlier header here claimed a silent fallback;
 * that claim was wrong and is retracted.)
 *
 * SO WHY PROBE AT ALL? Two reasons that survive the correction:
 *
 *  1. Timing. A pin that is retired BETWEEN CLI releases fails loudly, but it
 *     fails at the moment a judge is invoked — mid-run, after generation cost
 *     has been spent, at the gate. `agy models` is a ~1s list call that moves
 *     that discovery to `/pp:doctor`, before any work is committed.
 *  2. Allow-list drift. `JUDGE_MODEL_POLICY.agy.allowed_models` is the set of
 *     ids `recordVerdict` will accept. It must stay a SUBSET of what the CLI
 *     serves; an allow-listed id the CLI no longer serves is a trap that only
 *     springs when an operator overrides onto it. `unserved_allowlist` reports
 *     that drift even when every active pin is healthy.
 *
 * Fail-soft by construction: if the probe cannot run (agy missing, timeout,
 * non-zero exit, unparseable output) every verdict is `null` ("unknown"),
 * never `false`. Only a successfully parsed served-list that omits a pin is
 * treated as a degradation.
 */

import { DEFAULT_MODELS, JUDGE_MODEL_POLICY } from "../config.js";
import { trackedExeca } from "../mcp/cli-runner.js";

/** Wall-clock cap on the `agy models` probe. Doctor must stay responsive. */
export const AGY_MODELS_TIMEOUT_MS = 15 * 1000;

export type AgyPinCheck = {
  /**
   * Aggregate verdict across every checked pin:
   *   false — at least one pin parsed cleanly as NOT served (hard degradation).
   *   null  — no pin is false and at least one is unknown (probe inconclusive).
   *   true  — every checked pin is served.
   * The legacy field name is kept: doctor and its consumers key off it.
   */
  agy_pin_served: boolean | null;
  /** Legacy scalar: the critique_default pin (`DEFAULT_MODELS.agy_critique`). */
  pinned_model: string;
  /** Every pin that was checked, keyed by lane (critique_default, ...). */
  pinned_models: Record<string, string>;
  /** Per-lane verdict, same tri-state semantics as `agy_pin_served`. */
  per_pin: Record<string, boolean | null>;
  /** Ids parsed from `agy models`, or null when the probe did not yield any. */
  served_models: string[] | null;
  /**
   * Allow-listed judge ids (`JUDGE_MODEL_POLICY.agy.allowed_models`) that the
   * CLI does not serve. Informational — the allow-list must stay a subset of
   * the served list, but an unserved entry is a latent trap, not a live break.
   */
  unserved_allowlist: string[];
  /** Operator-facing warning, or null when every pin is served. */
  note: string | null;
};

/** The lanes checked by default: every agy model id pp can actually invoke. */
export function defaultAgyPins(): Record<string, string> {
  return {
    critique_default:   DEFAULT_MODELS.agy_critique,
    critique_escalated: DEFAULT_MODELS.agy_critique_escalated,
    generate:           DEFAULT_MODELS.agy_generate,
  };
}

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
 * A parsed list is only usable when it is non-empty: a parse that found zero
 * ids is indistinguishable from an output-format change and must not be
 * reported as "the pin is gone".
 */
function inconclusiveReason(
  servedModels: string[] | null,
  probeFailureReason?: string,
): string | null {
  if (servedModels !== null && servedModels.length > 0) return null;
  if (probeFailureReason) return probeFailureReason;
  return servedModels === null
    ? "`agy models` did not run"
    : "`agy models` returned no parseable model ids";
}

/**
 * Pure decision function over a SET of pins. Given the lanes and the parsed
 * served list, decide each lane's verdict, aggregate them, and compose the
 * operator warning.
 */
export function evaluateAgyPins(
  pins: Record<string, string>,
  servedModels: string[] | null,
  probeFailureReason?: string,
): AgyPinCheck {
  const lanes = Object.keys(pins);
  const firstLane = lanes[0];
  const legacyPin =
    pins.critique_default ??
    (firstLane !== undefined ? pins[firstLane] : undefined) ??
    DEFAULT_MODELS.agy_critique;
  const why = inconclusiveReason(servedModels, probeFailureReason);

  if (why !== null) {
    const per_pin: Record<string, boolean | null> = {};
    for (const lane of lanes) per_pin[lane] = null;
    return {
      agy_pin_served: null,
      pinned_model: legacyPin,
      pinned_models: { ...pins },
      per_pin,
      served_models: servedModels,
      unserved_allowlist: [],
      note:
        `agy pinned-model check inconclusive (${why}). Could not confirm that ` +
        `"${legacyPin}" is served; run \`agy models\` manually before trusting ` +
        `any agy judge_model_id in the ledger.`,
    };
  }

  const served = servedModels as string[];
  const per_pin: Record<string, boolean | null> = {};
  const missing: Array<{ lane: string; model: string }> = [];
  for (const lane of lanes) {
    const model = pins[lane] as string;
    const ok = served.includes(model);
    per_pin[lane] = ok;
    if (!ok) missing.push({ lane, model });
  }

  const unserved_allowlist = JUDGE_MODEL_POLICY.agy.allowed_models.filter(
    (id) => !served.includes(id),
  );

  if (missing.length === 0) {
    return {
      agy_pin_served: true,
      pinned_model: legacyPin,
      pinned_models: { ...pins },
      per_pin,
      served_models: served,
      unserved_allowlist,
      note: unserved_allowlist.length
        ? `agy allow-list drift: ${unserved_allowlist.join(", ")} ${
            unserved_allowlist.length === 1 ? "is" : "are"
          } in JUDGE_MODEL_POLICY.agy.allowed_models but NOT served by the ` +
          `installed Antigravity CLI. Every active pin is fine; an operator ` +
          `override onto an unserved id would fail at judge time (agy exits 1 ` +
          `with "invalid model selection"). Trim allowed_models in ` +
          `daemon/src/config.ts, or upgrade the CLI.`
        : null,
    };
  }

  return {
    agy_pin_served: false,
    pinned_model: legacyPin,
    pinned_models: { ...pins },
    per_pin,
    served_models: served,
    unserved_allowlist,
    note:
      `agy pinned model(s) NOT served by the installed Antigravity CLI: ` +
      `${missing.map((m) => `${m.lane}="${m.model}"`).join(", ")} ` +
      `(served: ${served.join(", ")}). agy REJECTS an unknown or retired ` +
      `--model — exit 1, "invalid model selection" — so every judge call on ` +
      `an unserved pin fails hard mid-run. Repin JUDGE_MODEL_POLICY.agy in ` +
      `daemon/src/config.ts to a served id.`,
  };
}

/**
 * Single-pin form, preserved verbatim in behaviour for existing callers and
 * tests. Delegates to the multi-pin evaluator under the `critique_default`
 * lane; the extra fields (`pinned_models`, `per_pin`, `unserved_allowlist`)
 * come along for free.
 */
export function evaluateAgyPin(
  pinnedModel: string,
  servedModels: string[] | null,
  probeFailureReason?: string,
): AgyPinCheck {
  const res = evaluateAgyPins({ critique_default: pinnedModel }, servedModels, probeFailureReason);
  // Preserve the original single-pin wording so operator-facing text (and the
  // tests that assert on it) does not shift under callers that pass one pin.
  if (res.agy_pin_served === false) {
    return {
      ...res,
      note:
        `agy pinned critique model "${pinnedModel}" is NOT served by the installed ` +
        `Antigravity CLI (served: ${(res.served_models ?? []).join(", ")}). agy REJECTS ` +
        `an unknown or retired --model (exit 1, "invalid model selection"), so every ` +
        `critique on this pin would fail hard mid-run rather than silently running a ` +
        `different model. Update DEFAULT_MODELS.agy_critique in ` +
        `daemon/src/config.ts to a served id.`,
    };
  }
  // Legacy contract: a served single pin carries no note. The allow-list-drift
  // advisory is a multi-pin (doctor) concern and would be a behaviour change
  // for existing single-pin callers.
  if (res.agy_pin_served === true) return { ...res, note: null };
  return res;
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
 * Verify every agy pin (critique default, critique escalated, generate)
 * against the installed CLI's served list. Never throws; callers (doctor) can
 * await it unconditionally.
 */
export async function checkAgyPinServed(
  pins: Record<string, string> = defaultAgyPins(),
): Promise<AgyPinCheck> {
  const { stdout, reason } = await probeAgyModels();
  if (stdout === null) return evaluateAgyPins(pins, null, reason);
  return evaluateAgyPins(pins, parseAgyModels(stdout), reason);
}
