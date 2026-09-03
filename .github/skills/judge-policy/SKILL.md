---
name: judge-policy
description: Tiered cross-vendor vs same-vendor judge policy. Read this before invoking any judge so the gate is enforced correctly. Loaded on demand by the `pair-programmer` skill. Authoritative source is `mcp__pp_harness__gate_eligible_judges`; this document explains why the policy is the way it is.
---

<!-- Generated from .claude\skills\judge-policy.md. Edit the .claude source file and rerun node scripts/sync-copilot-assets.mjs. -->

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

When the global agy kill-switch is set, `doctor()` reports `vendors_configured.google=false` and `agy_disabled=true`, and `gate_eligible_judges` drops agy from `allowed_judges[].preferred_producers`. Cross-vendor judging therefore routes to **Codex only** (the default pair is Codex + Claude, so cross-vendor gates still run), and the agy same-vendor lane is unavailable in either direction. When agy is disabled the second Borda judge at N ≥ 3 is the other eligible cross-vendor lane, and the run summary MUST state the substitution (JUDGE-1). The `preferred_producers` list returned by `gate_eligible_judges` is **authoritative** — it overrides any team yaml `model_pref: agy` hint when agy is disabled. Re-enable by unsetting the flag (and re-authenticating the agy CLI).

## De-biasing in best-of-N

When `N ≥ 3`, the daemon randomizes the candidate order before sending them to the judge (Fisher-Yates with a seeded RNG; the seed is recorded for replay). The judge produces a ranking; the daemon runs **Borda count** to pick the winner. This mitigates position bias.

For best-of-2, the driver should ask the judge for a structured rubric score per candidate first, THEN ask for a pick — never the other way around — to mitigate verbosity bias.

## Self-bias

**Self-judging on an identical model id is rejected for every producer.** `record_verdict` throws when the judge's producer equals the attempt's producer AND `judge_model_id` equals the generator's `model_id`. Producers are normalized on both sides first, so the legacy `gemini` alias cannot evade the guard by spelling itself differently. The agy exemption that used to sit on this guard was removed in J4 — it existed only while agy had a single pinned critique id.

- **Codex:** `pp_codex.critique` defaults to `gpt-5.6-terra` (JUDGE-1) and accepts any id on `JUDGE_MODEL_POLICY.codex.allowed_models` (`gpt-5.6-terra`, `gpt-5.6-sol`, `gpt-5.6-luna`) via an allow-listed operator override or `escalate: true`. Same-vendor Codex judging is legal whenever the resolved judge id differs from the generator's — which the default generator pin (`gpt-5.6-luna`) satisfies, so the ordinary Codex→Codex route stands. If the generator already ran `gpt-5.6-terra`, judge on a different allow-listed id or route the verdict to the other vendor.
- **agy:** `pp_agy.critique` defaults to `gemini-3.8-flash-medium` and escalates to `gemini-3.1-pro-high`; the full allow-list is `gemini-3.8-flash-{high,medium,low}`, `gemini-3.7-flash-{high,medium,low}`, `gemini-3.1-pro-{high,low}`. Because agy now serves a default AND an escalated critique id, same-vendor agy judging must pick a *different* allow-listed id (normally the escalated pro lane, recorded with `judge_model_source: "escalated"`) — there is no same-model exemption. agy expresses reasoning effort through the id suffix: the daemon canonicalizes a bare family + effort onto the suffixed id and never passes `--effort`. `doctor()` verifies each pin against `agy models` and reports `agy_pin_served` with a `per_pin` breakdown (`critique_default`, `critique_escalated`, `generate`); a false value marks google `vendor_degraded`.
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
agy). The same-producer same-model guard in `recordVerdict` (`daemon/src/orchestrator/runs.ts`) already blocks fable-judges-fable,
but the team yaml must not even request it.

Pricing: conservative placeholder at 2× opus rates. Confirm with Anthropic before
production budget projections.

## Escalated judging (opt-in, both vendors)

The judge MAY set `escalate: true` on **either** `pp_codex.critique` or `pp_agy.critique` for sanctioned hard gates only:

- **Major-scope security or architecture gates** — e.g. OWASP/ASVS-L2, ArchRFC with PHI or cryptographic scope.
- **Judge of last resort / final Reflexion retry** — when a stage has exhausted its Reflexion budget and is still `revise`, the driver may escalate for the deciding verdict.

The lanes (source of truth: `JUDGE_MODEL_POLICY` in `daemon/src/config.ts`; `DEFAULT_MODELS` is derived from it):

| Vendor | Default lane (JUDGE-1) | Escalated lane (`escalate: true`) | Allowed critique ids | Allowed efforts |
|---|---|---|---|---|
| `codex` | `gpt-5.6-terra` @ `medium` | `gpt-5.6-sol` @ `medium` | `gpt-5.6-terra`, `gpt-5.6-sol`, `gpt-5.6-luna` | `low`, `medium`, `high`, `xhigh` |
| `agy` | `gemini-3.8-flash-medium` | `gemini-3.1-pro-high` | `gemini-3.8-flash-{high,medium,low}`, `gemini-3.7-flash-{high,medium,low}`, `gemini-3.1-pro-{high,low}` | `low`, `medium`, `high` |

