---
name: judge-policy
description: Tiered cross-vendor vs same-vendor judge policy. Read this before invoking any judge so the gate is enforced correctly. Loaded on demand by the `pair-programmer` skill. Authoritative source is `mcp__pp_harness__gate_eligible_judges`; this document explains why the policy is the way it is.
---

# Judge policy (tiered + content-aware + profile-aware)

The driver MUST call `mcp__pp_harness__gate_eligible_judges` before invoking any judge. This document is the human-readable summary; the decision the driver applies comes from the daemon, not from this file.

## Base tier (per `gate_type`)

Cross-vendor judging is required at **every** gate. Per `CONSTITUTION.md` Article V
**JUDGE-1** (amended 2026-09-03, SHA `5df284cb`), there is no gate type that may close
on a same-vendor verdict.

| `gate_type` | Cross-vendor required? |
|---|---|
| `spec` | YES |
| `design` | YES |
| `security` | YES |
| `contract` | YES |
| `code_style` | YES |
| `docs_polish` | YES |
| `lint_class` | YES |

`gate_eligible_judges` returns `required_cross_vendor: true` for every gate type and
marks the same-vendor lane `closing: false`.

## Same-vendor lane is supplementary

`judge-same-vendor` may still be invoked for an extra opinion — a cheap second read, a
style pass, a sanity check before spending a cross-vendor call. Its verdict is
**never** the one that closes a stage: per **JUDGE-2**, a same-vendor-only verdict
cannot satisfy `finalize_stage(passed)`, which requires at least one
`cross_vendor=true` verdict with `outcome=pass`. The driver therefore routes the
closing verdict only to `judge-cross-vendor`.

## Content-aware rubric selection

The prompt-keyword regex set no longer changes the judge tier — every gate is already
cross-vendor. It now feeds **rubric selection**: a keyword match tells the daemon which
rubric family the gate belongs to, and `pickDefaultRubric` returns the matching
security / concurrency / data-integrity rubric instead of the generic default. The
decision returned by `gate_eligible_judges` carries the selected `rubric_id` and a
`reason` string.

Keyword groups that select a stricter rubric:
- security: `security`, `threat`, `owasp`, `cve`, `rbac`, `crypto`, `privacy`, `gdpr`, `sbom`, `injection`, `xss`, `csrf`, `sqli`, `hipaa`, `pci`, `pii`, `phi`, `sox`, `password`, `credential`, `oauth`, `openid`, `saml`, `jwt`, `sso`, `auth`
- concurrency / data-integrity: `concurren*`, `thread`, `race`, `deadlock`, `atomic`, `mutex`, `lock`, `migration*`, `schema`, `rollback`

## Profile-aware rubric selection

Profiles no longer raise a tier (there is nothing to raise — every gate is cross-vendor).
They bind **stricter rubrics**:

- `enterprise` profile → the strictest available rubric on every gate.
- `ai-agentic` profile → the eval / tool-permission rubric family on any gate matching `eval`, `tool_permission`, `hitl`.
- `web-ui` profile → WCAG rubrics on design gates.

## Vendor matrix

If the harness has only one configured vendor (`mcp__pp_harness__doctor` returns `cross_vendor_ready: false`), every cross-vendor gate REFUSES to run. The driver must STOP, surface a clear error, and ask the user to configure the missing vendor (set `OPENAI_API_KEY` + `GEMINI_API_KEY`/`ANTIGRAVITY_API_KEY` or run `codex login` / `agy` — agy has no separate `auth` subcommand, running it bare completes interactive Google Sign-In).

The daemon will not silently downgrade any gate to same-vendor.

### Antigravity (agy) disabled (`PP_DISABLE_AGY=1`)

When the global agy kill-switch is set, `doctor()` reports `vendors_configured.google=false` and `agy_disabled=true`, and `gate_eligible_judges` drops agy from `allowed_judges[].preferred_producers`. Cross-vendor judging therefore routes to **Codex only** (the default pair is Codex + Claude, so cross-vendor gates still run), and the degenerate same-vendor agy lane is unavailable. The `preferred_producers` list returned by `gate_eligible_judges` is **authoritative** — it overrides any team yaml `model_pref: agy` hint when agy is disabled. Re-enable by unsetting the flag (and re-authenticating the agy CLI).

## De-biasing in best-of-N

When `N ≥ 3`, the daemon randomizes the candidate order before sending them to the judge (Fisher-Yates with a seeded RNG; the seed is recorded for replay). The judge produces a ranking; the daemon runs **Borda count** to pick the winner. This mitigates position bias.

For best-of-2, the driver should ask the judge for a structured rubric score per candidate first, THEN ask for a pick — never the other way around — to mitigate verbosity bias.

## Self-bias

