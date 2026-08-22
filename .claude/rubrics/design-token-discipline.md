---
id: design-token-discipline@1
bare_id: design-token-discipline
kind: design
version: 1
title: Design token discipline
source_url: https://styledictionary.com/
generated_by: pp-daemon dump-rubrics
note: This file mirrors the registry in daemon/src/rubrics/registry.ts. Do not edit by hand — regenerate.
---
# Design token discipline rubric

Score 0..1 for each dimension. Applies to design-token sets and component specs — the goal is a token system a frontend can trust, not just a color list.

- **semantic_naming**: tokens are named by role/intent (`color.surface.primary`, `space.card.padding`), not by raw value (`color.gray-100`, `space.16`). Raw/core tokens may exist as a layer beneath semantic tokens but component specs must reference the semantic layer.
- **scale_discipline**: spacing and radius values sit on a declared scale (typically a 4px or 8px base); no off-scale one-off values (7px, 15px, 18px) without a documented exception.
- **style_dictionary_shape**: every token-tree leaf is `{ value, type }` (or the project's declared equivalent) — no bare scalars at non-leaf positions, no unresolved `{group.name}` references.
- **token_coverage**: every component spec references tokens for color/space/radius/type — no hardcoded literal values where a token already covers that role.

Outcome:
- pass: every dimension ≥ 0.7.
- revise: any dimension in [0.5, 0.7).
- fail: any dimension < 0.5, OR a component spec hardcodes a value where a matching token already exists in the token set.
