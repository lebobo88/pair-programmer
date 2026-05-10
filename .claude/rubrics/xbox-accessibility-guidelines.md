---
id: xbox-accessibility-guidelines@1
bare_id: xbox-accessibility-guidelines
kind: design
version: 1
title: Xbox Accessibility Guidelines (XAG)
source_url: https://learn.microsoft.com/en-us/gaming/accessibility/guidelines
generated_by: pp-daemon dump-rubrics
note: This file mirrors the registry in daemon/src/rubrics/registry.ts. Do not edit by hand — regenerate.
---
# Xbox Accessibility Guidelines rubric

XAG ships ~25 numbered guidelines (XAG-101..125) tagged by Key Game Area (KGA-1..7) and Impacted Disability axes. Score 0..1 per cluster:

- **input_remap (101-105)**: full controller remap; multi-input parity; toggle-vs-hold; sensitivity adjustment; macros where appropriate.
- **visual (106-112)**: high-contrast support; subtitle adjustability; HUD scaling; reduce-motion option; screen-reader / narrator on menus; color-blind modes; min-text-size honored.
- **auditory (113-117)**: subtitles for all speech and key sounds; speaker identification; distinct visual cue for important audio; mono mix; audio mix for hearing-aid pairing.
- **cognitive (118-122)**: pause anywhere; auto-save frequency; difficulty granularity; tutorials revisitable; clear UI hierarchy.
- **motor / endurance (123-125)**: skip / auto-complete QTE; configurable timing windows; rest-friendly checkpointing.

Outcome:
- pass: every cluster ≥ 0.7 AND each XAG number that's a "must" for the artifact's target tier is addressed in the accessibility_plan.
- revise: any cluster in [0.5, 0.7).
- fail: any cluster < 0.5 OR Xbox-storefront-blocking guideline not addressed.
