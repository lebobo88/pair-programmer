---
id: asyncapi-3.1-stability@1
bare_id: asyncapi-3.1-stability
kind: contract
version: 1
title: "AsyncAPI 3.1 event-contract stability"
source_url: https://www.asyncapi.com/docs/reference/specification/latest
generated_by: pp-daemon dump-rubrics
note: This file mirrors the registry in daemon/src/rubrics/registry.ts. Do not edit by hand — regenerate.
---
# AsyncAPI 3.1 event-contract rubric

Score 0..1 per dimension:
- **channel_naming**: hierarchical, predictable, documented.
- **message_schema**: message payloads schema-validated; required fields explicit.
- **versioning**: schema-evolution policy stated (forward+backward compatibility window).
- **delivery_semantics**: at-most-once / at-least-once / exactly-once stated per channel.
- **correlation**: traceId / correlationId convention specified.
- **dead_letter**: DLQ behavior documented.
- **examples**: every operation has at least one example payload.

Outcome:
- pass: every dimension ≥ 0.7.
- revise: any dimension in [0.5, 0.7).
- fail: versioning or delivery_semantics < 0.5.
