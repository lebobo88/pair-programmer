/**
 * Run replay: reconstruct the prompt set, model versions, and CLI versions
 * for a past run so it can be manually re-executed (no auto-execute — the
 * user / driver decides). The captured fields are HEAD SHA, dirty-tree
 * hash, profile snapshot, and CLI versions, all stored on `runs` at
 * start_run time.
 *
 * Also reconstructs the Claude-tier resolver's decisions from
 * `tier_decisions.json` (archived per run in step 5b of the driver) and
 * any per-run CLI flags from `runs.cli_flags_json`, so a replayer can
 * re-issue with the same overrides.
 */

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { db } from "../db/database.js";
import { projectArtifactDir } from "../util/paths.js";

export type ReplayBundle = {
  run_id: string;
  request_text: string;
  project_path: string;
  team: string | null;
  mode: string;
  forum: string | null;
  n: number | null;
  status: string;
  head_sha: string | null;
  tree_dirty_hash: string | null;
  profile_snapshot: unknown;
  taxonomy_mapping: unknown;
  cli_versions: unknown;
  started_at: string;
  finished_at: string | null;
  stages: Array<{
    id: string;
    kind: string;
    gate_type: string;
    status: string;
    attempts: Array<{
      id: string;
      producer: string;
      model_id: string;
      attempted_tier: string | null;
      retry_index: number;
      parent_attempt_id: string | null;
      tokens_in: number | null;
      tokens_out: number | null;
      cost_usd: number | null;
      verdicts: Array<{
        judge_producer: string;
        judge_model_id: string;
        rubric_id: string | null;
        outcome: string;
        cross_vendor: boolean;
      }>;
    }>;
  }>;
  artifacts: Array<{ kind: string | null; path: string; sha256: string }>;
  /**
   * Parsed contents of `<run_id>/tier_decisions.json` if the driver
   * archived one. Captures the per-stage resolver trace + cli_flags +
   * profile_policy snapshot so the replayer can re-issue with identical
   * tier choices. null if the artifact is absent (legacy runs).
   */
  tier_resolution: unknown;
  /**
   * Per-run CLI flags parsed at /pp:run invocation (--tier-cap,
   * --tier-floor, --no-tier-policy, …). Mirrors runs.cli_flags_json. null
   * on legacy rows or runs that passed no recognized flags.
   */
  cli_flags: unknown;
  reproduction_notes: string;
};

export function buildReplayBundle(run_id: string): ReplayBundle | null {
  const run = db().prepare(`SELECT * FROM runs WHERE id = ?`).get(run_id) as
    | {
        id: string; request_text: string; project_path: string; team: string | null;
        mode: string; forum: string | null; n: number | null; status: string;
        head_sha: string | null; tree_dirty_hash: string | null;
        profile_snapshot_json: string | null; taxonomy_mapping_json: string | null;
        cli_versions_json: string | null;
        cli_flags_json: string | null;
        started_at: string; finished_at: string | null;
      }
    | undefined;
  if (!run) return null;

  const stages = db().prepare(`SELECT * FROM stages WHERE run_id = ? ORDER BY started_at ASC`).all(run_id) as Array<{
    id: string; kind: string; gate_type: string; status: string;
  }>;
  const stageBundles = stages.map(s => {
    const attempts = db().prepare(`SELECT * FROM attempts WHERE stage_id = ? ORDER BY created_at ASC`).all(s.id) as Array<{
      id: string; producer: string; model_id: string; attempted_tier: string | null;
      retry_index: number; parent_attempt_id: string | null;
      tokens_in: number | null; tokens_out: number | null; cost_usd: number | null;
    }>;
    const attemptBundles = attempts.map(a => {
      const verdicts = db().prepare(`SELECT judge_producer, judge_model_id, rubric_id, outcome, cross_vendor FROM verdicts WHERE attempt_id = ? ORDER BY created_at ASC`).all(a.id) as Array<{
        judge_producer: string; judge_model_id: string; rubric_id: string | null; outcome: string; cross_vendor: number;
      }>;
      return {
        id: a.id, producer: a.producer, model_id: a.model_id,
        attempted_tier: a.attempted_tier,
        retry_index: a.retry_index, parent_attempt_id: a.parent_attempt_id,
        tokens_in: a.tokens_in, tokens_out: a.tokens_out, cost_usd: a.cost_usd,
        verdicts: verdicts.map(v => ({ ...v, cross_vendor: v.cross_vendor === 1 })),
      };
    });
    return { id: s.id, kind: s.kind, gate_type: s.gate_type, status: s.status, attempts: attemptBundles };
  });

  const artifacts = db().prepare(`SELECT kind, path, sha256 FROM artifacts WHERE run_id = ? ORDER BY created_at ASC`).all(run_id) as Array<{
    kind: string | null; path: string; sha256: string;
  }>;

  const profile = run.profile_snapshot_json ? safeJson(run.profile_snapshot_json) : null;
  const taxonomy = run.taxonomy_mapping_json ? safeJson(run.taxonomy_mapping_json) : null;
  const cliVersions = run.cli_versions_json ? safeJson(run.cli_versions_json) : null;
  const cliFlags = run.cli_flags_json ? safeJson(run.cli_flags_json) : null;

  // Tier-decision plan archived per /pp:run step 5b. Best-effort read; if
  // the file moved or the driver didn't write it on this run, surface
  // null rather than failing the whole replay bundle.
  let tierResolution: unknown = null;
  try {
    const tierPath = join(projectArtifactDir(run.project_path, run.id), "tier_decisions.json");
    if (existsSync(tierPath)) {
      tierResolution = safeJson(readFileSync(tierPath, "utf8"));
    }
  } catch { /* ignore */ }

  return {
    run_id: run.id,
    request_text: run.request_text,
    project_path: run.project_path,
    team: run.team,
    mode: run.mode,
    forum: run.forum,
    n: run.n,
    status: run.status,
    head_sha: run.head_sha,
    tree_dirty_hash: run.tree_dirty_hash,
    profile_snapshot: profile,
    taxonomy_mapping: taxonomy,
    cli_versions: cliVersions,
    started_at: run.started_at,
    finished_at: run.finished_at,
    stages: stageBundles,
    artifacts,
    tier_resolution: tierResolution,
    cli_flags: cliFlags,
    reproduction_notes:
      `To replay: 1) git checkout ${run.head_sha ?? "<head_sha unknown>"}; ` +
      `2) verify CLI versions match cli_versions; ` +
      `3) reissue the request via /pp:run with the original request_text, any team/forum, ` +
      `and re-pass cli_flags (--tier-cap/--tier-floor) verbatim; ` +
      `4) compare new artifact sha256s against artifacts[].sha256.`,
  };
}

function safeJson(s: string): unknown {
  try { return JSON.parse(s); } catch { return null; }
}
