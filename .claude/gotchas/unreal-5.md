# Unreal Engine 5 gotcha-pack

Read this file when the active profile is `game-dev-unreal`. The engineer / technical-artist / netcode-programmer / game-ai-programmer agents must respect these idioms before composing code.

## Render / world systems composition

UE5's headline systems are **intended to compose**, not stack:

- **Lumen** (real-time GI) + **Nanite** (virtualized geometry) + **World Partition** (streamed open worlds) + **Mass** (large-scale entity simulation) + **Niagara** (VFX). Mixing classic LOD code with Nanite, or classic baked lighting with Lumen, fights the engine.
- **Lumen** vs baked: pick one. Lumen is the default for new UE5 projects unless the title is fully indoor / lighting-locked / running on hardware that can't afford Lumen.
- **Nanite** for static, high-poly meshes; not for skeletal meshes (UE 5.5+ has skeletal Nanite preview, treat as experimental).
- **World Partition** for open worlds; the old Level-Streaming pattern is legacy. Don't propose `LevelStreamingDynamic` for new projects.
- **Mass** for crowd / large NPC counts; classic AIController + Pawn for small unique NPCs.

## Gameplay Ability System (GAS)

- **GAS is the canonical replicated-ability pattern.** Rolling your own ability / replication code is a code smell when GAS exists.
- GAS components: `UAbilitySystemComponent`, `UGameplayAbility`, `UGameplayEffect`, `FGameplayAttribute`, `UGameplayEffectExecutionCalculation`.
- GAS handles prediction, rollback, and replication out of the box for ability inputs.
- Designer-tunable ability values live on `UDataAsset` / `UPrimaryDataAsset` subclasses, not hardcoded in C++.

## Blueprints vs C++

- **C++ for performance-critical or core systems.** Tick-heavy code, math-heavy code, system glue.
- **Blueprints for designer-tunable behavior.** A `UPROPERTY(EditAnywhere)` on a C++ class lets designers tweak without recompile.
- A generator should know when to surface a `UPROPERTY(EditAnywhere)` vs hardcode a value.
- Blueprint-only projects are viable for indie scope; AAA always has C++.

## DataAsset / PrimaryDataAsset

- The canonical config-asset pattern (mirrors Unity ScriptableObject role).
- `UDataAsset` for one-off configs; `UPrimaryDataAsset` when the asset is loaded via the Asset Manager (large-scale catalogs).
- Designer-tunable values go here, not in `.ini` or hardcoded.

## Replication

- **Replication graph** for large multiplayer (100+ replicated actors visible to a client at once); replication-by-default for small scope.
- Server-authoritative gameplay; client prediction with `Prediction Key` and reconciliation.
- `RPC` annotations: `Server`, `Client`, `NetMulticast`. The `Server` RPC validates inputs server-side.

## Physics (Chaos)

- **Chaos** replaced PhysX in UE5. Old PhysX-tuning advice is stale.
- Chaos cloth, Chaos vehicles, Chaos destruction are the modern paths.
- For deterministic networked physics, expect tuning work — Chaos is not deterministic out of the box across platforms.

## VFX (Niagara)

- **Niagara** replaced Cascade. Cascade is legacy; new projects use Niagara.
- GPU systems for high-count particles; CPU systems for game-impacting (collision, gameplay events).

## Animation

- **Animation Blueprint** for runtime; **Animation Layer Interface** for layered behaviors (aim / damage / interaction).
- **Control Rig** for runtime IK and procedural animation.
- **Sequencer** for cinematics; not for gameplay flows.

## Performance

- **Unreal Insights** for CPU; **GPU Visualizer** + **RenderDoc** + **PIX** for GPU.
- **Lyra Sample Project** is the canonical performance reference for shooters.
- Per-platform: PS5/XSX target 60fps with Lumen + Nanite; Switch 2 leverages DLSS; Steam Deck wants tuning to avoid TDP throttle.

## Anti-patterns to refuse

- `Tick` doing per-frame `FindObject` / `Cast` chains (cache references).
- `BeginPlay` triggering long synchronous loads (use Asset Manager + async load).
- Hardcoded gameplay values that designers can't tune (use `UPROPERTY(EditAnywhere)` + DataAsset).
- Custom replication when GAS would do.
- Mixing classic LOD with Nanite assets (Nanite handles LOD itself).
- New projects on UE4 patterns (use UE5 idioms).
