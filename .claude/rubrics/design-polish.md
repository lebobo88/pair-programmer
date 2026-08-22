---
id: design-polish@1
bare_id: design-polish
kind: design
version: 1
title: "Design polish (AI-slop, hierarchy/rhythm, interaction states)"
source_url: https://github.com/Trystan-SA/claude-design-system-prompt
generated_by: pp-daemon dump-rubrics
note: This file mirrors the registry in daemon/src/rubrics/registry.ts. Do not edit by hand — regenerate.
---
# Design polish rubric

Score 0..1 for each dimension. This rubric catches generic, templated output that individually-correct artifacts (e.g. those already passing wcag-2.2-aa@1) can still exhibit — it complements accessibility rubrics, it does not replace them.

- **genericness_avoidance**: absence of default "AI-slop" tropes — 3+ color decorative gradients; filler emoji prepended to headlines/buttons; the default "border-left: 4px solid + rounded corners" card treatment used without intent; generic stock/AI-style SVG illustration; bare Inter/Roboto/Arial used without a stated rationale; harsh pure #FFFFFF-on-#000000 pairs; untraced/inconsistent inline color values; off-scale spacing (7px/15px/18px instead of a 4px/8px multiple); stacked "editorial warmth" cliché (cream background + serif display font + terracotta accent) used without brand justification.
- **hierarchy_rhythm**: visual hierarchy uses size/weight/color/position deliberately; a spacing scale is declared and followed; no more than 1-2 font families in use; repeated layout rhythm is intentional, not incidental.
- **interaction_completeness**: every interactive element defines default/hover/active/focus/disabled treatments with 0.2-0.3s transitions; `prefers-reduced-motion` is respected; loading and validation feedback is present where relevant.

Outcome:
- pass: every dimension ≥ 0.7.
- revise: any dimension in [0.5, 0.7).
- fail: any dimension < 0.5, OR any AI-slop trope above is present at high severity (i.e. dominates the artifact's visual identity rather than appearing incidentally).
