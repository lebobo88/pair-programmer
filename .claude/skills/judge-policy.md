---
name: judge-policy
description: Tiered cross-vendor vs same-vendor judge policy. Read this before invoking any judge so the gate is enforced correctly. Loaded on demand by the `pair-programmer` skill. Authoritative source is `mcp__pp_harness__gate_eligible_judges`; this document explains why the policy is the way it is.
---

# Judge policy (tiered + content-aware + profile-aware)

The driver MUST call `mcp__pp_harness__gate_eligible_judges` before invoking any judge. This document is the human-readable summary; the decision the driver applies comes from the daemon, not from this file.

## Base tier (per `gate_type`)

| `gate_type` | Cross-vendor required? |
|---|---|
| `spec` | YES |
| `design` | YES |
| `security` | YES |
| `contract` | YES |
| `code_style` | NO (same-vendor different-model OK) |
| `docs_polish` | NO |
| `lint_class` | NO |

## Content-aware upgrades

Even when the base tier is "same-vendor OK", the daemon scans the prompt keywords for a regex set covering security, concurrency, data integrity, authentication, and migration vocabulary. A match upgrades the gate to **cross-vendor required**, regardless of base tier. The decision returned by `gate_eligible_judges` carries `upgraded: true` and a `reason` string.

Keyword groups that trigger upgrade:
- security: `security`, `threat`, `owasp`, `cve`, `rbac`, `crypto`, `privacy`, `gdpr`, `sbom`, `injection`, `xss`, `csrf`, `sqli`, `hipaa`, `pci`, `pii`, `phi`, `sox`, `password`, `credential`, `oauth`, `openid`, `saml`, `jwt`, `sso`, `auth`
- concurrency / data-integrity: `concurren*`, `thread`, `race`, `deadlock`, `atomic`, `mutex`, `lock`, `migration*`, `schema`, `rollback`

## Profile-aware upgrades

- `enterprise` profile → cross-vendor on **every** gate (no same-vendor escape).
- `ai-agentic` profile → cross-vendor on any gate touching evals or tool permissions (regex on `eval`, `tool_permission`, `hitl`).

Other profiles do not change tier directly; they bind specific rubrics (e.g. `web-ui` → WCAG on design gates).

## Vendor matrix

If the harness has only one configured vendor (`mcp__pp_harness__doctor` returns `cross_vendor_ready: false`), every cross-vendor gate REFUSES to run. The driver must STOP, surface a clear error, and ask the user to configure the missing vendor (set `OPENAI_API_KEY` + `GEMINI_API_KEY` or run `codex login` / `gemini auth`).

The daemon will not silently downgrade a security/spec/design/contract gate to same-vendor.

## De-biasing in best-of-N

When `N ≥ 3`, the daemon randomizes the candidate order before sending them to the judge (Fisher-Yates with a seeded RNG; the seed is recorded for replay). The judge produces a ranking; the daemon runs **Borda count** to pick the winner. This mitigates position bias.

For best-of-2, the driver should ask the judge for a structured rubric score per candidate first, THEN ask for a pick — never the other way around — to mitigate verbosity bias.

## Self-bias

A generator and judge from the same vendor must use **different model ids**. The Codex/Gemini wrappers default to a slightly different model for `critique` than for `generate`; if the driver overrides, it MUST keep them distinct.

## What the driver actually does

1. Call `gate_eligible_judges(gate_type, generator_producer, prompt_keywords, profile, artifact_kind)`.
2. Read `required_cross_vendor`, `rubric_id`, and `allowed_judges`.
3. If `required_cross_vendor` and the generator was Codex → invoke `judge-cross-vendor` (which calls `pp_gemini.critique`). If the generator was Gemini → `judge-cross-vendor` calls `pp_codex.critique`.
4. If `required_cross_vendor` is false → invoke `judge-same-vendor` (which calls `pp_<same>.critique` with a different `model_id`).
5. The judge fetches the rubric body via `mcp__pp_harness__get_rubric(rubric_id)` and applies it to score the artifact.
6. Verdict recorded via `record_verdict`. The daemon computes the `cross_vendor` flag from `judge_producer` vs `attempt.producer` and stores it.

## Reading the verdict

A pass requires every rubric dimension ≥ 0.7 (per the rubric's own scoring envelope; see `rubric-application.md`). If any dimension is below the rubric's minimum (some rubrics enforce ≥ 0.5 for specific dimensions), the judge MUST emit `outcome: "fail"`, not `revise`. `revise` is for the soft band where Reflexion is most likely to help.
