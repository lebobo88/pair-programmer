---
id: nist-ai-rmf-govern@1
bare_id: nist-ai-rmf-govern
kind: ai
version: 1
title: NIST AI RMF — Govern function
source_url: https://www.nist.gov/itl/ai-risk-management-framework
generated_by: pp-daemon dump-rubrics
note: This file mirrors the registry in daemon/src/rubrics/registry.ts. Do not edit by hand — regenerate.
---
# NIST AI RMF Govern rubric

Score 0..1 per outcome:
- **policies_present**: written AI use, data, and risk policies.
- **roles_responsibilities**: AI system owner + escalation path documented.
- **risk_appetite**: AI risk tolerance (use-case allowed / forbidden) stated.
- **third_party_governance**: model providers and data providers vetted.
- **incident_response**: AI-misbehavior incident playbook exists.

Outcome:
- pass: every outcome ≥ 0.7.
- revise: any in [0.5, 0.7).
- fail: roles_responsibilities < 0.5 OR incident_response < 0.5.
