/**
 * pp-daemon SQLite schema. Inlined as a string so the compiled `dist/`
 * doesn't need a separate copy of the SQL file. Mirror this with
 * `daemon/src/db/schema.sql` for human-readable reference.
 */
export const SCHEMA_VERSION = 4;

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
  started_at               TEXT NOT NULL,
  finished_at              TEXT
);
CREATE INDEX IF NOT EXISTS idx_runs_project_started ON runs(project_path, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_runs_status          ON runs(status);

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
  created_at          TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_artifacts_run ON artifacts(run_id);

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
`;
