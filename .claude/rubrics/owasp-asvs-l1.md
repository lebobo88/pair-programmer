---
id: owasp-asvs-l1@1
bare_id: owasp-asvs-l1
kind: security
version: 1
title: OWASP ASVS Level 1
source_url: https://owasp.org/www-project-application-security-verification-standard/
generated_by: pp-daemon dump-rubrics
note: This file mirrors the registry in daemon/src/rubrics/registry.ts. Do not edit by hand — regenerate.
---
# OWASP ASVS L1 rubric (verifiable web app baseline)

Score 0..1 per category. L1 covers what should be verifiable from outside the app.

- **authentication**: secure auth flows; password storage hashed/salted; MFA available; session token entropy.
- **session_mgmt**: cookies HttpOnly + Secure + SameSite; session invalidation on logout; idle timeout.
- **access_control**: deny-by-default; checks at every protected resource; no IDOR.
- **input_handling**: validate at trust boundaries; output-encode for context; SSRF/XXE/path-traversal mitigations.
- **cryptography**: only TLS ≥ 1.2 in transit; modern ciphers; secrets not in source/logs.
- **error_handling**: no stack traces to users; structured logs without secrets.
- **data_protection**: PII classified; least-privilege storage; right-to-delete supported.
- **comms**: HSTS; certificate validation; no mixed content.

Outcome:
- pass: every category ≥ 0.7 AND no L1 must-have unchecked.
- revise: any category in [0.5, 0.7).
- fail: any category < 0.5, or any documented bypass of an L1 must-have.
