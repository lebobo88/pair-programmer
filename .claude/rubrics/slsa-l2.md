---
id: slsa-l2@1
bare_id: slsa-l2
kind: security
version: 1
title: SLSA Level 2 build integrity
source_url: https://slsa.dev/
generated_by: pp-daemon dump-rubrics
note: This file mirrors the registry in daemon/src/rubrics/registry.ts. Do not edit by hand — regenerate.
---
# SLSA L2 rubric

Score 0..1 per requirement:
- **version_controlled**: source in VCS with commit history.
- **build_service**: builds run on a hosted service (not a developer laptop).
- **provenance_generated**: signed provenance attestation produced.
- **provenance_authenticated**: provenance signature verifiable by consumers.
- **isolation**: build steps run in isolation (no shared mutable state).

Outcome:
- pass: every requirement ≥ 0.7.
- revise: any requirement in [0.5, 0.7).
- fail: provenance_authenticated < 0.5.
