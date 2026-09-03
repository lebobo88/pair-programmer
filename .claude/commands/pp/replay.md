---
description: Reconstruct the full prompt set + model/CLI versions + artifact hashes for a past run so it can be replayed reproducibly.
argument-hint: <run_id>
---

**Delegation contract:** All MCP tool access flows through sub-agent delegation per the Delegation Contract in `pair-programmer.md` (the master skill). Do not bypass. `PP_ALLOW_AD_HOC=1` is daemon-developer-debug only and MUST NOT be proposed as a remedy in this lifecycle.

Parse $ARGUMENTS as `run_id`.

1. Call `mcp__pp_harness__replay` with that id. Returns a full bundle: request_text, head_sha, profile_snapshot, taxonomy_mapping, cli_versions, all stages → attempts → verdicts (with `attempted_tier`), all artifacts (paths + sha256), `tier_resolution` (parsed `tier_decisions.json` if present), `cli_flags` (the original `--tier-cap`/`--tier-floor`/`--no-tier-policy` and `--judge-vendor`/`--judge-model`/`--judge-effort`/`--judge-escalate`/`--judge-reason` values, from `runs.cli_flags_json`), and reproduction_notes.

1b. **Recover the judge flags.** Read `judge_decisions.json` from the run's artifacts (kind `judge_decisions`). Its `cli_flags` block is the AUTHORITATIVE record of the judge overrides — prefer it over `runs.cli_flags_json`, which is the fallback when the artifact is absent (a run that aborted before its first verdict, or one from before J10 landed). Also capture its `per_stage[]` for the render below.
2. Render to the user:
   - Header: run_id, started_at, status, mode, team/forum
   - HEAD SHA + dirty-tree hash
   - CLI versions table
   - Profile snapshot summary (including `model_tier_policy` if set)
   - **CLI flags** (verbatim — empty if none captured)
   - Taxonomy mapping (sections produced, missability owed)
   - Stages tree (kind | gate_type | status | attempts → verdicts). For each attempt, include `attempted_tier` next to `model_id` (e.g. `claude-sonnet-5 (sonnet)`).
   - **Tier resolution** — if `tier_resolution` is non-null, render the per-stage trace so the user can see which override layer set each tier. Highlight any retry escalations.
   - **Judge resolution** — if `judge_decisions.json` was found, render its `per_stage[]` as `stage | judge_agent | resolved vendor/model@effort | source | reason | trace | verdict outcome | cross_vendor`. Highlight any row with `source != "default"` and any `pin_mismatch: true`. Also show the recorded `allowed_critique_models` so the user can see which ids were legal at the time of the run.
   - Artifacts (kind | path | sha256[..12])
3. Print the reproduction_notes block verbatim.
4. Offer to: invoke `/pp:run` (or `/pp:team` / `/pp:review`) with the saved request_text + the original profile/team/forum to start a fresh run that can be diff'd against the original. **Re-pass the captured `cli_flags` verbatim** — without them, a `--tier-cap=sonnet` run replays at the agent-default tier and the diff will be noisy.
   - **Re-issue the judge flags too**, rebuilt from `judge_decisions.json.cli_flags` (falling back to `runs.cli_flags_json`): `--judge-vendor=<judge_vendor>`, `--judge-model=<judge_model>`, `--judge-effort=<judge_effort>`, `--judge-escalate` (when `judge_escalate` is true), `--judge-reason="<judge_reason>"`. Emit only the fields that were actually set; a null field means the run took that field's default and the replay must not invent one. Because `--judge-reason` is required alongside `--judge-model`/`--judge-effort`, a captured reason MUST be re-issued verbatim — dropping it turns the replay into a parse-time STOP. If the original judge model is no longer in `doctor().judge_capabilities[<vendor>].allowed_critique_models`, say so explicitly: the run is not byte-reproducible, and the operator must choose a current id rather than have one silently substituted.