The defaults **remain the JUDGE-1 pins** for all ordinary gates. `escalate` is a boolean selecting the vendor's pinned escalated lane — it is **mutually exclusive with `model`**, and the bridge rejects the pair.

A caller-passed `model` string is no longer ignored: it is validated against the vendor's `allowed_models`, honored when it is on the list, and **throws at the bridge** when it is not (it is never silently replaced by the pin). Legal ids come from `doctor().judge_capabilities[<vendor>].allowed_critique_models`. An allow-listed model or effort still needs an override source and reason — see below.

## Operator overrides (JUDGE-1a)

`CONSTITUTION.md` Article V **JUDGE-1a** (amended 2026-09-03, SHA `5df284cb`) permits an explicit operator override of judge vendor, model, or reasoning effort — and nothing else.

**Flags** (accepted by `/pp:run`, `/pp:team`, `/pp:best-of`, `/pp:gate`, `/pp:retry`, `/pp:review`):

| Flag | Values |
|---|---|
| `--judge-vendor=` | `codex` \| `agy` (`claude` is invalid — every gate is cross-vendor) |
| `--judge-model=` | an id on that vendor's `allowed_models` |
| `--judge-effort=` | `low` \| `medium` \| `high` \| `xhigh` (`xhigh` is Codex-only) |
| `--judge-escalate` | boolean; selects the vendor's escalated lane. Mutually exclusive with `--judge-model` |
| `--judge-reason="…"` | ≥ 8 characters; required whenever `--judge-model` or `--judge-effort` is given |

**Precedence**, resolved per field (`vendor`, `model`, `reasoning_effort`, `escalate`), lowest first:

1. **Daemon default** — `override_source: "default"` (or `"escalated"` when the escalated lane was chosen without an operator override).
2. **Team yaml `judge.{model,reasoning_effort,escalate}`** — validated at team load — `override_source: "team_yaml"`.
3. **CLI flag** — `override_source: "cli"`. `"hydra"` is the equivalent channel for an override arriving on a Hydra `DevTask` envelope.

A layer that does not set a field leaves the lower layer's value intact. **There is no prompt layer** — overrides are never inferred from request prose; a matching phrase only makes the driver print one hint line naming the equivalent flag before continuing with the defaults.

**What is recorded.** `record_verdict` stores `judge_reasoning_effort`, `judge_model_source` (`default` | `escalated` | `cli` | `team_yaml` | `hydra`) and `judge_override_reason` (required at ≥ 8 characters for `cli` | `team_yaml` | `hydra`) on the verdict row; replay and the TheEights `DecisionRecord` carry them. The per-stage resolution is written to `judge_decisions.json` (taxonomy 4.14) and the CLI flags are persisted on the run row as `cli_flags`. The judge agent MUST read the effective `model` / `reasoning_effort` / `override_source` / `override_reason` (and Codex's `pin_mismatch`) from the **critique result envelope**, never from its own request.

**Rejection reasons** (from `judge-router`, returned as `override_status: "rejected"`; the driver aborts the run rather than falling back to the default judge): `reason_missing`, `cross_vendor_impossible` (the override names the generator's own vendor), `agy_disabled` (`PP_DISABLE_AGY=1`), `model_not_allowed`, `same_model_as_generator`. An override can never downgrade a cross-vendor gate to same-vendor.

## Keeping the pins current

**Repin in exactly one place: `JUDGE_MODEL_POLICY` in `daemon/src/config.ts`.** `DEFAULT_MODELS` is derived from it; every other mention in the repo is a **mirror** and must be updated in the same change.

Procedure:

1. Edit `JUDGE_MODEL_POLICY` (defaults, escalated lanes, `allowed_models`, `allowed_efforts`). Update `daemon/prices.json` for any newly reachable id.
2. Run `agy models` and `codex --version` to confirm the CLIs actually serve the new ids. **agy 1.1.24 rejects unknown AND retired ids** — exit 1, status `ERROR`, `"invalid model selection"`. There is no silent fallback to a CLI default.
3. Run `/pp:doctor --smoke` and check `agy_pin_served` (with its `per_pin` breakdown), `codex_pin_served`, `unpriced_models`, and `judge_capabilities[<vendor>]`.
4. Update every mirror below, then run `scripts/sync-copilot-assets.mjs` to propagate the `.claude/**` surface into the `.github/**` Copilot mirror.

Mirror checklist:

- `AGENTS.md` (and `CLAUDE.md` inherits via `@AGENTS.md`)
- `ARCHITECTURE.md` §5.1 / §5.2 (including the mermaid and ascii diagrams)
- `docs/USER_GUIDE.md`
- `docs/validator-policy.md`
- `.claude/skills/judge-policy.md` (this file)
- `.github/skills/pair-programmer/SKILL.md`
- `.claude/skills/profile-aware-gating.md`
- `.claude/skills/rubric-application.md`
- `.github/agents/judge-cross-vendor.agent.md`
- `.github/agents/judge-same-vendor.agent.md`
- `.github/agents/judge-router.agent.md`
- `README.md`
- `PROJECT_MASTER.md` (dated append; never rewrite history)
- `.github/**` — generated, never hand-edited; regenerate via `scripts/sync-copilot-assets.mjs`

`CONSTITUTION.md` is **not** on this checklist: the JUDGE-1 / JUDGE-1a pins change there only through the HITL `/pp:constitution amend` path, and every mirror then quotes the new SHA.

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
