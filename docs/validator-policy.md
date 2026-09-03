# Validator policy — reference

The driver MUST call `mcp__pp_harness__gate_eligible_judges` before invoking any judge. The daemon's decision is authoritative.

## Decision inputs

- `gate_type` — `spec | design | security | contract | code_style | docs_polish | lint_class`
- `generator_producer` — `codex | agy | claude | <subagent name>`
- `generator_model` — optional but recommended; if omitted, the daemon infers Codex/agy defaults where possible
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
- **Capability-aware**: if same-vendor would be impossible for the chosen vendor/model pairing, the daemon upgrades to cross-vendor instead of letting the run discover the contradiction later. Judge models are governed by the per-vendor policy object `JUDGE_MODEL_POLICY` (`daemon/src/config.ts`) — a JUDGE-1 default (Codex `gpt-5.6-terra`, agy `gemini-3.8-flash-medium`), an escalated lane reached with `escalate: true` (`gpt-5.6-sol`, `gemini-3.1-pro-high`), and a per-vendor allow-list an operator may override into under JUDGE-1a (a non-allow-listed id throws at the bridge). Same-producer + same-model verdicts are rejected for **every** producer, so a same-vendor route is only available when an allow-listed id differs from `generator_model`. Example: with `generator_model = gpt-5.6-terra` the Codex lane must judge on a different allow-listed id or be upgraded to cross-vendor; the default Codex generator pin is `gpt-5.6-luna`, so the ordinary Codex→Codex same-vendor route stays legal.

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
    { "agent": "judge-cross-vendor", "preferred_producers": ["agy"] }
  ]
}
```

The driver MUST honor `required_cross_vendor`. The team yaml's `judge.tier` is a hint that applies only when consistent with the daemon decision.

## Borda count for N≥3

When the run is best-of-N with N≥3, the driver collects rankings from one or more judges and calls `mcp__pp_harness__borda_count` to pick the winner. Candidate order is randomized server-side at `start_best_of_stage` (Fisher-Yates with a seeded RNG; the seed is recorded for replay).
