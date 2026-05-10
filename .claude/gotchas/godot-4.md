# Godot 4 gotcha-pack

Read this file when the active profile is `game-dev-godot`. The engineer / game-ai-programmer agents must respect these idioms before composing code.

## Scenes-first

- **Scenes are first-class.** Structure the project around scenes, not folders of scripts. Each scene is a tree of nodes with one root; scenes are reusable as instances.
- **Co-locate scene + its exclusive resources** in one folder. A scene that references a script + a sprite + a material should have all three in `<feature>/<feature>.tscn` + `<feature>.gd` + `<feature>.png` + `<feature>.tres`.
- **Scene inheritance** is a Godot pattern — use it for variants (different enemy types sharing a base enemy scene).

## GDScript vs C# hybrid

- **GDScript for game logic**; **C# for perf-critical**.
- GDScript is fast to iterate, integrated, and type-aware (Godot 4 has typed GDScript).
- C# is required when interfacing with .NET libraries or doing heavy math; otherwise GDScript is enough.
- **C# cannot call GDExtensions directly** — design integration accordingly.
- **C# web export is NOT yet supported in Godot 4.** Web games must use GDScript or accept that the C# path won't ship to web.
- Hybrid: GDScript for high-level orchestration, C# for the hot loop. Bidirectional calls work via `Callable` and signals.

## Resources (.tres / .res)

- **Custom `Resource` classes** are the canonical config / data-asset pattern (mirrors Unity ScriptableObject role).
- Define a `Resource` subclass in GDScript or C#; create instances as `.tres` (text) or `.res` (binary) files; reference them from scenes.
- Designer-tunable values go on `Resource`, not hardcoded.

## Autoloads (singletons)

- **Autoloads** are Godot's singleton pattern. Configured in Project Settings → Autoload.
- Use sparingly: GameManager, AudioManager, EventBus. Don't over-autoload — it makes scenes less reusable.

## Signals

- **Signals are the canonical event system.** Decouple nodes via signals, not direct references.
- Type-safe signals in Godot 4: declare with parameters and types.

## Render

- **Forward+** (default) for high-end and mid-tier; **Mobile** for mobile; **Compatibility** for low-end / web.
- Pipeline switching is project-level; can't mix per-scene.
- **Shader language** is Godot's own (similar to GLSL).

## Networking

- **`MultiplayerAPI`** is the built-in networking layer.
- **Server-authoritative** is the default pattern; RPC annotations `@rpc("authority", "call_remote", "reliable")` etc.
- For deterministic / rollback netcode, Godot has limited built-in support — expect to roll your own state-sync layer.

## Performance

- **Built-in profiler** is in the editor.
- Avoid `_process` work that can run in `_physics_process` (fixed timestep);  avoid per-frame `get_node` lookups (cache `@onready` refs).
- `instances` over `duplicate()` for repeated scenes.

## Save data

- `ConfigFile` for simple key-value; custom `Resource` serialization for structured data (`ResourceSaver.save`).
- **Atomic saves**: write to a tmp file first, then rename. Godot's filesystem APIs map cleanly to POSIX `rename` semantics.
- Custom `Resource` files cannot embed circular references — break them with paths or IDs.

## Anti-patterns to refuse

- Folders of `.gd` scripts without scenes.
- `get_node("path/to/node")` per-frame (cache as `@onready var`).
- Singletons everywhere (autoload over-use).
- C# project assuming web export works.
- Direct node references between sibling subtrees (couples them; use signals or autoloads).
