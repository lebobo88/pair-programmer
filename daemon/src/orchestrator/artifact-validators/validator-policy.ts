/**
 * Validator policy table — maps an archived artifact's `kind` to the set
 * of validator kinds that must run before its stage can finalize=passed.
 *
 * Two layers:
 *  1. Built-in defaults (`DEFAULT_VALIDATOR_BINDINGS`) — stable across
 *     profiles. e.g. an `adr` artifact always gets `adr_structure_lint`.
 *  2. Profile-level overrides (`profile.required_validators`) — unioned
 *     in via `resolveProfile`. Profiles can demand extra validators or
 *     bind validators to artifact kinds the default map doesn't cover.
 *
 * Strict promotion: a `skipped` row (binary missing on PATH) does NOT
 * block by default. If the profile lists the validator in
 * `required_validators_strict`, the dispatcher promotes `skipped` to
 * `execution_error` so the gate fails closed.
 */

import { db } from "../../db/database.js";
import { loadProjectProfile, type ProfileSpec } from "../profiles.js";

export const VALIDATOR_KINDS = [
  "adr_structure_lint",
  "contracts_lint",
  "tokens_build",
  "mermaid_render",
  "c4_render",
] as const;

export type ValidatorKind = typeof VALIDATOR_KINDS[number];

/**
 * Built-in artifact_kind → ValidatorKind[] bindings. Conservative by
 * default — only fires on artifact kinds whose validators have no heavy
 * external deps OR whose profile already demands the dep (handled by
 * profile.required_validators).
 *
 * The architect agent emits artifacts with kind `adr`. Any future
 * artifact whose `kind` matches a key here will auto-bind.
 */
export const DEFAULT_VALIDATOR_BINDINGS: Readonly<Record<string, readonly ValidatorKind[]>> = Object.freeze({
  adr: ["adr_structure_lint"],
  openapi: ["contracts_lint"],
  asyncapi: ["contracts_lint"],
  design_tokens: ["tokens_build"],
  c4_diagram: ["mermaid_render"],
  wireframes: ["mermaid_render"],
});

/**
 * Returns the validator kinds bound to an artifact kind for a given
 * profile (defaults ∪ profile.required_validators[kind]).
 */
export function requiredValidatorsForArtifact(
  profile: ProfileSpec | null,
  artifactKind: string | null | undefined,
): ValidatorKind[] {
  if (!artifactKind) return [];
  const out = new Set<ValidatorKind>();
  for (const v of DEFAULT_VALIDATOR_BINDINGS[artifactKind] ?? []) out.add(v);
  for (const v of profile?.required_validators?.[artifactKind] ?? []) {
    if (isValidatorKind(v)) out.add(v);
  }
  return [...out];
}

function isValidatorKind(v: string): v is ValidatorKind {
  return (VALIDATOR_KINDS as readonly string[]).includes(v);
}

/**
 * Walks every archived artifact for a stage and produces the full
 * (artifact_id, artifact_kind, validators[]) requirement set the gate
 * has to satisfy.
 *
 * Returns artifacts with at least one required validator. Skips
 * artifacts that don't bind to any validator.
 */
export type StageValidatorRequirement = {
  artifact_id: string;
  artifact_kind: string | null;
  artifact_path: string;
  validators: ValidatorKind[];
};

export function requiredValidatorsForStage(stage_id: string): StageValidatorRequirement[] {
  const stageRow = db()
    .prepare(`SELECT id, run_id FROM stages WHERE id = ?`)
    .get(stage_id) as { id: string; run_id: string } | undefined;
  if (!stageRow) return [];

  const runRow = db()
    .prepare(`SELECT project_path FROM runs WHERE id = ?`)
    .get(stageRow.run_id) as { project_path: string } | undefined;
  if (!runRow) return [];

  const profile = loadProjectProfile(runRow.project_path);
  const artifacts = db()
    .prepare(`SELECT id, kind, path FROM artifacts WHERE stage_id = ? ORDER BY created_at ASC`)
    .all(stage_id) as Array<{ id: string; kind: string | null; path: string }>;

  const out: StageValidatorRequirement[] = [];
  for (const a of artifacts) {
    const validators = requiredValidatorsForArtifact(profile, a.kind);
    if (validators.length > 0) {
      out.push({
        artifact_id: a.id,
        artifact_kind: a.kind,
        artifact_path: a.path,
        validators,
      });
    }
  }
  return out;
}

/**
 * Returns the set of validator kinds that should treat a `skipped` outcome
 * (binary not on PATH) as `execution_error` — i.e. fail closed instead of
 * letting the stage advance unverified. Driven by
 * `profile.required_validators_strict`.
 */
export function strictValidators(profile: ProfileSpec | null): Set<ValidatorKind> {
  const out = new Set<ValidatorKind>();
  for (const v of profile?.required_validators_strict ?? []) {
    if (isValidatorKind(v)) out.add(v);
  }
  return out;
}
