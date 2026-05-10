# Architect addendum — game-dev profile family

When the active profile is in the game-dev family, the architect's tech_design_doc and architecture artifacts include these game-specific concerns.

## C4-for-games

The architecture diagrams (C1 system context / C2 containers / C3 components) describe **subsystems**, not microservices:
- Engine subsystems: rendering, physics, audio, input, animation, asset streaming, gameplay, AI, networking.
- Hot-path subsystems: which subsystems run every frame; their CPU / GPU budget per platform tier.
- Data subsystems: save-data, profile-data, cloud-save, telemetry pipeline.
- Live-ops subsystems (when live-service: true): event scheduler, store, A/B tester, season manager.

## Reliability model

For online titles: replication topology (server-authoritative / listen-server / peer-to-peer), authority boundaries, host-migration, disconnect recovery, anti-cheat boundaries.

For offline titles: save-data lifecycle (write-path, atomicity, version, migration), recovery from save corruption.

## Performance budgets

Per-platform-tier frame budget (33.33 ms for 30fps console; 16.67 ms for 60fps; 8.33 ms for 120fps). Per-subsystem budget breakdown — every subsystem named above MUST have a frame-budget allocation. Cross-reference `game-perf-budget@1`.

## Asset pipeline

Import settings, atlasing, mip strategy, texture-streaming budgets, audio voice budgets, level-streaming boundaries. Per-engine: Addressables / Asset Bundles for Unity; Pak files / World Partition for Unreal; Resources for Godot.

## Build / cook pipeline

Continuous build farm (Jenkins-style), nightly cooks, automated smoke / BVS bots. Per-platform build configurations.

## Save-data

Atomic write (temp-file + rename); version field with migration path; corruption-tolerant load; cloud-save reconciliation strategy.

## Networking architecture (online titles)

Replication graph or scope; server-tick rate; client-prediction model; reconciliation; host migration; matchmaking. Cross-reference netcode-programmer.

## ADRs

Decision records for major engine / middleware choices: engine version, audio middleware (Wwise / FMOD), networking library (Photon / Mirror / Netcode for GameObjects / FishNet / coherence / Colyseus), anti-cheat (EAC / BattlEye / VAC / Ricochet). Each ADR includes the licensing-threshold note (Wwise / FMOD indie thresholds at $200k revenue / $500k budget).
