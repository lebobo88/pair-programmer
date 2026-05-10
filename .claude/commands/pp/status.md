---
description: List recent pair-programmer harness runs, or show the full tree for one run.
argument-hint: [run_id]
---

If $ARGUMENTS is empty, call `mcp__pp_harness__list_runs` with `project_path` set to the current working directory and `limit=20`. Render as:

| run_id | mode | team | status | started_at | request (first 60 chars) |

If $ARGUMENTS is a `run_id`, call `mcp__pp_harness__get_run` with it and render:
- run header (project, mode, status, started/finished, head_sha, cli_versions)
- stages table (kind, gate_type, status, winner_attempt_id)
- attempts table (producer, model_id, retry_index, status, tokens, cost)
- verdicts table (judge_producer, outcome, cross_vendor)
- artifacts table (kind, path, sha256[..12], bytes)
