---
id: sag-aftra-ai-rider@1
bare_id: sag-aftra-ai-rider
kind: security
version: 1
title: "SAG-AFTRA 2025 Interactive Media AI rider"
source_url: https://www.sagaftra.org/contracts-industry-resources/interactive/2025-interactive-media-video-game-agreement
generated_by: pp-daemon dump-rubrics
note: This file mirrors the registry in daemon/src/rubrics/registry.ts. Do not edit by hand — regenerate.
---
# SAG-AFTRA AI rider rubric

The 2025 Interactive Media Agreement requires per-replica consent + disclosure for every AI digital-replica use. Performers can suspend consent during a strike. Consent is voided if usage drifts from the originally-described use. Session fee per 300 generated lines or per individual sound. Comp escalators 15.17% on ratification + 3% Nov 2025 / 2026 / 2027.

Score 0..1 per cluster:

- **consent_record**: written, signed consent on file for the specific performer, the specific use, and the specific model. Stored alongside the audio asset.
- **use_match**: actual usage matches the consent-described scope (genre, character class, polarity of dialogue, derivative-work limits).
- **session_fee_tracking**: every 300 generated lines per performer triggers a tracked session-fee event; per-sound generations tracked separately.
- **strike_pause_capability**: technical mechanism to suspend AI-replica generation during a strike (config flag, kill-switch, or build-flag).
- **store_disclosure**: AI-voice content disclosed per Steam / platform requirements (cross-references steam-ai-disclosure@1).
- **derivative_works**: re-use in promotional / marketing content has explicit additional consent.

Outcome (warn-only per project policy unless studio explicitly opts into hard-fail):
- pass: every cluster ≥ 0.7 AND consent records present for every AI-voice asset.
- revise: any cluster in [0.5, 0.7).
- fail / warn: any cluster < 0.5 OR AI-voice asset shipped without consent record (warn by default; hard-fail when studio config sets sag_aftra.strict=true).
