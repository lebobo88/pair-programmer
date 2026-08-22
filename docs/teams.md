# Teams — authoring guide

A team is a YAML file under `.claude/teams/<name>.yaml`. Resolution order: `<project>/.claude/teams/` → `~/.claude/teams/` → built-in `<repo>/.claude/teams/`. The first match wins.

## Schema

```yaml
name: feature-team                  # filename must match
description: ...
profiles_compatible: [web-ui, api-platform]    # optional whitelist
stages:
  - kind: spec                      # one of the pipeline kinds (see daemon/src/db/schema.sql)
    gate_type: spec                 # one of spec | design | security | contract | code_style | docs_polish | lint_class
    generator:
      agent: spec-author            # an agent in .claude/agents/
      primary: claude               # codex | agy | claude (soft preference)
      binding_strict: false         # true → fail closed if primary unavailable
    judge:
      tier: cross_vendor            # cross_vendor | same_vendor (the daemon's gate decision overrides this)
      rubric: rfc-2119-normative@1  # optional; the daemon will pick a default if omitted
  - kind: code
    gate_type: code_style
    generator: { agent: engineer, primary: codex }
    judge:     { tier: same_vendor }
taxonomy_required: ["4.3", "4.6", "4.7", "4.10", "4.13"]
missability_required: [nfrs-declared, schema-evolution]
```

## Built-in team catalog

25 teams ship with the harness — 18 generic + 7 game-dev (`game-dev*` profiles only). Generic: `strategy-team`, `discovery-team`, `feature-team`, `feature-team-tdd`, `bug-fix-team`, `refactor-team`, `ux-team`, `design-system-team`, `data-team`, `security-review-team`, `release-team`, `ops-team`, `docs-team`, `governance-team`, `ai-controls-team`, `retirement-team`, `marketing-team`, `deep-reasoning-team` (Fable-5, explicit-only). Game-dev: `game-feature-team`, `game-bug-fix-team`, `game-refactor-team`, `game-cert-team`, `game-live-ops-team`, `game-accessibility-team`, `game-netcode-team`. See `docs/USER_GUIDE.md` §9 for the full catalog.

`/pp:teams` lists what's available; `/pp:team <name> <request>` runs the pipeline.

## Custom team example

Drop the file at `<project>/.claude/teams/migration-team.yaml`. The daemon picks it up automatically — no daemon restart required.
