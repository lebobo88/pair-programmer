# Unity gotcha-pack

Read this file when the active profile is `game-dev-unity`. The engineer / technical-artist / game-ai-programmer / netcode-programmer agents must respect these idioms before composing code.

## Asset / config patterns

- **ScriptableObjects (SOs)** are the canonical designer-tunable config asset. Use them for read-only configuration (enemy stats, weapon profiles, level definitions, encounter layouts).
- **Don't put runtime-mutable state on ScriptableObjects** when also using Addressables — the asset is cached per-bundle, so mutations produce duplicate-instance / save-data corruption bugs. SOs are config; mutable runtime state lives in MonoBehaviour or DOTS components.
- **Addressables vs ECS Content Management System (CMS)**: for 3D meshes, materials, textures, prefabs, shaders — prefer ECS CMS over Addressables when running DOTS to avoid double-bookkeeping. Reserve Addressables for AudioClip, Sprite, 2D-UI prefabs, and design-tunable SOs.
- **Always release Addressable handles.** Long sessions on mobile / WebGL leak otherwise. The `Addressables.Release` call is non-negotiable for any non-trivial flow.
- **One built-in scene** that loads everything else through Addressables is the recommended bootstrap pattern — keeps the binary small and lets content swap without rebuild.

## Project structure

- **`.asmdef` boundaries** matter for compile time and cycle detection. Propose proper assembly boundaries: `Project.Runtime`, `Project.Editor`, `Project.Tests`, plus per-feature assemblies for any feature with > 5 scripts.
- Avoid editor-only code in Runtime assemblies (it'll fail to build for player platforms).
- `[CreateAssetMenu]` ScriptableObject classes belong in Runtime so they can be loaded at runtime; the editor extension to add menu items is in Editor.

## DOTS / ECS

- **DOTS = no GameObject / MonoBehaviour patterns.** A generator that emits `Instantiate(prefab)` inside a DOTS system is wrong. DOTS uses `EntityManager.Instantiate` and ECB.
- DOTS only when justified — high-throughput simulation paths (large entity counts, deterministic networking, batched updates). Don't DOTSify the entire game.
- ECS Content Management System is the asset-management complement to DOTS; respect it.

## Render pipelines

- **SRP / URP / HDRP** choice is project-level; don't mix shaders across pipelines. Built-in render pipeline is legacy; new projects pick URP (mid-tier flexibility) or HDRP (high-end).
- Shader Graph is the canonical authoring path for URP/HDRP shaders; HLSL escape hatches exist but cost cross-platform compatibility.
- **GPU instancing** for repeated meshes; SRP Batcher for shared materials; static batching for static geometry. These are not mutually exclusive.

## Networking

- **Netcode for GameObjects (NGO)** is Unity's first-party networking; **Mirror** and **FishNet** are popular community alternatives; **Photon** is hosted-relay.
- Replicate gameplay state via `NetworkVariable<T>` and `NetworkBehaviour`; never trust client-sent state for damage / loot / achievements.
- For deterministic / rollback netcode, NGO is not a great fit — consider **Photon Quantum** or a custom rollback layer.

## Performance

- Unity Profiler + Profile Analyzer for CPU; Frame Debugger for GPU draw-call inspection; RenderDoc for deep GPU.
- IL2CPP for player builds (better perf, larger build); Mono for editor and prototypes.
- GC pressure is a top-decile mobile perf issue — pool everything that allocates per-frame; avoid LINQ in hot paths; avoid `string` concatenation in Update.
- `[BurstCompile]` for math-heavy DOTS systems.

## Testing

- **EditMode tests** for pure logic (no MonoBehaviour); **PlayMode tests** for runtime behavior; **Test Runner** is the harness.
- Smoke / BVS bots: `UnityEngine.TestTools.Graphics` for screenshot-based validation; **Unity Game Simulation** for virtual-player playtest automation.

## Save data

- `JsonUtility.ToJson` is the simplest path; `Newtonsoft.Json` (com.unity.nuget.newtonsoft-json) when polymorphism is needed.
- **Atomic saves**: write to `<save>.tmp` then `File.Move` (which on POSIX is `rename` — atomic on the same filesystem). Never `File.WriteAllBytes` directly to the live file.
- Save format: include a `version: int` field; emit migrations N-1 → N → N+1.

## Build / cooks

- **Player builds** via `BuildPipeline.BuildPlayer` or platform-specific scripts; CI integration via Unity Cloud Build, Jenkins, or custom.
- **Addressables build** as a separate step before Player Build; player references the addressables manifest.
- **Asset bundles** are legacy — prefer Addressables.

## Anti-patterns to refuse

- `Update()` doing per-frame `GetComponent` lookups (cache references in `Awake`).
- LINQ inside `Update` / `FixedUpdate` (allocates).
- `string` building via `+` in hot paths (use `StringBuilder` or pre-allocated buffers).
- `Camera.main` polled per-frame (it's an O(scene) lookup).
- `Resources` folder for new content (use Addressables).
- Editor-only code in Runtime assemblies (build break on player platforms).
