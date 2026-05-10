---
name: game-design
description: Skill for producing distinctive, professional-grade game-design artifacts (GDD, mechanic specs, level greybox, narrative bibles, economy spreadsheets) that avoid generic AI aesthetics and standard "explore a world / engage in combat / build relationships" pitfalls. Invoked by spec-author, narrative-designer, level-designer, encounter-designer, economy-designer when the active profile is in the game-dev family.
---

# Game-design skill

You are producing a game-design artifact. The job is to produce **distinctive, defensible, testable** design work that a real studio could ship — not the generic-AI default of three-pillars-and-a-mood-board.

## Anti-patterns to refuse

When the input request leans on these patterns, push back:

- **Three-bullet pillars** ("Engaging combat / Deep story / Open world") with no decision content. Pillars are testable claims, not vibes.
- **Generic verbs**: "explore", "engage", "experience", "discover" — these aren't game verbs. Game verbs are the player input. Replace with concrete inputs ("Press attack within 100ms of an enemy windup to parry").
- **Hero must save the world** framing without a specific hook (who is the hero, what makes this world worth saving, what's the antagonist's logic).
- **"Casual to hardcore" audience** claim — pick one and design for them. A game that targets both targets neither.
- **Mechanic specs that don't name failure states.** Every mechanic has a way to fail; if you can't name it, the mechanic isn't designed.
- **Levels as "areas with combat arenas"** — pacing diagrams need verbs that produce the peaks and valleys.
- **Boss "with seven mechanics"** — three to five, with at least one player-can-react mechanic per phase.
- **Generic enemy lists** ("ranged + melee + heavy") — give every archetype a unique counter-play and a unique tell.
- **"Realistic" graphics / "satisfying" combat / "deep" story** — unmeasurable claims. Replace with reference titles + numeric targets.

## Templates

### One-pager template

```
# <Title> — One-pager

## Hook
<One paragraph. The single most interesting thing about this game.>

## Audience
<Specific player. "Action-RPG players who bounced off Elden Ring's difficulty," not "RPG fans.">

## Comp Set
- <Comp 1> — what we share, what we differ.
- <Comp 2> — what we share, what we differ.
- <Comp 3> — what we share, what we differ.

## USP
<What this game does that the comp set doesn't.>

## Tone
<Three concrete adjectives + a rejected adjective. "Crunchy, melancholy, defiant — NOT 'fun'.">

## Platforms
<List + perf budget tier per platform.>

## Monetization
<Premium / F2P / live-service / subscription. If F2P or live-service, pointer to economy_spreadsheet.>

## Target launch quarter
<Q-Y. Used for milestone planning.>
```

### GDD template

```
# <Title> — Game Design Document

## Pillars
<Three to five. Each is a testable claim, not a vibe.>

## Core loop
<3–5 sentences. The minute-to-minute rhythm.>

## Meta loop
<3–5 sentences. The session-to-session rhythm.>

## Mechanics
<List. Each links to a mechanic_spec artifact.>

## Progression
<Curves: power, content unlock, narrative. Time-to-next-meaningful-reward per session.>

## World / setting
<Distinct world. Cite specific tone references.>

## Narrative outline
<Story spine. Beats, not prose. Pointer to narrative_bible.>

## Art direction
<Reference titles + style choices. Pointer to art_bible.>

## Audio direction
<Sonic palette + mixing tiers + voice budget. Pointer to sound_design_doc.>

## UX
<HUD, menus, controller-first vs mouse-first. Pointer to wireframes / IA.>

## Accessibility
<Tier per axis. Pointer to accessibility_plan.>

## Monetization (if applicable)
<Pointer to economy_spreadsheet.>

## Live-ops (if applicable)
<Cadence + content drop schedule. Pointer to liveops_season_plan.>

## Platform list
<Per platform + perf budget tier.>
```

### Mechanic-spec template

```
# Mechanic — <Name>

## Verb
<The player input. "Tap A within 100ms of windup" or "Hold L1 + R1 to parry-and-counter".>

## Inputs
<Player input(s).>

## Outputs (game state changes)
<Damage, position, animation, sound, score, inventory.>

## Feedback (player perception)
<Visual + audio + haptic. Each named.>

## Failure modes
<How the mechanic fails. "Mistime by >100ms = take damage + stun.">

## Counter-play
<What the player does to win against the mechanic. "Just dodge" is not counter-play.>

## Teaching scenario
<The first encounter that teaches this mechanic to the player.>

## Difficulty scaling
<What numbers scale, by what multiplier, in which difficulty curve.>

## Cross-references
<Other mechanics this interacts with.>
```

### Level greybox template

```
# Level greybox — <Name>

## Pacing diagram
<Tension graph from level start to level end. Peaks, valleys, breathers, climax. Annotate with the verb that produces each.>

## Spatial layout
<ASCII top-down or Mermaid. Annotate dimensions in engine units (Unity m / Unreal cm / Godot m).>

## Critical path
<The route a player MUST take. Document margins for jumping / climbing / etc.>

## Optional paths
<Side rooms, hidden routes, what they reward.>

## Encounter map
<Pointer to encounter_design_doc per encounter. Where each encounter happens, what enemies, what mechanics tested.>

## Performance budget
<Per-area triangle / draw-call / VRAM allocation against the platform tier.>
```

### Narrative bible template

```
# <Title> — Narrative Bible

## World
<Pillars, geography, factions, history, tone.>

## Characters
<Each character: who they are, what they want, how they speak, what they would never say.>

## Tone
<Voice and register. The "voice rules" are the line between this game and every other game.>

## Story spine
<Beats, not prose. Each beat: what changes, what's revealed, what new tension is introduced.>

## Dialogue conventions
<How characters speak. Length of average line. Localization budget per locale.>

## Themes
<What the story is about, beyond the plot.>
```

### Economy spreadsheet template (rows; tabular)

```
# Economy spreadsheet — <Title>

## Currencies (tab)
| Currency | Premium? | Source(s) | Sink(s) | Leak(s) | Per-region note |

## Drop tables (tab)
| Source | Item | Weight | Pity timer | Floor rate | Drop-rate published? |

## Per-region behavior (tab)
| Region | Loot-box allowed? | Drop rates published? | Age gate? | Notes |
| Belgium | NO | n/a | n/a | Effectively banned — disable for BE accounts |
| Netherlands | RESTRICTED | yes | yes | 2025 Antwerp ruling extended scope |
| EU general | (DFA pending) | yes | 18+ | Anticipate EU-wide rules |
| China | YES | YES (mandatory) | n/a | Drop rates publicly documented |
| US (Apple iOS) | YES | YES (App Store guideline) | yes | |
| US (Google Play) | YES | YES (Play Store guideline) | yes | |
| US (other) | YES | (ESRB notice) | yes | |

## Progression curves (tab)
| Level | XP required | Cumulative XP | Power score | Time-to-level (median session count) |

## Balance matrix (tab)
| Class A vs Class B | Win rate target | Tested by | Last test date |
```

## Constraints

- Every artifact MUST have a testable acceptance criterion at the team / stage gate level.
- Every artifact MUST cross-reference its accessibility implications.
- Every artifact in a `live-service: true` project MUST consider per-region monetization.
- Every artifact MUST avoid the anti-pattern list above.
- Cite reference titles for tone, art direction, mechanic feel.
