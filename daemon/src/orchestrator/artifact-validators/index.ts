/**
 * Artifact-validator dispatcher.
 *
 * Mirrors tdd-gate.ts in structure: a single tool call (`artifact_validate`)
 * resolves the artifact + validator, runs the appropriate in-process or
 * subprocess check, persists a row in `artifact_validations`, and returns
 * the row. `finalizeStage` consults the latest row per (stage_id,
 * artifact_id, validator_kind) when the stage's status is being marked
 * `passed`.
 *
 * Only the canonical step-1 validator (adr_structure_lint) is wired here.
 * Subsequent validators (contracts_lint, tokens_build, mermaid_render,
 * c4_render) plug into the `runValidator` switch in additional commits.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { nanoid } from "nanoid";
import { db, txImmediate } from "../../db/database.js";
import { projectArtifactDir } from "../../util/paths.js";
import { log } from "../../util/logger.js";
import { loadProjectProfile } from "../profiles.js";
import { validateAdrStructure } from "./adr-structure-lint.js";
import { validateContracts } from "./contracts-lint.js";
import { validateTokens } from "./tokens-build.js";
import { validateMermaid } from "./mermaid-render.js";
import { validateC4 } from "./c4-render.js";
import {
  VALIDATOR_KINDS,
  type ValidatorKind,
  strictValidators,
} from "./validator-policy.js";
import { assertPathInProjectArtifactDir } from "./command-allowlist.js";

export { VALIDATOR_KINDS };
export type { ValidatorKind };

export type ArtifactValidationStatus = "verified" | "violation" | "execution_error" | "skipped";

export type ArtifactValidationRow = {
  id: string;
  run_id: string;
  stage_id: string;
  artifact_id: string | null;
  validator_kind: ValidatorKind;
  artifact_kind: string | null;
  artifact_path: string;
  status: ArtifactValidationStatus;
  exit_code: number | null;
  duration_ms: number;
  output_path: string | null;
  reason: string | null;
  binary_resolved: string | null;
  created_at: string;
};

export type RunValidatorInput = {
  stage_id: string;
  kind: ValidatorKind;
  artifact_path?: string;     // optional; resolved by kind→artifact_kind binding when omitted
};

export class ValidatorInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ValidatorInputError";
  }
}

/**
 * The one entry point exposed to MCP. Resolves the artifact, dispatches
 * to the per-validator routine, persists, and returns the row.
 */
export async function runArtifactValidator(input: RunValidatorInput): Promise<ArtifactValidationRow> {
  if (!VALIDATOR_KINDS.includes(input.kind)) {
    throw new ValidatorInputError(`unknown validator kind '${input.kind}'`);
  }

  const stageRow = db()
    .prepare(`SELECT id, run_id, kind FROM stages WHERE id = ?`)
    .get(input.stage_id) as { id: string; run_id: string; kind: string } | undefined;
  if (!stageRow) throw new ValidatorInputError(`stage ${input.stage_id} not found`);

  const runRow = db()
    .prepare(`SELECT project_path FROM runs WHERE id = ?`)
    .get(stageRow.run_id) as { project_path: string } | undefined;
  if (!runRow) throw new ValidatorInputError(`run ${stageRow.run_id} not found`);

  const profile = loadProjectProfile(runRow.project_path);
  const strict = strictValidators(profile);

  const target = resolveTargetArtifact({
    stage_id: input.stage_id,
    project_path: runRow.project_path,
    explicit_path: input.artifact_path,
    validator_kind: input.kind,
  });

  const started = Date.now();
  let result: { status: ArtifactValidationStatus; reason: string | null; exit_code: number | null; binary_resolved: string | null; output_text: string | null };
  try {
    result = await runValidator(input.kind, {
      run_id: stageRow.run_id,
      stage_id: input.stage_id,
      artifact_abs_path: target.absPath,
      project_path: runRow.project_path,
    });
  } catch (err) {
    result = {
      status: "execution_error",
      reason: `validator dispatch threw: ${(err as Error).message}`,
      exit_code: null,
      binary_resolved: null,
      output_text: null,
    };
  }
  const durationMs = Date.now() - started;

  // Strict-promotion: a profile-listed validator MUST run; treat 'skipped'
  // as 'execution_error'. The reason is preserved so the user can act on
  // the missing binary.
  if (result.status === "skipped" && strict.has(input.kind)) {
    result = {
      ...result,
      status: "execution_error",
      reason: `${result.reason ?? "skipped"}; promoted to execution_error because profile.required_validators_strict includes '${input.kind}'`,
    };
  }

  const outputPath = result.output_text === null
    ? null
    : writeOutputLog({
        project_path: runRow.project_path,
        run_id: stageRow.run_id,
        stage_id: input.stage_id,
        kind: input.kind,
        artifact_path: target.relPath,
        status: result.status,
        exit_code: result.exit_code,
        duration_ms: durationMs,
        binary_resolved: result.binary_resolved,
        body: result.output_text,
      });

  return persistRow({
    run_id: stageRow.run_id,
    stage_id: input.stage_id,
    artifact_id: target.artifactId,
    validator_kind: input.kind,
    artifact_kind: target.artifactKind,
    artifact_path: target.relPath,
    status: result.status,
    exit_code: result.exit_code,
    duration_ms: durationMs,
    output_path: outputPath,
    reason: result.reason,
    binary_resolved: result.binary_resolved,
  });
}

