---
id: iarc-rating-questionnaire@1
bare_id: iarc-rating-questionnaire
kind: spec
version: 1
title: "IARC age-rating questionnaire mapping"
source_url: https://www.globalratings.com/
generated_by: pp-daemon dump-rubrics
note: This file mirrors the registry in daemon/src/rubrics/registry.ts. Do not edit by hand — regenerate.
---
# IARC rating questionnaire rubric

IARC is a unified questionnaire that emits ESRB / PEGI / USK / ClassInd / ACB labels for digital distribution. Physical retail still requires direct cert (multi-thousand-fee per region). CERO (Japan) is handled separately. Apple's 2025 rating overhaul requires updates by 2026-01-31.

Score 0..1 per category:

- **violence**: realism of violence, blood, dismemberment, weapons, real-world weapons modeling.
- **sexuality**: nudity, sexual content, suggestive themes, romance.
- **language**: profanity frequency and severity.
- **substances**: drugs / alcohol / tobacco depiction or use.
- **gambling**: any chance-based mechanic, including loot-boxes (per IARC 2024 update).
- **simulated_gambling**: poker / casino-style without real money.
- **fear**: jump-scares, body-horror, psychological horror.
- **discrimination**: depictions of discrimination toward real-world groups.
- **online_interaction**: user-generated content, user-to-user comms (raises minimum rating in many regions).

Outcome:
- pass: questionnaire fully answered with evidence anchors (scene timestamps, screenshot refs, dialogue line refs).
- revise: any category answered without evidence anchor.
- fail: any answer contradicted by other artifacts in the run (e.g., questionnaire says "no gambling" but economy_spreadsheet declares loot boxes).
