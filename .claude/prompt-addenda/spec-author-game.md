# Spec-author addendum — game-dev profile family

When the active profile is in the game-dev family, the spec-author handles these game-specific spec shapes in addition to the base PRD / feature-spec / acceptance-criteria forms.

## Game-spec shapes

- **`one_pager`**: concept hook, target audience, comp set (3–5 reference titles), unique selling points, tone, platform list, monetization model.
- **`gdd` (game design doc)**: umbrella spec containing pillars, mechanics, systems, world / setting, narrative summary, art-direction summary, audio-direction summary, accessibility summary, monetization summary, platform list. The GDD is structured but living; subsequent specs (mechanic_spec, level_greybox, encounter_design_doc) point back to it.
- **`vertical_slice_scope`**: what's in the slice (target playtime 20–60 min), what's out, polish bar, balance state, target tier (PS5 / XSX / Switch / Steam Deck / Mobile A / etc.).
- **`mechanic_spec`**: per-mechanic brief — verbs / inputs / outputs / failure modes / counter-play / teaching scenario / how it scales with difficulty.

## RFC 2119 normative language

Use MUST / MUST NOT / SHOULD / SHOULD NOT / MAY consistently. Every MUST has a testable acceptance criterion. "Player can attack" is not testable; "Pressing attack within 100 ms of an enemy windup must trigger the parry state with a visual + audio + haptic confirmation, and reduce incoming damage by 50%" is testable.

## Acceptance criteria for game work

Game acceptance criteria reference the **observable player experience**, not engine internals. "Damage event is propagated to the server" is a tech criterion, not a player-facing one. Translate: "Player who lands an attack receives a damage-confirmation feedback within 50 ms of input."

## Platform & cert dependencies

For console-targeting projects (`console-cert: true`): every spec section includes the cert-relevant TRC / XR / Lotcheck implications (controller-disconnect, save-atomicity, suspend/resume, language-switch, etc.). Cross-reference `console-cert-checklist@1`.

## Live-service callouts

For `live-service: true` projects: every monetized mechanic in the spec includes per-region behavior, drop-rate disclosure plan, COPPA / GDPR-K consent flow, age-gate. Cross-reference `loot-box-jurisdiction@1` and `coppa-2.0-data-flows@1`.

## Accessibility spec sections

Every spec includes an accessibility section with at least: subtitles plan, control-remap plan, color-blind plan, photosensitivity plan, timing-accessibility plan. Cross-reference `game-accessibility-guidelines@1`.

## Anti-patterns

- "Players will explore" — vague. What's explorable, why, what reward?
- "Combat is satisfying" — unmeasurable. Define satisfaction with concrete metrics (hit-confirm latency, damage-feedback redundancy, kill-feed clarity).
- "Realistic graphics" — meaningless. Specify reference titles, art-direction document, target platform-tier.
- "Optimized for performance" — not a spec. Specify frame budget for the platform tier.