// ─── Per-validator dispatch ──────────────────────────────────────────────

type ValidatorContext = {
  run_id: string;
  stage_id: string;
  artifact_abs_path: string;
  project_path: string;
};
type ValidatorResult = {
  status: ArtifactValidationStatus;
  reason: string | null;
  exit_code: number | null;
  binary_resolved: string | null;
  output_text: string | null;
};

async function runValidator(kind: ValidatorKind, ctx: ValidatorContext): Promise<ValidatorResult> {
  switch (kind) {
    case "adr_structure_lint": {
      if (!existsSync(ctx.artifact_abs_path)) {
        return { status: "execution_error", reason: `artifact file missing on disk: ${ctx.artifact_abs_path}`, exit_code: null, binary_resolved: null, output_text: null };
      }
      const content = readFileSync(ctx.artifact_abs_path, "utf8");
      const lint = validateAdrStructure({ content });
      return {
        status: lint.status,
        reason: lint.reason,
        exit_code: null,
        binary_resolved: "in-process:adr-structure-lint",
        output_text: `# ADR structure lint\nstatus: ${lint.status}\nhas_title: ${lint.has_title}\nmissing: ${(lint.missing_sections ?? []).join(", ")}\nthin: ${(lint.thin_sections ?? []).join(", ")}\n${lint.reason ? `reason: ${lint.reason}\n` : ""}`,
      };
    }
    case "contracts_lint": {
      const r = await validateContracts({ artifact_abs_path: ctx.artifact_abs_path });
      return {
        status: r.status,
        reason: r.reason,
        exit_code: r.exit_code,
        binary_resolved: r.binary_resolved,
        output_text: r.output_text,
      };
    }
    case "tokens_build": {
      const r = await validateTokens({ artifact_abs_path: ctx.artifact_abs_path });
      return {
        status: r.status,
        reason: r.reason,
        exit_code: r.exit_code,
        binary_resolved: r.binary_resolved,
        output_text: r.output_text,
      };
    }
    case "mermaid_render": {
      const r = await validateMermaid({ artifact_abs_path: ctx.artifact_abs_path });
      return {
        status: r.status,
        reason: r.reason,
        exit_code: r.exit_code,
        binary_resolved: r.binary_resolved,
        output_text: r.output_text,
      };
    }
    case "c4_render": {
      const r = await validateC4({ artifact_abs_path: ctx.artifact_abs_path });
      return {
        status: r.status,
        reason: r.reason,
        exit_code: r.exit_code,
        binary_resolved: r.binary_resolved,
        output_text: r.output_text,
      };
    }
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────

type ResolvedTarget = {
  artifactId: string | null;
  artifactKind: string | null;
  relPath: string;
  absPath: string;
};

function normalizePathForMatch(path: string): string {
  const normalized = path.replaceAll("\\", "/").replace(/\/+/g, "/").replace(/\/$/, "");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function resolveTargetArtifact(opts: {
  stage_id: string;
  project_path: string;
  explicit_path?: string;
  validator_kind: ValidatorKind;
}): ResolvedTarget {
  if (opts.explicit_path) {
    const abs = isAbsolute(opts.explicit_path)
      ? resolve(opts.explicit_path)
      : resolve(opts.project_path, opts.explicit_path);
    const explicitAbs = normalizePathForMatch(abs);
    const explicitRel = isAbsolute(opts.explicit_path)
      ? null
      : normalizePathForMatch(opts.explicit_path);
    const stagedArtifacts = db()
      .prepare(
        `SELECT id, kind, path FROM artifacts
         WHERE stage_id = ?
         ORDER BY created_at DESC`,
      )
      .all(opts.stage_id) as Array<{ id: string; kind: string | null; path: string }>;
    const match = stagedArtifacts.find(a => {
      if (normalizePathForMatch(resolve(opts.project_path, a.path)) === explicitAbs) return true;
      return explicitRel !== null && normalizePathForMatch(a.path) === explicitRel;
    });
    return {
      artifactId: match?.id ?? null,
      artifactKind: match?.kind ?? null,
      relPath: match?.path ?? opts.explicit_path,
      absPath: abs,
    };
  }

  // No explicit path: pick the most recent archived artifact whose kind
  // binds to this validator. Validator-kind → artifact-kind reverse map.
  const candidateArtifactKinds = REVERSE_VALIDATOR_BINDINGS[opts.validator_kind] ?? [];
  if (candidateArtifactKinds.length === 0) {
    throw new ValidatorInputError(
      `validator '${opts.validator_kind}' has no artifact-kind binding; pass artifact_path explicitly`,
    );
  }
  const placeholders = candidateArtifactKinds.map(() => "?").join(",");
  const row = db()
    .prepare(
      `SELECT id, kind, path FROM artifacts
       WHERE stage_id = ? AND kind IN (${placeholders})
       ORDER BY created_at DESC LIMIT 1`,
    )
    .get(opts.stage_id, ...candidateArtifactKinds) as { id: string; kind: string | null; path: string } | undefined;
  if (!row) {
    throw new ValidatorInputError(
      `no archived artifact of kind in [${candidateArtifactKinds.join(", ")}] found on stage ${opts.stage_id}`,
    );
  }
  return {
    artifactId: row.id,
    artifactKind: row.kind,
    relPath: row.path,
    absPath: join(opts.project_path, row.path),
  };
}

const REVERSE_VALIDATOR_BINDINGS: Readonly<Record<ValidatorKind, readonly string[]>> = Object.freeze({
  adr_structure_lint: ["adr"],
  contracts_lint:     ["openapi", "asyncapi"],
  tokens_build:       ["design_tokens"],
  mermaid_render:     ["c4_diagram", "wireframes", "screen_state_matrix"],
  c4_render:          ["c4_diagram"],
});

function writeOutputLog(opts: {
  project_path: string;
  run_id: string;
  stage_id: string;
  kind: ValidatorKind;
  artifact_path: string;
  status: ArtifactValidationStatus;
  exit_code: number | null;
  duration_ms: number;
  binary_resolved: string | null;
  body: string;
}): string {
  const dir = join(projectArtifactDir(opts.project_path, opts.run_id), "artifact_validations");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${opts.stage_id}.${opts.kind}.${nanoid(8)}.log`);
  writeFileSync(
    file,
    `# Artifact validator: ${opts.kind}\n` +
    `artifact: ${opts.artifact_path}\n` +
    `status: ${opts.status}\n` +
    `exit_code: ${opts.exit_code}\n` +
    `binary_resolved: ${opts.binary_resolved ?? ""}\n` +
    `duration_ms: ${opts.duration_ms}\n` +
    `\n--- output ---\n${opts.body}\n`,
    "utf8",
  );
  return file;
}

function persistRow(r: {
  run_id: string;
  stage_id: string;
  artifact_id: string | null;
  validator_kind: ValidatorKind;
  artifact_kind: string | null;
  artifact_path: string;
  status: ArtifactValidationStatus;
  exit_code: number | null;
  duration_ms: number;
  output_path: string | null;
  reason: string | null;
  binary_resolved: string | null;
}): ArtifactValidationRow {
  const id = nanoid();
  const created_at = new Date().toISOString();
  txImmediate(() => {
    db()
      .prepare(
        `INSERT INTO artifact_validations(
          id, run_id, stage_id, artifact_id, validator_kind, artifact_kind,
          artifact_path, status, exit_code, duration_ms, output_path, reason,
          binary_resolved, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id, r.run_id, r.stage_id, r.artifact_id, r.validator_kind, r.artifact_kind,
        r.artifact_path, r.status, r.exit_code, r.duration_ms, r.output_path,
        r.reason, r.binary_resolved, created_at,
      );
  });
  log.info({
    event: "artifact_validation",
    id, run_id: r.run_id, stage_id: r.stage_id, validator: r.validator_kind,
    artifact_kind: r.artifact_kind, status: r.status, duration_ms: r.duration_ms,
  });
  return {
    id, run_id: r.run_id, stage_id: r.stage_id, artifact_id: r.artifact_id,
    validator_kind: r.validator_kind, artifact_kind: r.artifact_kind,
    artifact_path: r.artifact_path, status: r.status, exit_code: r.exit_code,
    duration_ms: r.duration_ms, output_path: r.output_path, reason: r.reason,
    binary_resolved: r.binary_resolved, created_at,
  };
}

/**
 * Returns the latest artifact_validations row for
 * (stage_id, artifact_id, validator_kind) or null.
 *
 * `artifact_id` may be null if the row was recorded without binding to a
 * specific artifacts.id (e.g. the caller passed an ad-hoc path). Lookup
 * uses IS NULL semantics in that case.
 */
export function getLatestArtifactValidation(
  stage_id: string,
  validator_kind: ValidatorKind,
  artifact_id: string | null = null,
): ArtifactValidationRow | null {
  const sql = artifact_id === null
    ? `SELECT * FROM artifact_validations
       WHERE stage_id = ? AND validator_kind = ?
       ORDER BY created_at DESC LIMIT 1`
    : `SELECT * FROM artifact_validations
       WHERE stage_id = ? AND validator_kind = ? AND artifact_id = ?
       ORDER BY created_at DESC LIMIT 1`;
  const params: unknown[] = artifact_id === null
    ? [stage_id, validator_kind]
    : [stage_id, validator_kind, artifact_id];
  const row = db().prepare(sql).get(...params) as ArtifactValidationRow | undefined;
  return row ?? null;
}

// Re-exports for callers (runs.ts, harness-server.ts)
export { assertPathInProjectArtifactDir };
