# Bevy gotcha-pack

Read this file when the active profile is `game-dev-custom` and the detected engine is Bevy (Cargo.toml has a `bevy` dep).

## ECS-first

- **Bevy is ECS, period.** Components are structs, systems are functions, entities are IDs.
- Don't try to layer object-oriented patterns on top — `dyn Trait` is occasionally useful but the idiomatic Bevy code is data-oriented.
- **Resources** for global state; **components** for per-entity state; **events** for transient signals.

## Plugin model

- Code is organized into **`Plugin`s**. Each plugin registers its systems, resources, and events into the `App`.
- Library crates expose plugins; the binary crate composes plugins.
- Re-export traits / types from your plugin so users don't dig into module paths.

## System ordering

- Systems run **in parallel** unless ordered explicitly via `.before()` / `.after()` / system sets.
- **Schedule labels** (`Update`, `FixedUpdate`, `PreUpdate`, etc.) define the high-level ordering buckets.
- Conflicting access (e.g., two systems writing the same component) forces serial execution; expect this and design around it.

## Queries

- Queries filter entities by component combinations: `Query<&Health, With<Enemy>>`.
- `&` for read, `&mut` for write; `Without<>` for negation.
- Avoid wide queries that scan many entities every frame; use **change detection** (`Changed<T>`, `Added<T>`) to skip unchanged work.

## No scene editor

- Bevy has no built-in scene editor. **`bevy_editor_pls`** and similar community tools exist but are not first-party.
- Levels / scenes are usually defined in code (Rust functions that spawn entities) or via the **Bevy scene format** (RON-based serialization, evolving).
- Asset hot-reload is solid (textures, audio, GLTF); scene hot-reload is more limited.

## Performance

- **Bevy is fast** because of ECS; expect competitive perf out of the box.
- Watch for: over-querying (re-iterating large sets every frame), unnecessary `Commands` queues (deferred entity-spawning is sometimes slower than direct).
- Profile with `bevy::diagnostic` plugins or external tools (`tracy-client` integration).

## Networking

- No first-party netcode. Community options: `bevy_replicon`, `bevy_renet`, `lightyear`, `naia`.
- Pick one early; switching is painful.

## Save data

- Standard Rust serialization (`serde` + `bincode` / `ron` / `json`).
- Atomic saves: write to tmp file, `std::fs::rename` (atomic on same filesystem on POSIX).

## Anti-patterns to refuse

- OO-style "components hold methods that mutate themselves" — components are data; systems mutate.
- `Mutex<...>` resources where simple ECS exclusivity would do.
- Spawning entities every frame without pooling (Bevy's archetype system handles spawning well, but pooling is still cheaper for high-frequency spawn/despawn).
- Reading and writing the same component in one system (split into multiple systems).
