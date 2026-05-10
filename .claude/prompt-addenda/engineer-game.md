# Engineer addendum — game-dev profile family

When the active profile is `game-dev`, `game-dev-unity`, `game-dev-unreal`, `game-dev-godot`, `game-dev-web`, or `game-dev-custom`, the engineer agent's procedure adds these obligations on top of the base agent prompt.

## Read the engine gotcha-pack

Before composing code, **read `.claude/gotchas/<engine>.md`** where `<engine>` is the active profile's engine field (unity / unreal-5 / godot-4 / web-engines / bevy / gamemaker / custom). Treat it as a system-prompt addendum. If the file is missing for `game-dev-custom`, refuse the run with a clear error pointing the user to drop `.harness/engine-conventions.md` in the project root.

## Per-engine idiom enforcement

- **Unity**: don't put mutable runtime state on ScriptableObjects when also using Addressables; release Addressable handles in long sessions; respect asmdef boundaries; emit DOTS systems only for high-throughput paths.
- **Unreal**: prefer Gameplay Ability System (GAS) for replicated abilities; use DataAsset / PrimaryDataAsset for designer-tunable config; mix Lumen + Nanite + World Partition + Mass + Niagara as a coherent set; don't write classic LOD code if Nanite is enabled.
- **Godot**: scenes are first-class; co-locate scene + exclusive resources; use GDScript for game logic and C# for perf-critical (note: C# web export not supported); custom Resource classes for cross-cutting data.
- **Web (Babylon.js / three.js)**: respect frame budget on browsers; avoid GC churn in render loop; use IndexedDB for asset persistence; integrate with web-ui's browser-validator stage unchanged.
- **Bevy**: ECS-first, plugin model, system ordering matters.
- **GameMaker**: GML; objects + events, not classes.

## Server-authority and determinism

When the run carries `online: true` flag:
- Default to server-authoritative for any input affecting state (movement, damage, loot, currency, achievements).
- If rollback / lockstep is claimed, RNG MUST be seeded; simulation MUST run on a fixed timestep; replay-determinism harness MUST be in scope.
- Never emit unseeded `Random.Range`, `Math.random()`, `rand()`, `UnityEngine.Random.value` inside a simulation tick when rollback is in scope.

## Save-data atomicity

Save writes use temp-file + atomic rename. Never overwrite a save file in place. Save format includes a version field; emit a migration path when the format changes.

## Designer-tunable values

Don't hardcode game values in engine classes. Designer-tunable values live in DataAsset (Unreal), ScriptableObject (Unity), Resource (Godot), or equivalent. The team's encounter / economy / progression artifacts point to where the asset goes.

## Performance evidence

Any code change tagged `perf-sensitive` requires a capture from Unity Profiler / Unreal Insights / RenderDoc / PIX / Razor / AMD GPUOpen, referenced in the artifact metadata. The `perf-budget-evidence` missability check fails the run otherwise.
