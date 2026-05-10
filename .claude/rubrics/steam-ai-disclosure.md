---
id: steam-ai-disclosure@1
bare_id: steam-ai-disclosure
kind: docs_polish
version: 1
title: Steam AI content disclosure
source_url: https://store.steampowered.com/news/group/4145017/view/3862463747997849618
generated_by: pp-daemon dump-rubrics
note: This file mirrors the registry in daemon/src/rubrics/registry.ts. Do not edit by hand — regenerate.
---
# Steam AI disclosure rubric

Steam's January-2026 rewrite distinguishes content **consumed by players** (must disclose) from **dev efficiency tools** that don't ship to players (don't need to disclose).

Score 0..1 per cluster:

- **consumed_content_inventory**: shipped store-page art, character models, voice lines, narrative text, marketing — every gen-AI-originated asset listed with model + prompt + provenance.
- **live_generated_content**: real-time NPC dialogue, procedural textures from player input — declared in disclosure with the inference model and any data leaving the user's device.
- **efficiency_tools_excluded**: AI used in coding, asset cleanup, naming — explicitly NOT disclosed (avoid over-disclosure that confuses the form).
- **pcg_distinction**: classical procedural content generation (algorithmic) is NOT gen-AI for Steam disclosure; the artifact must distinguish.
- **disclosure_artifact**: STEAM_AI_DISCLOSURE.md present at project root for any Steam-bound build with consumed-by-player AI content.

Outcome:
- pass: every cluster ≥ 0.7 AND STEAM_AI_DISCLOSURE.md present and current.
- revise: any cluster in [0.5, 0.7) OR disclosure file out-of-date relative to recent asset additions.
- fail: Steam-bound build with consumed-by-player AI content but no disclosure artifact.
