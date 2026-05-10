---
id: coppa-2.0-data-flows@1
bare_id: coppa-2.0-data-flows
kind: security
version: 1
title: "COPPA 2.0 + GDPR-K data-flow review"
source_url: https://www.ftc.gov/legal-library/browse/rules/childrens-online-privacy-protection-rule-coppa
generated_by: pp-daemon dump-rubrics
note: This file mirrors the registry in daemon/src/rubrics/registry.ts. Do not edit by hand — regenerate.
---
# COPPA 2.0 + GDPR-K rubric

COPPA 2.0 effective 2025-06-23, compliance 2026-04-22. Broader "personal info" definition; mandatory deletion-on-request; separated consent for ads. The 2025 FTC Genshin/HoYoverse $20M settlement is the canonical worked example. EU GDPR-K parental-consent threshold is 13-16 depending on member state.

Score 0..1 per cluster:

- **age_assurance**: age gate at first launch; bypass-resistant; persisted; documented age-of-record vs declared-age distinction.
- **personal_info_inventory**: every collected field classified (name, email, persistent identifier, IP, device ID, geolocation, photo/video/audio of child, educational records). COPPA 2.0 explicitly added persistent identifiers and biometrics.
- **parental_consent**: verified parental consent for under-13 (US) / per-member-state-threshold (EU) before any data collection beyond minimum. Consent-by-email-not-clicked is no longer sufficient under COPPA 2.0.
- **purpose_limitation**: data used only for stated purpose; no advertising profile under-13 without separate explicit consent.
- **deletion_rights**: parent / authorized adult can request deletion; deletion completes within 30 days; deletion is verifiable.
- **third_party_sharing**: every SDK / data-recipient enumerated; contracts in place; no SDK that hard-fails on deletion.
- **storage_minimization**: retention windows declared per data class; no indefinite retention.
- **incident_response**: child-data-breach plan separate from generic incident plan; FTC notification timeline documented.

Outcome:
- pass: every cluster ≥ 0.7 AND DPIA / data-flow diagram artifact references this rubric.
- revise: any cluster in [0.5, 0.7).
- fail: any cluster < 0.5 OR persistent-identifier collection from under-13 without compliant consent.
