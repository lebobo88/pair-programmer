---
name: design-discovery
description: Consolidated kickoff-question round plus aesthetic-direction commitment for UX/design-system work (taxonomy 4.4). Adapted from claude-design-system-prompt's discovery-questions + frontend-aesthetic-direction skills. Invoked by designer at the start of a new/ambiguous ia_map or wireframes stage, and for the visual_direction_advisory stage in ux-team.
---

# Design discovery

Two procedures live here: a kickoff-question pass for ambiguous requests, and a 4-direction aesthetic-commitment pass for new visual work with no existing design system. Run whichever applies — usually just the first for established projects, both for greenfield UI work.

## 1. Kickoff questions

Before producing an `ia_map`, `user_flows`, or `wireframes` artifact on a new or ambiguous request, run **one consolidated question round** — not a drip of one-question-at-a-time follow-ups:

- Who is the audience for this surface, and what's their state of mind when they arrive (task-focused? browsing? recovering from an error?)
- What's the single most important action this screen/flow needs to make easy?
- Is there an existing design system, brand, or reference product to match? (If yes, skip to §2 and go straight to `design-token-extract` instead of proposing new directions.)
- Any hard constraints — platform, framework, accessibility tier, existing component library?

Skip this round entirely when the spec/prior artifacts already answer these questions, or when the change is a small extension of an established pattern. The point is to front-load ambiguity resolution, not to add ceremony to obvious requests.

## 2. Aesthetic direction commitment

Run this only when **no existing design system or brand exists yet** for the surface being designed (check via the same Glob `design-system-curator` uses: `tokens.json`, `theme/*.ts`, `tailwind.config.*`, `styled-system.config.*` — if any of these exist and have real values, extract from them instead via `design-token-extract`).

Propose **4 concretely distinct visual directions**. "Distinct" means they differ in more than accent color — vary palette temperature, density, and component treatment together, not one axis at a time. Include at least one deliberately unconventional option. For each direction, specify:

1. **Typography** — headline + body typeface pairing, weights, scale.
2. **Color** — tone (warm/cool/neutral), primary brand color (hex or oklch), accent(s), semantic colors, neutral scale.
3. **Density** — spacing base and whitespace level (tight/normal/loose).
4. **Radius and shadow** — sharp/soft/rounded; flat/elevated.
5. **Component style** — button/card treatment (filled/ghost/outlined/elevated).
6. **Imagery and motion** — photography vs. illustration vs. none; animation posture.

Each direction gets a one-line rationale tied to the brief — not "modern and clean," a specific claim ("high information density for power users who scan, not read").

**Commit to one.** Once a direction is selected (by the requester, or by your own best judgment when unattended), record it as concrete, reusable values — hex/oklch codes, named font stacks, a numeric spacing scale — in the artifact. Vague adjectives are not a commitment; a future `design-token-extract` pass or `design-system-curator` stage must be able to lift these values directly into a token set without re-deciding anything.

## Where this feeds

- `designer.md`'s `ia_map` stage: run §1 first.
- `designer.md`'s `wireframes` stage (via the `visual_direction_advisory` stage in `ux-team.yaml`, or inline when there's no separate advisory stage): run §2 before any low-fi sketching begins; the committed direction becomes the brief handed to `frontend-design` in the hi-fi pass.
- `design-system-curator.md`: if a `design_tokens` stage runs on a fresh project with no discovery artifact upstream, run §2 first rather than inventing values.
