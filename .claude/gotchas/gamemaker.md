# GameMaker gotcha-pack

Read this file when the active profile is `game-dev-custom` and the detected engine is GameMaker (a `.yyp` file is present).

## Object / room model

- GameMaker is **object-and-event** based: an object has events (Create, Step, Draw, etc.) and runs in **rooms** (scenes).
- Don't try to apply class-inheritance patterns directly. GameMaker has parent/child object relationships but they're a different kind of polymorphism.
- **Rooms** are the level container. Each room can have its own object instances, persistent layers, and tilemaps.

## GML

- **GML (GameMaker Language)** is the scripting language. Modern GML (GMS2.3+) supports structs, methods, and constructors — closer to JavaScript than to Lua.
- **`@function`** annotations document scripts. Use them.
- **Asset references**: assets are resolved by name (e.g., `obj_player`, `spr_player`, `snd_jump`); the IDE manages the registry.

## Events

- **Create**: instance initialization.
- **Step / Begin Step / End Step**: per-frame logic.
- **Draw / Draw GUI**: render.
- **Collision**: per-collision-pair callback.
- **Alarm**: scheduled timers.
- Each event is a separate code block; don't try to consolidate into a single Update.

## State and persistence

- **Persistent objects** survive room changes (`persistent = true`).
- **Persistent rooms** retain instance state on re-entry.
- `ds_*` data structures (lists, maps, grids) require explicit destruction (`ds_list_destroy`); leaks are common in long sessions.
- **Save data**: `ds_map_secure_save` / `buffer_save` for binary; structs serialize via `json_stringify`.
- **Atomic saves**: write to a tmp file using `buffer_save_async` then rename via `file_rename`.

## Performance

- **Step events** dominate the frame; keep them lean.
- Avoid per-frame string concatenation; pre-build strings.
- **Sprite caching** matters for GPU; pre-load sprite frames.
- **Surfaces** for cached rendering; manage surface lifecycle (they can be lost on resolution change).

## Networking

- Built-in async networking is socket-level; high-level frameworks are community-built.

## Anti-patterns to refuse

- One mega-`obj_controller` with all logic; split by feature.
- DS structures created without explicit destruction on instance destroy.
- Per-frame `string()` concatenation in the Draw event.
- Direct `instance_destroy` from inside a `with` loop without iterator-safety thought.
- Hardcoded resource IDs as integers (use the named constants).