- **Codex:** `pp_codex.critique` is hard-pinned to `gpt-5.6-terra`. Same-vendor Codex judging is therefore only legal when the generator used a different model id — which the default generator pin (`gpt-5.6-luna`) satisfies, so the ordinary Codex→Codex route is legal. If the generator already used `gpt-5.6-terra`, the Codex lane cannot judge it at all (same producer + same model id is blocked) and the cross-vendor verdict must come from the other lane.
- **agy:** `pp_agy.critique` is hard-pinned to `gemini-3.7-flash-medium` (operator policy: 3.7 flash medium is the cross-vendor verifier model; the retired `gemini-3.1-pro-preview` pin is no longer served — finding E2-1). Same-vendor agy judging is a documented degenerate case (same model on both sides) for as long as the pin names a single critique id. `doctor()` verifies the pin against `agy models` and reports `agy_pin_served`; a false value marks google `vendor_degraded`.
- **Claude:** same-vendor Claude judging still requires a different model id from the generator.

## Fable-5 tier (capability-gated)

`fable` (`claude-fable-5`) is a dedicated tier for problems that exceed opus-class
reasoning. It is **NOT** in the `TIER_ORDER` ladder and is **NEVER** reached by
automatic `shiftTier` escalation (`shiftTier("opus", +1)` clamps at opus).

Fable is selected only via explicit operator config (there is NO `--tier fable` CLI flag, and fable is NEVER reached by automatic shiftTier ladder escalation):
1. **deep-reasoning-team** — `deep-reasoning-team.yaml` sets `generator.model_tier: fable` on every stage. Invoke via `/pp:team deep-reasoning-team "goal"` (the team name is the filename stem).
2. **Team yaml per-stage override** — any team yaml (builtin, project-local, or user-global) can set `generator.model_tier: fable` on a specific stage.
3. **Profile per-stage override** — a profile's `model_tier_policy.per_stage_override[<stage.kind>]: fable` selects fable for that stage kind. This is explicit operator-authored profile config, not auto-escalation.

The `--tier-cap` and `--tier-floor` CLI flags are explicitly skipped for off-ladder tiers (see run.md step 6a off-ladder guard: `tierIndex(initial_tier) >= 0` required before applying any cap or floor comparison). An explicit fable selection set via team yaml is therefore never clamped down to opus/sonnet/haiku by a CLI flag.

Because fable is off the ladder, the `shiftTier` defensive guard returns the tier
unchanged for `shiftTier("fable", ±N)`. Ordinary haiku→sonnet→opus ladder escalation
can never reach fable.

Judge contract for Fable-generated stages: the judge MUST be cross-vendor (Codex or
agy). The same-vendor same-model guard at `runs.ts:857` already blocks fable-judges-fable,
but the team yaml must not even request it.

Pricing: conservative placeholder at 2× opus rates. Confirm with Anthropic before
production budget projections.

## Escalated judging (opt-in)

The judge MAY set `escalate: true` on `pp_codex.critique` for sanctioned hard gates only:

- **Major-scope security or architecture gates** — e.g. OWASP/ASVS-L2, ArchRFC with PHI or cryptographic scope.
- **Judge of last resort / final Reflexion retry** — when a stage has exhausted its Reflexion budget and is still `revise`, the driver may escalate to gpt-5.6-sol for the deciding verdict.

When `escalate: true`, the server selects `gpt-5.6-sol` (pinned in `DEFAULT_MODELS.codex_critique_escalated`). The default **remains `gpt-5.6-terra` per JUDGE-1** for all ordinary gates. Arbitrary caller-passed `model` strings are still ignored — escalation is a boolean selecting between two PINNED allow-listed models, never a free-form string.

## What the driver actually does

1. Call `gate_eligible_judges(gate_type, generator_producer, generator_model?, prompt_keywords, profile, artifact_kind, rubric_hint?)`.
2. Read `required_cross_vendor`, `rubric_id`, and `allowed_judges`.
3. `required_cross_vendor` is true at every gate. If the generator was Codex → invoke `judge-cross-vendor` (which calls `pp_agy.critique`). If the generator was agy → `judge-cross-vendor` calls `pp_codex.critique`. If the generator was Claude → `judge-cross-vendor` calls `pp_codex.critique` (or `pp_agy.critique`).
4. `judge-same-vendor` may be invoked only as a supplementary extra opinion; its verdict never closes the stage (JUDGE-2).
5. `rubric_hint` is for stage-declared intent (for example a forum stage that already names `rfc-2119-normative@1` or `web-runtime-validation@2`). It does not bypass the daemon; it gives the daemon enough context to return the right `rubric_id`.
6. The judge fetches the rubric body via `mcp__pp_harness__get_rubric(rubric_id)` and applies it to score the artifact when `rubric_id` is non-null. If `rubric_id` is null, the judge falls back to its default critique rubric.
7. Verdict recorded via `record_verdict`. The daemon computes the `cross_vendor` flag from `judge_producer` vs `attempt.producer` and stores it.

## Reading the verdict

A pass requires every rubric dimension ≥ 0.7 (per the rubric's own scoring envelope; see `rubric-application.md`). If any dimension is below the rubric's minimum (some rubrics enforce ≥ 0.5 for specific dimensions), the judge MUST emit `outcome: "fail"`, not `revise`. `revise` is for the soft band where Reflexion is most likely to help.
