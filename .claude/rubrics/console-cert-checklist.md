---
id: console-cert-checklist@1
bare_id: console-cert-checklist
kind: contract
version: 1
title: "Console certification checklist (TRC / XR / Lotcheck) — non-authoritative"
source_url: https://learn.microsoft.com/en-us/gaming/gdk/docs/store/policies/xr/xr017
generated_by: pp-daemon dump-rubrics
note: This file mirrors the registry in daemon/src/rubrics/registry.ts. Do not edit by hand — regenerate.
---
# Console cert checklist rubric (NON-AUTHORITATIVE)

> ⚠️ **NON-AUTHORITATIVE.** Sony TRC, Microsoft XR, and Nintendo Lotcheck documents are NDA-protected and platform-specific. This rubric is aggregated from public sources (iXie, SandVox, Kudos QA, N-iX, the public XR-017 entry) and is intended as a pre-cert sanity check, NOT a substitute for the studio's own NDA-bound checklist.
>
> The studio is responsible for the actual cert pass. This rubric exists so AI-generated artifacts don't ship with obvious cert-fail patterns.

Score 0..1 per cluster:

- **save_data_integrity**: writes are atomic (temp-file + rename); save format has a version field with explicit migration path; corruption mid-write produces a recoverable state, not a brick.
- **controller_disconnect**: every input-bound screen handles disconnect with a "press button to reconnect" UX; dropped controllers don't strand a session.
- **suspend_resume**: Quick Resume on Xbox; sleep/dock on Switch; suspend on PlayStation. The game returns to a coherent state after resume; in-flight network calls are retried or surfaced to user.
- **store_flow**: store / IAP flow follows platform conventions; no in-game prompt that closes the platform store; receipts validated on platform service, not client.
- **region_locks**: region-restricted content is gated by user region, not just by store; profile region change does not crash.
- **age_gates**: mature-rated builds present age-gate flow per region; per-region rating shown on splash if required.
- **achievement_triggers**: trophies / achievements fire on server-authoritative events for online titles; offline games can fire client-side but only on verified completion.
- **language_switch**: UI updates on runtime locale change without restart; CJK / RTL fallback fonts present; truncation handled.
- **boot_time**: boot-to-interactive within platform-tier ceiling.
- **profile_switch**: sign-out / profile-swap mid-session does not crash or leak state.

Outcome:
- pass: every cluster ≥ 0.7.
- revise: any cluster in [0.5, 0.7).
- fail: any cluster < 0.5 OR documented gap on a platform's "must-fix-to-cert" item. Studio's own cert checklist is the final arbiter.
