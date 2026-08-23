---
name: design-polish-review
description: Self-review procedure that catches generic "AI-slop" tropes, hierarchy/rhythm/spacing-scale problems, and incomplete interaction states before a design artifact is archived. Adapted from claude-design-system-prompt's ai-slop-check + hierarchy-rhythm-review + interaction-states-pass + polish-pass skills. Operational procedure behind the design-polish@1 rubric. Invoked by designer and design-system-curator as a self-check before archiving, and by the judge when applying design-polish@1.
---

<!-- Generated from .claude\skills\design-polish-review.md. Edit the .claude source file and rerun node scripts/sync-copilot-assets.mjs. -->

# Design polish review

This is a self-review pass, not just a judging rubric — run it on your own output *before* archiving, the same way `polish-pass` in the source material runs before delivery. Catching these issues yourself is cheaper than a `revise` verdict.

## 1. AI-slop check (genericness_avoidance)

Scan the artifact for these tropes. None of them are forbidden outright — the problem is using them *by default*, without a stated reason:

- **Gradients**: 3+ color decorative blends (purple-to-pink, orange-to-pink) used as a background/accent with no functional purpose.
- **Filler emoji**: prepended to headlines or buttons ("🚀 Get Started") with no informational content.
- **The default card**: `border-left: 4px solid` + rounded corners, applied to every card with no variation or rationale.
- **Generic imagery**: stock-style SVG illustrations, AI-generated character art, low-effort placeholder graphics.
- **Bare default type**: Inter/Roboto/Arial used with no stated rationale (compare against the committed direction from `design-discovery`, if one exists).
- **Harsh contrast**: pure `#FFFFFF` on pure `#000000` with no tonal adjustment.
- **Untraced color**: inline hex values that don't match any declared token, or the same conceptual color appearing as 3 different hex values across the artifact.
- **Off-scale spacing**: padding/margin values that aren't a multiple of the declared spacing base (7px, 15px, 18px instead of 4/8/12/16...).
- **Stacked "editorial warmth"**: cream background + serif display font + terracotta accent, stacked together with no brand justification.

For each match, note **severity** (low/medium/high) and **confidence**. High-severity = the trope dominates the artifact's visual identity, not just one incidental element.

## 2. Hierarchy and rhythm review

- Does visual hierarchy (size, weight, color, position) match informational hierarchy — is the most important thing actually the most prominent?
- Is there a declared spacing scale, and does every measurement in the artifact sit on it?
- Are there more than 1-2 font families in play without a stated reason?
- Is spacing/rhythm between repeated elements consistent, or does it drift?

## 3. Interaction states pass

For every interactive element named in the artifact:

- Are default / hover / active / focus / disabled treatments all specified? (This overlaps with, but is narrower than, the WCAG rubric's 8-state floor — this pass is about *transition quality*, not just presence.)
- Do stated transitions land in the 0.2-0.3s range, and is there a `prefers-reduced-motion` fallback?
- Is loading/validation feedback specified for anything that can be slow or can fail?

## 4. Wireframe low-fi-first gate

If this review is running on a `wireframes` stage artifact: confirm **3+ disposable, greyscale, low-fidelity layout variations** were sketched and compared *before* the hi-fi pass (i.e. before `frontend-design` was invoked). If only one layout was ever produced, that's a finding — the artifact skipped exploration and jumped straight to a single hi-fi answer. This mirrors the source material's `wireframe` skill.

## 5. Classify and fix

Bucket every finding from §1-4 as:

- **Blocker** — high-severity AI-slop trope, or a fully-missing interaction state on a primary action. Fix directly before archiving; don't ship it and hope the judge misses it.
- **Quality issue** — medium-severity trope, hierarchy/rhythm inconsistency, missing low-fi exploration. Fix directly.
- **Polish recommendation** — low-severity or genuinely ambiguous calls (e.g. a font choice with no wrong answer). Fix if cheap; otherwise note it explicitly as an open item rather than silently dropping it.

Record the fixed/open findings in the artifact, and open the artifact with a machine-parseable status line — `status: clean` (no unresolved blockers) or `status: blockers-open` (at least one blocker could not be fixed and is being shipped anyway, e.g. it's out of this stage's scope) — mirroring the `browser_validation_report`'s `severity:` convention. This line is what the `design-polish-evidence` missability check scans for. An artifact with zero findings recorded and no status line reads as "review skipped," not "review passed clean" — always emit the line.

## Where this feeds

- `designer.md`: self-check before archiving `wireframes`/`screen_state_matrix`.
- `design-system-curator.md`: self-check (token-scale-discipline dimension of §1/§2 only) before archiving `design_tokens`/`component_specs`.
- The `design_polish_review` stage in `ux-team.yaml` and `design-system-team.yaml`, judged against `design-polish@1`.
- The `design-polish-evidence` missability check, which requires a `design_polish_review` artifact with no unresolved blocker-severity findings.
