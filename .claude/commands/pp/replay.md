---
description: Reconstruct the full prompt set + model/CLI versions + artifact hashes for a past run so it can be replayed reproducibly.
argument-hint: <run_id>
---

**Delegation contract:** All MCP tool access flows through sub-agent delegation per the Delegation Contract in `pair-programmer.md` (the master skill). Do not bypass. `PP_ALLOW_AD_HOC=1` is daemon-developer-debug only and MUST NOT be proposed as a remedy in this lifecycle.

Parse $ARGUMENTS as `run_id`.

1. Call `mcp__pp_harness__replay` with that id. Returns a full bundle: request_text, head_sha, profile_snapshot, taxonomy_mapping, cli_versions, all stages → attempts → verdicts (with `attempted_tier`), all artifacts (paths + sha256), `tier_resolution` (parsed `tier_decisions.json` if present), `cli_flags` (the original `--tier-cap`/`--tier-floor`/`--no-tier-policy` values), and reproduction_notes.
2. Render to the user:
   - Header: run_id, started_at, status, mode, team/forum
   - HEAD SHA + dirty-tree hash
   - CLI versions table
   - Profile snapshot summary (including `model_tier_policy` if set)
   - **CLI flags** (verbatim — empty if none captured)
   - Taxonomy mapping (sections produced, missability owed)
   - Stages tree (kind | gate_type | status | attempts → verdicts). For each attempt, include `attempted_tier` next to `model_id` (e.g. `claude-sonnet-4-6 (sonnet)`).
   - **Tier resolution** — if `tier_resolution` is non-null, render the per-stage trace so the user can see which override layer set each tier. Highlight any retry escalations.
   - Artifacts (kind | path | sha256[..12])
3. Print the reproduction_notes block verbatim.
4. Offer to: invoke `/pp:run` (or `/pp:team` / `/pp:review`) with the saved request_text + the original profile/team/forum to start a fresh run that can be diff'd against the original. **Re-pass the captured `cli_flags` verbatim** — without them, a `--tier-cap=sonnet` run replays at the agent-default tier and the diff will be noisy.
