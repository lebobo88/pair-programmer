---
id: owasp-asvs-l2@1
bare_id: owasp-asvs-l2
kind: security
version: 1
title: OWASP ASVS Level 2 (standard)
source_url: https://owasp.org/www-project-application-security-verification-standard/
generated_by: pp-daemon dump-rubrics
note: This file mirrors the registry in daemon/src/rubrics/registry.ts. Do not edit by hand — regenerate.
---
# OWASP ASVS L2 rubric (apps handling sensitive data)

Inherits all L1 categories; adds:

- **threat_model_present**: STRIDE/attack-tree level model documented.
- **secure_sdlc**: SAST/DAST in CI; dependency scanning; SBOM tracked.
- **stronger_auth**: MFA enforced for privileged accounts; lockout/throttling.
- **detailed_logging**: security-relevant events logged with correlation; tamper-evident.
- **business_logic**: multi-step abuse cases considered; replay/sequence checks.
- **api_security**: schema-validated, rate-limited, authenticated; deprecation policy stated.

Outcome:
- pass: every L1 category ≥ 0.7 AND every L2 add-on ≥ 0.7.
- revise: any L2 add-on in [0.5, 0.7).
- fail: any L2 must-have absent (e.g. no threat model on a data-handling change).
