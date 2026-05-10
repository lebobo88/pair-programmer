---
id: wcag-2.2-aa@1
bare_id: wcag-2.2-aa
kind: design
version: 1
title: WCAG 2.2 Level AA
source_url: https://www.w3.org/WAI/standards-guidelines/wcag/
generated_by: pp-daemon dump-rubrics
note: This file mirrors the registry in daemon/src/rubrics/registry.ts. Do not edit by hand — regenerate.
---
# WCAG 2.2 AA rubric

Score 0..1 for each principle. Failures of any single 2.2 AA criterion drop that principle to ≤0.6.

- **perceivable**: text alternatives for non-text content; captions for video; minimum contrast 4.5:1; resizable text without loss; reflow at 320 CSS px.
- **operable**: keyboard accessible (no traps); focus visible; skip links; touch targets ≥ 24×24 CSS px; consistent help; redundant entry minimized.
- **understandable**: language of page set; consistent navigation; consistent identification; clear error messages and suggestions.
- **robust**: parses; status messages programmatically determinable; ARIA used correctly only when native semantics insufficient.

For UI artifacts, additionally require the **8-state matrix**: every component shows default / hover / focus / active / loading / empty / error / disabled.

Outcome:
- pass: every principle ≥ 0.7 AND 8/8 states named.
- revise: any principle in [0.5, 0.7), or 6-7/8 states.
- fail: any principle < 0.5, or < 6/8 states.
