# Validator policy — reference

The driver MUST call `mcp__pp_harness__gate_eligible_judges` before invoking any judge. The daemon's decision is authoritative.

## Decision inputs

- `gate_type` — `spec | design | security | contract | code_style | docs_polish | lint_class`
- `generator_producer` — `codex | gemini | claude | <subagent name>`
- `prompt_keywords` — typically the user request text
- `profile` — the profile snapshot's `name` (when set)
- `artifact_kind` — the canonical artifact kind being judged (when known)

## Base tier

| `gate_type` | Cross-vendor required by base tier |
|---|---|
| spec, design, security, contract | YES |
| code_style, docs_polish, lint_class | NO |

## Upgrades (any can flip same-vendor → cross-vendor)

- **Content-aware**: regex over the prompt for security / concurrency / data-integrity / auth / migration vocabulary.
- **Profile-aware**: `enterprise` → all gates cross-vendor; `ai-agentic` → cross-vendor on eval or tool-permission gates.

## Decision payload

The tool returns:

```jsonc
{
  "required_cross_vendor": true,
  "base_tier":             "cross_vendor" | "same_vendor",
  "upgraded":              true,
  "reason":                "content keyword: oauth",
  "rubric_id":             "owasp-asvs-l1@1",
  "allowed_judges": [
    { "agent": "judge-cross-vendor", "preferred_producers": ["gemini"] }
  ]
}
```

The driver MUST honor `required_cross_vendor`. The team yaml's `judge.tier` is a hint that applies only when consistent with the daemon decision.

## Borda count for N≥3

When the run is best-of-N with N≥3, the driver collects rankings from one or more judges and calls `mcp__pp_harness__borda_count` to pick the winner. Candidate order is randomized server-side at `start_best_of_stage` (Fisher-Yates with a seeded RNG; the seed is recorded for replay).
