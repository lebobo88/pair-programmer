# Profiles — authoring guide

A profile is a YAML file at `<project>/.harness/profile.yaml` declaring the project type. The harness reads it at run start, persists the snapshot into `runs.profile_snapshot_json` for replay, and applies overrides on every gate.

## Built-ins (10)

`web-ui`, `api-platform`, `internal-tool`, `enterprise`, `ai-agentic`, `mobile`, `sdk`, `data-product`, `embedded`, `non-ui-cli`. See `.claude/profiles/*.yaml` for the templates.

## Schema

```yaml
name: web-ui                         # one of the 10 built-in names (or a custom one)
description: ...
required_taxonomy_sections: ["4.4", "4.13"]
required_rubrics:                    # gate_type → rubric_id
  design: wcag-2.2-aa@1
required_artifacts:                  # canonical artifact kinds the run must produce
  - screen_state_matrix
  - localization_plan
required_missability_checks:         # check ids forced for every run
  - ui-error-empty-loading
  - accessibility-localization
notes: ...
```

## How fields are interpreted

- `required_taxonomy_sections` — `taxonomy-mapper` agent SHOULD include these sections in every mapping.
- `required_rubrics` — `gate_eligible_judges` reads this map first; if no entry for the active gate type, the daemon falls back to a built-in default.
- `required_artifacts` — `missability-inspector` ensures these artifact kinds appear at least once during the run.
- `required_missability_checks` — appended to the run's `missability_required` set so they're forced even when the heuristic mapper wouldn't include them.

## Cross-vendor escalation

Two profile-driven escalations live in `gate_eligible_judges`:
- `enterprise` → cross-vendor on every gate.
- `ai-agentic` → cross-vendor on any gate touching evals or tool permissions.

These escalations are unconditional — they cannot be downgraded by team yaml or by a `tier: same_vendor` hint.

## Custom profile

Drop your own YAML at `<project>/.harness/profile.yaml` with any name (it does NOT need to be one of the 10 built-ins). The daemon will load it as-is and apply the fields above. The `gate_eligible_judges` content-aware upgrade still runs on top.
