---
id: rfc-2119-normative@1
bare_id: rfc-2119-normative
kind: spec
version: 1
title: "RFC 2119 normative-language adherence"
source_url: https://www.rfc-editor.org/rfc/rfc2119
generated_by: pp-daemon dump-rubrics
note: This file mirrors the registry in daemon/src/rubrics/registry.ts. Do not edit by hand — regenerate.
---
# RFC 2119 normative-language rubric

For specs / PRDs / ADRs:
- **musts_clear**: MUST / MUST NOT used for non-negotiable requirements only.
- **shoulds_qualified**: SHOULD / SHOULD NOT used for strong recommendations with exceptions named.
- **mays_optional**: MAY indicates true optionality (not weasel-wording).
- **avoids_should_versus_will_confusion**: no imperative "will" where the spec means MUST.
- **acceptance_testable**: every MUST has an acceptance criterion or pointer to one.

Outcome:
- pass: every dimension ≥ 0.7.
- revise: any in [0.5, 0.7).
- fail: musts_clear < 0.5 (vague requirements aren't requirements).
