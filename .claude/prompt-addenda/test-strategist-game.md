# Test-strategist addendum — game-dev profile family

When the active profile is in the game-dev family, the test-strategist designs game-specific testing strategies in addition to the base test_plan / contract_tests forms.

## Game test classes

Apply the appropriate set based on the run's posture flags:

| Test class | What it checks | Always-on under game-dev? |
|---|---|---|
| Functional QA scripts | Menus, loading, cutscenes, input | yes |
| Smoke / BVS bots | Boot, load level, exit cleanly, no null-refs | yes (pre-merge) |
| Soak / longevity | 8h+ idle and gameplay sessions | pre-RC |
| Multiplayer load tests | NCC, sustained user load, packet rate | online: true |
| **Replay / determinism** | Same input → same output (mandatory for rollback netcode); compounded errors fail when randomness is uncontrolled | online + rollback claimed |
| Compatibility matrix | OS / GPU / driver / controller fan-out | per-RC |
| Save corruption / migration | Power-loss mid-write; save-format upgrade across patches | yes (top TRC fail-item) |
| LQA — linguistic / visual / functional | Truncation, RTL, CJK glyph fallback, localized cutscenes | per-locale, pre-cert |
| Accessibility testing | Caption rendering, remap completeness, color-blind, timing | yes |
| Perf | Frame-time captures vs platform tier budget | perf-tagged stages |
| Anti-cheat / fairness | Server-auth boundaries; client-trust audit | online |
| Compliance / cert | TRC/XR/Lotcheck checklist sweep | console-cert: true |

## Test data management

Per-platform save-corpus management; per-region locale corpus; cloud-save reconciliation test scenarios; account-state corpus.

## Determinism harness

When `online: true` and netcode_topology_design declares rollback / lockstep: a replay harness that records inputs + emits the resulting state hash; replays MUST reproduce the hash. Failures = determinism break = rollback failure.

## Compatibility matrix

For PC: top 5 GPU vendors × top 3 drivers × top 5 OS configurations + Steam Deck. For console: cert SKUs. For mobile: tier-A flagship, tier-B mid, tier-C low-end on iOS + Android.

## Save corruption testing

Forced power-loss (SIGKILL / process-suicide) at 50ms intervals during save-write. Save-format-upgrade testing across N-1 → N format versions. Cross-save (cloud / local) reconciliation testing.

## LQA

Per-locale: string truncation; RTL handling (Arabic, Hebrew); CJK glyph coverage (Japanese, Simplified Chinese, Traditional Chinese, Korean); font fallback policy; localized cutscene LIPSYNC verification.

## Performance testing

Capture from Unity Profiler / Unreal Insights / RenderDoc / PIX / Razor / AMD GPUOpen for each perf-tagged scene against the `game-perf-budget@1` rubric. Captures stored as artifacts.

## Anti-cheat testing

For online titles: replay client-trusted-input attempts; server reconciliation must reject. Cross-reference game-security findings.

## Cert pre-flight

For `console-cert: true`: walk the `console-cert-checklist@1` rubric. The studio's NDA-bound cert checklist is the final arbiter — this is a pre-flight, not the cert itself.
