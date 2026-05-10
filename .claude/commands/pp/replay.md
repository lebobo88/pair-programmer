---
description: Reconstruct the full prompt set + model/CLI versions + artifact hashes for a past run so it can be replayed reproducibly.
argument-hint: <run_id>
---

**Delegation contract:** All MCP tool access flows through sub-agent delegation per the Delegation Contract in `pair-programmer.md` (the master skill). Do not bypass. `PP_ALLOW_AD_HOC=1` is daemon-developer-debug only and MUST NOT be proposed as a remedy in this lifecycle.

Parse $ARGUMENTS as `run_id`.

1. Call `mcp__pp_harness__replay` with that id. Returns a full bundle: request_text, head_sha, profile_snapshot, taxonomy_mapping, cli_versions, all stages → attempts → verdicts, all artifacts (paths + sha256), and reproduction_notes.
2. Render to the user:
   - Header: run_id, started_at, status, mode, team/forum
   - HEAD SHA + dirty-tree hash
   - CLI versions table
   - Profile snapshot summary
   - Taxonomy mapping (sections produced, missability owed)
   - Stages tree (kind | gate_type | status | attempts → verdicts)
   - Artifacts (kind | path | sha256[..12])
3. Print the reproduction_notes block verbatim.
4. Offer to: invoke `/pp:run` (or `/pp:team` / `/pp:review`) with the saved request_text + the original profile/team/forum to start a fresh run that can be diff'd against the original.
