---
id: game-perf-budget@1
bare_id: game-perf-budget
kind: code_style
version: 1
title: "Game performance budget (per-platform-tier)"
source_url: https://developer.valvesoftware.com/wiki/Budget
generated_by: pp-daemon dump-rubrics
note: This file mirrors the registry in daemon/src/rubrics/registry.ts. Do not edit by hand — regenerate.
---
# Game perf-budget rubric

Per-platform-tier budgets. The artifact MUST declare its target tier(s) and provide capture evidence (Unity Profiler, Unreal Insights, RenderDoc, PIX, Razor, AMD GPUOpen) for every perf-tagged stage.

| Tier | Frame budget | Tris on screen | Draw calls | VRAM ceiling | Audio voices |
|---|---|---|---|---|---|
| PS5 / XSX (60fps) | 16.67 ms (~10 ms CPU + ~6 ms GPU) | 5–20M | 5–15k | 16 GB shared | 32–64 |
| PS5 / XSX (30fps cinematic) | 33.33 ms | 10–30M (Nanite) | 5–20k | 16 GB shared | 32–64 |
| Steam Deck (handheld) | 25–33 ms (TDP-bound) | 2–8M | 2–8k | 16 GB shared | 32 |
| Switch (docked 30fps) | 33.33 ms (ARM-bound) | 0.5–2M | 1–3k | 4 GB shared | 16–32 |
| Switch 2 (target) | DLSS-assisted | 2–8M | 2–6k | tier-up | 32 |
| Mobile A (flagship) | 16.67 ms | 0.5–2M | 0.5–1.5k | 4–8 GB | 16–32 |
| Mobile B (mid) | 33.33 ms | 0.2–1M | 0.3–1k | 2–4 GB | 16 |
| Mobile C (low) | 33.33 ms | <0.5M | <0.5k | 1–2 GB | 8–16 |
| VR Quest 3 (90fps) | 11.11 ms | 0.5–1.5M / eye | <1k / eye | 8 GB | 16 |

**Input-latency budgets**: competitive shooter < 50 ms motion-to-photon; fighting games rollback budget 4–7 frames at 60 fps; VR sub-frame.

Score 0..1 per cluster:

- **frame_time**: GPU + CPU frame-time captures within tier budget for the target scenes (combat, hub, menu, loading).
- **memory**: VRAM + RAM peaks within ceiling; texture-streaming working without thrash.
- **draw_calls**: within tier ceiling on representative scenes.
- **audio_voices**: voice peak within tier ceiling; voice-stealing policy declared.
- **input_latency**: motion-to-photon measured (not estimated) for the target genre.
- **capture_evidence**: each above metric has a linked capture file (.upi, .uprofile, .rdc, .pix, .razor, etc.).

Outcome:
- pass: every cluster ≥ 0.7 AND capture_evidence present.
- revise: any cluster in [0.5, 0.7) OR capture missing for one tier.
- fail: any cluster < 0.5 OR perf claim made without any capture artifact.
