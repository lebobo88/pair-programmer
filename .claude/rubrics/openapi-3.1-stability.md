---
id: openapi-3.1-stability@1
bare_id: openapi-3.1-stability
kind: contract
version: 1
title: OpenAPI 3.1 contract stability
source_url: https://spec.openapis.org/oas/latest.html
generated_by: pp-daemon dump-rubrics
note: This file mirrors the registry in daemon/src/rubrics/registry.ts. Do not edit by hand — regenerate.
---
# OpenAPI 3.1 contract-stability rubric

Score 0..1 per dimension:
- **schema_validity**: passes openapi-spec-validator; no \`x-\` fields where a schema field is wrong.
- **versioning**: a versioning policy is stated (path-based or media-type); breaking-change definition documented.
- **error_contract**: error response shapes documented for every operation; status codes consistent.
- **idempotency_retry**: idempotent operations marked; retry-safe semantics specified for non-idempotent ones.
- **auth**: every operation declares its securityRequirements.
- **examples**: every operation has request/response examples covering success + at least one error.
- **deprecation_policy**: \`deprecated: true\` operations have a removal date and a successor link.

Outcome:
- pass: every dimension ≥ 0.7.
- revise: any dimension in [0.5, 0.7).
- fail: schema_validity < 0.7 (an invalid spec can't be a valid contract) OR a breaking change shipped without versioning policy update.
