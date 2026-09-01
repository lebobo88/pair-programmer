---
name: design-token-extract
description: Procedure for extracting concrete design-token values and a component inventory from an existing codebase, brand, or screenshots. Adapted from claude-design-system-prompt's design-system-extract + component-extract skills. Invoked by design-system-curator's design_tokens/component_specs stages when an existing token/theme source is found.
---

<!-- Generated from .claude\skills\design-token-extract.md. Edit the .claude source file and rerun node scripts/sync-copilot-assets.mjs. -->

# Design token extract

Use this when a `design_tokens` or `component_specs` stage has a real source to pull from — an existing codebase, a brand guide, or reference screenshots — rather than defining a system from scratch (for the from-scratch case, use `design-discovery` §2 first).

## Rule zero: never guess

Every value in the output must trace back to something observed — a line in a theme file, a computed style from a live page, a value read off a brand guide, a color picked from a screenshot. If a category has no source (e.g. no motion durations defined anywhere), leave it as an explicit gap for the requester to fill, don't invent a plausible-sounding default.

## Token categories to extract

1. **Colors** — brand primary/secondary, semantic states (success/warning/error/info), neutral scale (9-11 steps), surfaces (background/card/border/overlay).
2. **Typography** — font families with fallback stacks, size scale, weights actually in use (not every weight a font family ships), line heights, named text styles (heading-1, body, caption, etc.).
3. **Spacing** — the scale actually in use, not an idealized one (if the codebase uses an inconsistent mix, name the dominant scale and flag the outliers — see "flag, don't merge" below).
4. **Radii and shadows** — corner-radius values; elevation as full CSS (offset, blur, spread, color, opacity), not just a level name.
5. **Auxiliary tokens** — z-index scale, animation durations/easings, breakpoints, container widths — extract if present, otherwise flag as a gap.

## Output shape

Match `design-system-curator.md`'s existing token format: Style-Dictionary-shaped, every leaf `{ value, type }`, grouped `core` (raw) and `semantic` (role-based, referencing core). This is required for the `tokens_build` post-archive validator and for the `design-token-discipline@1` rubric's `style_dictionary_shape` dimension.

```json
{ "color": { "surface": { "primary": { "value": "#0B1220", "type": "color" } } } }
```

## Flag, don't merge

When the source has inconsistencies — duplicate colors under different names, spacing values that don't sit on any coherent scale, three different "brand blue" hex codes — **name each inconsistency explicitly** in the artifact rather than silently picking one and merging the rest away. The requester needs to know the source of truth is messy; quietly cleaning it up hides a decision that isn't yours to make unilaterally.

## Component inventory (when reusable structure exists)

When the source has a component library (even an informal one — repeated markup patterns, a `components/` directory), emit a component inventory: name, variants, states owned, and any duplicate/near-duplicate components worth consolidating. This feeds `component_specs`.

## Where this feeds

- `design-system-curator.md` step 2 (after the existing Step 1 search for `tokens.json`/`theme/*.ts`/`tailwind.config.*`/`styled-system.config.*`): if the Glob finds a real source, run this skill before composing `design_tokens`/`component_specs`.
