---
id: game-accessibility-guidelines@1
bare_id: game-accessibility-guidelines
kind: design
version: 1
title: Game Accessibility Guidelines (GAG)
source_url: https://gameaccessibilityguidelines.com/full-list/
generated_by: pp-daemon dump-rubrics
note: This file mirrors the registry in daemon/src/rubrics/registry.ts. Do not edit by hand — regenerate.
---
# Game Accessibility Guidelines rubric

GAG ships Basic / Intermediate / Advanced tiers across six axes. Score 0..1 per axis based on coverage of the artifact's stated platform tier (most ship targets must hit Basic; AAA / accessibility-forward titles target Intermediate; live-service longtail aims for Advanced over time).

- **motor**: full keybind / controller remap including UI; hold-vs-toggle for any sustained input; QTE alternatives; difficulty levels; auto-aim / aim-assist offered.
- **cognitive**: tutorial revisitable; configurable text speed; pause everywhere; clear unambiguous language; objective marker / waypoint.
- **vision**: text size adjustable; color-blind modes; high-contrast UI; subtitle background opacity; screen reader / sonification for menus.
- **hearing**: subtitles / captions for all important speech and important sounds; speaker identified; distinct visual cues for audio events; subtitle size + color customizable.
- **speech**: voice-input is optional; never gate progression behind voice input.
- **general**: accessibility settings findable from main menu and from pause; presets; persisted across sessions and platforms; documented in marketing / store page.

Outcome:
- pass: every axis ≥ 0.7 AND coverage of GAG-Basic items across all six axes is documented in the accessibility_plan artifact.
- revise: any axis in [0.5, 0.7) OR Basic items not enumerated.
- fail: any axis < 0.5 OR no caption / subtitle plan for a title with voiced content.
