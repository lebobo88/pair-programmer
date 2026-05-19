/**
 * pp-daemon SQLite schema. Inlined as a string so the compiled `dist/`
 * doesn't need a separate copy of the SQL file. Mirror this with
 * `daemon/src/db/schema.sql` for human-readable reference.
 */
export const SCHEMA_VERSION = 7;

export const SCHEMA_SQL = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;

CREATE TABLE IF NOT EXISTS runs (
  id                       TEXT PRIMARY KEY,
  session_id               TEXT,
  project_path             TEXT NOT NULL,
  request_text             TEXT NOT NULL,
  team                     TEXT,
  mode                     TEXT NOT NULL,
  forum                    TEXT,
  n                        INTEGER,
  status                   TEXT NOT NULL,
  profile_snapshot_json    TEXT,
  taxonomy_mapping_json    TEXT,
  head_sha                 TEXT,
  tree_dirty_hash          TEXT,
  cli_versions_json        TEXT,
  -- v5: per-run CLI flags captured at /pp:run invocation
  -- (--tier-cap, --tier-floor, --no-tier-policy, …) so /pp:replay
  -- can re-issue with the same overrides. JSON object; null on legacy rows.
  cli_flags_json           TEXT,
  -- v7: ecosystem integration (Hydra / TheEights / Constitution).
  -- All optional. Present iff this run was invoked by Hydra OR participates in
  -- the cross-ecosystem evolution loop. Standalone pp runs leave these NULL
  -- and behave identically to v6. See docs/ecosystem.md (Phase A) for shape.
  hydra_workflow_id        TEXT,
  hydra_envelope_id        TEXT,
  hydra_origin_squad       TEXT,
  hydra_envelope_type      TEXT,
  constitution_sha         TEXT,
  constitution_attestation_id TEXT,
  eights_episodic_handle   TEXT,
  audit_bom_handle         TEXT,
  started_at               TEXT NOT NULL,
  finished_at              TEXT
);
CREATE INDEX IF NOT EXISTS idx_runs_project_started ON runs(project_path, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_runs_status          ON runs(status);
-- idx_runs_hydra_workflow (v7) is created in applyMigrations after the
-- ALTER TABLE adds the column on pre-v7 databases.

CREATE TABLE IF NOT EXISTS stages (
  id                  TEXT PRIMARY KEY,
  run_id              TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  kind                TEXT NOT NULL,
  gate_type           TEXT NOT NULL,
  status              TEXT NOT NULL,
  winner_attempt_id   TEXT,
  started_at          TEXT NOT NULL,
  finished_at         TEXT,
  notes_json          TEXT
);
CREATE INDEX IF NOT EXISTS idx_stages_run ON stages(run_id);

CREATE TABLE IF NOT EXISTS attempts (
  id                  TEXT PRIMARY KEY,
  stage_id            TEXT NOT NULL REFERENCES stages(id) ON DELETE CASCADE,
  producer            TEXT NOT NULL,
  model_id            TEXT NOT NULL,
  prompt_hash         TEXT,
  artifact_path       TEXT,
  tokens_in           INTEGER,
  tokens_out          INTEGER,
  cost_usd            REAL,
  wall_ms             INTEGER,
  retry_index         INTEGER NOT NULL DEFAULT 0,
  parent_attempt_id   TEXT,
  status              TEXT NOT NULL,
  -- v5: tier the driver resolved for this attempt ('opus'|'sonnet'|'haiku').
  -- NULL on non-claude producers and on legacy rows; the daemon does not
  -- enforce — recorded for cost-by-tier analytics and replay determinism.
  attempted_tier      TEXT,
  created_at          TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_attempts_stage  ON attempts(stage_id);
CREATE INDEX IF NOT EXISTS idx_attempts_parent ON attempts(parent_attempt_id);

CREATE TABLE IF NOT EXISTS verdicts (
  id                  TEXT PRIMARY KEY,
  attempt_id          TEXT NOT NULL REFERENCES attempts(id) ON DELETE CASCADE,
  judge_producer      TEXT NOT NULL,
  judge_model_id      TEXT NOT NULL,
  rubric_id           TEXT,
  outcome             TEXT NOT NULL,
  critique_md         TEXT,
  score_json          TEXT,
  cross_vendor        INTEGER NOT NULL DEFAULT 0,
  -- v7: TheEights memory linkage for this verdict.
  eights_memory_id    TEXT,
  created_at          TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_verdicts_attempt ON verdicts(attempt_id);

CREATE TABLE IF NOT EXISTS artifacts (
  id                  TEXT PRIMARY KEY,
  run_id              TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  stage_id            TEXT,
  taxonomy_section    TEXT,
  kind                TEXT,
  path                TEXT NOT NULL,
  sha256              TEXT NOT NULL,
  bytes               INTEGER NOT NULL,
  -- v7: Eight-Cell classification (vision|context|triggers|influence|risk|focus|constraints|delight)
  -- and TheEights memory linkage. NULL when TheEights is unavailable.
  cell                TEXT,
  eights_memory_id    TEXT,
  eights_handle       TEXT,
  created_at          TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_artifacts_run ON artifacts(run_id);
-- idx_artifacts_cell (v7) is created in applyMigrations after the ALTER
-- TABLE adds the column on pre-v7 databases.

CREATE TABLE IF NOT EXISTS missability_checks (
  id                  TEXT PRIMARY KEY,
  run_id              TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  check_id            TEXT NOT NULL,
  status              TEXT NOT NULL,
  evidence_path       TEXT,
  created_at          TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_missability_run ON missability_checks(run_id);

CREATE TABLE IF NOT EXISTS master_plan_patches (
  id                  TEXT PRIMARY KEY,
  run_id              TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  section             TEXT NOT NULL,
  kind                TEXT NOT NULL,
  prev_sha            TEXT,
  new_sha             TEXT NOT NULL,
  applied_at          TEXT NOT NULL
);

-- v6: AGENTS.md patch audit trail. Mirrors master_plan_patches; one row per
-- write to <project>/AGENTS.md by the harness, including 'noop_already_applied'
-- rows for idempotent retries. The section column is one of AGENTS_MD_SECTIONS
-- (see agents-md-template.ts).
CREATE TABLE IF NOT EXISTS agents_md_patches (
  id                  TEXT PRIMARY KEY,
  run_id              TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  section             TEXT NOT NULL,
  kind                TEXT NOT NULL,
  prev_sha            TEXT,
  new_sha             TEXT NOT NULL,
  applied_at          TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_agents_md_patches_run ON agents_md_patches(run_id);

CREATE TABLE IF NOT EXISTS budgets (
  scope               TEXT PRIMARY KEY,
  tokens_in           INTEGER NOT NULL DEFAULT 0,
  tokens_out          INTEGER NOT NULL DEFAULT 0,
  cost_usd            REAL    NOT NULL DEFAULT 0,
  updated_at          TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS teams (
  name                TEXT PRIMARY KEY,
  origin              TEXT NOT NULL,
  yaml_text           TEXT NOT NULL,
  loaded_at           TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sub_cli_sessions (
  project_path        TEXT NOT NULL,
  agent               TEXT NOT NULL,
  session_id          TEXT NOT NULL,
  last_used_at        TEXT NOT NULL,
  PRIMARY KEY(project_path, agent)
);

CREATE TABLE IF NOT EXISTS rubrics (
  id                  TEXT PRIMARY KEY,
  kind                TEXT NOT NULL,
  version             TEXT NOT NULL,
  markdown            TEXT NOT NULL,
  schema_json         TEXT,
  source_url          TEXT
);

CREATE TABLE IF NOT EXISTS daemon_meta (
  key                 TEXT PRIMARY KEY,
  value               TEXT NOT NULL
);

-- TDD execution gate. One row per (stage_id, phase) records the actual
-- outcome of running the test-strategist's tests_pre suite against the
-- working tree. finalizeStage refuses status='passed' for a tests_pre
-- stage without a verified pre row, and refuses status='passed' for a
-- code stage whose immediate predecessor was tests_pre without a
-- verified post row. This makes the red/green property uncircumventable.
CREATE TABLE IF NOT EXISTS tdd_checks (
  id                  TEXT PRIMARY KEY,
  run_id              TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  stage_id            TEXT NOT NULL REFERENCES stages(id) ON DELETE CASCADE,
  phase               TEXT NOT NULL,                       -- 'pre' | 'post'
  mode                TEXT NOT NULL,                       -- 'bug-fix' | 'refactor' | 'feature-tdd'
  test_runner         TEXT NOT NULL,                       -- vitest | jest | mocha | pytest | go-test | cargo-test | unittest | other
  test_command        TEXT NOT NULL,
  test_files_json     TEXT NOT NULL,
  expected            TEXT NOT NULL,                       -- 'all_pass' | 'all_fail'
  actual              TEXT NOT NULL,                       -- 'all_pass' | 'all_fail' | 'mixed' | 'error'
  status              TEXT NOT NULL,                       -- 'verified' | 'violation' | 'execution_error'
  passed_count        INTEGER,
  failed_count        INTEGER,
  exit_code           INTEGER,
  duration_ms         INTEGER NOT NULL,
  output_path         TEXT,
  reason              TEXT,
  manifest_path       TEXT NOT NULL,
  created_at          TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tdd_checks_stage ON tdd_checks(stage_id, phase);
CREATE INDEX IF NOT EXISTS idx_tdd_checks_run   ON tdd_checks(run_id);

-- Artifact validator gate. One row per (stage_id, artifact_id, validator_kind)
-- records the outcome of running a structural validator (e.g. ADR section
-- linter, OpenAPI schema check, Mermaid renderer) over an archived artifact.
-- finalizeStage refuses status='passed' when the validator policy demands a
-- 'verified' row that's missing or in a 'violation' / 'execution_error' state.
-- Mirrors tdd_checks but generalized across validator kinds.
CREATE TABLE IF NOT EXISTS artifact_validations (
  id                  TEXT PRIMARY KEY,
  run_id              TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  stage_id            TEXT NOT NULL REFERENCES stages(id) ON DELETE CASCADE,
  artifact_id         TEXT,                                    -- artifacts.id; null for ad-hoc paths
  validator_kind      TEXT NOT NULL,                           -- adr_structure_lint | contracts_lint | tokens_build | mermaid_render | c4_render
  artifact_kind       TEXT,                                    -- e.g. 'adr', 'openapi', 'design_tokens'
  artifact_path       TEXT NOT NULL,                           -- relative to project root
  status              TEXT NOT NULL,                           -- 'verified' | 'violation' | 'execution_error' | 'skipped'
  exit_code           INTEGER,
  duration_ms         INTEGER NOT NULL,
  output_path         TEXT,                                    -- captured stdout+stderr log
  reason              TEXT,
  binary_resolved     TEXT,                                    -- 'in-process:adr-structure-lint' or 'PATH:/usr/bin/java' etc.
  created_at          TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_av_stage ON artifact_validations(stage_id, validator_kind);
CREATE INDEX IF NOT EXISTS idx_av_run   ON artifact_validations(run_id);

-- v7: Autogenesis evolution proposals (T4 / Phase F). Created by the
-- autogenesis-analyzer when a recurring drift pattern is detected across runs
-- (e.g., same rubric flagged same false-positive >=3 times). Mirrored to
-- TheEights' evolution.propose API; eights_proposal_id holds the echoed id.
-- status transitions: pending -> approved | rejected | committed | rolled_back.
-- Rows persist after closure for audit / replay.
CREATE TABLE IF NOT EXISTS evolution_proposals (
  id                  TEXT PRIMARY KEY,
  run_id              TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  resource_rid        TEXT NOT NULL,
  proposed_change     TEXT NOT NULL,
  justification       TEXT NOT NULL,
  signal_count        INTEGER NOT NULL,
  risk_class          TEXT NOT NULL,
  eights_proposal_id  TEXT,
  status              TEXT NOT NULL,
  created_at          TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_evolution_proposals_run    ON evolution_proposals(run_id);
CREATE INDEX IF NOT EXISTS idx_evolution_proposals_status ON evolution_proposals(status);
`;
