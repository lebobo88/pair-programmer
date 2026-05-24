import { CRITIQUE_RETRY_BACKOFF_MS } from "../config.js";
import { archiveCliFailureContext, type CliAttempt } from "./cli-runner.js";
import { validateCritiqueResult, type CritiqueVerdict } from "./critique-schema.js";

type CritiqueBridgeResult = {
  text: string;
  parsed?: unknown;
  exit_code: number;
  wall_ms: number;
  attempts?: CliAttempt[];
  failure_archive_path?: string;
  reason?: string;
};

export async function stabilizeCritiqueResult<T extends CritiqueBridgeResult>(
  runOnce: () => Promise<T>,
  opts: { cwd: string; vendor: "codex" | "gemini" | "copilot" }
): Promise<T & { parsed?: CritiqueVerdict; reason?: string }> {
  const attempts: CliAttempt[] = [];
  let wall_ms = 0;
  let last: T | undefined;
  let lastReason = "malformed JSON";

  for (let i = 0; i < 2; i++) {
    const result = await runOnce();
    attempts.push(...(result.attempts ?? []));
    wall_ms += result.wall_ms;

    if (result.exit_code !== 0) {
      return {
        ...result,
        attempts,
        wall_ms,
      } as T & { parsed?: CritiqueVerdict; reason?: string };
    }

    const validated = validateCritiqueResult(result);
    if (validated.ok) {
      return {
        ...result,
        text: JSON.stringify(validated.verdict, null, 2),
        parsed: validated.verdict,
        attempts,
        wall_ms,
      } as T & { parsed?: CritiqueVerdict; reason?: string };
    }

    last = result;
    lastReason = validated.reason;
    if (i === 0) await sleep(CRITIQUE_RETRY_BACKOFF_MS);
  }

  const failure_archive_path =
    last?.failure_archive_path ??
    archiveCliFailureContext({
      cwd: opts.cwd,
      vendor: opts.vendor,
      attempts,
      stdout: last?.text ?? "",
      reason: lastReason,
      exit_code: 0,
    });

  return {
    ...last!,
    exit_code: 1,
    attempts,
    wall_ms,
    failure_archive_path,
    reason: lastReason,
  } as T & { parsed?: CritiqueVerdict; reason?: string };
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
