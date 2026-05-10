# Custom-engine gotcha-pack

Read this file when the active profile is `game-dev-custom` AND no recognized engine signals were found by the auto-detector.

## Required: project ships engine-conventions.md

The `game-dev-custom` profile requires the project to ship a file at `<project>/.harness/engine-conventions.md` describing the engine's idioms. The engineer agent reads this file before composing.

If the file is missing, **refuse the run** with a clear error. Do not guess engine idioms.

## What engine-conventions.md should cover

A studio's `engine-conventions.md` should answer:

1. **Language(s)** the engine uses (C++ / Rust / Lua / custom).
2. **Build system** (CMake / Bazel / custom shellscripts) with the canonical "build the game" command.
3. **Asset pipeline**: how assets get from source format (FBX, PNG, WAV) to runtime format (engine-specific binaries).
4. **Module structure**: how the engine codebase is organized; where to add new gameplay code; where engine code is off-limits.
5. **Update loop**: where the simulation tick lives; fixed vs variable timestep; threading model.
6. **Gameplay scripting**: is there a scripting layer (Lua / Python / custom)? How does gameplay code interact with engine code?
7. **Save data**: format; atomicity guarantees; version migration.
8. **Networking** (if applicable): topology; replication strategy; authority model; packet format.
9. **Tooling**: editors / inspectors / profilers; how to attach to a running build.
10. **Anti-patterns**: things that look reasonable but break the engine's invariants.

## Defaults when conventions are silent

If `engine-conventions.md` exists but doesn't cover a topic the agent needs:

- **Save atomicity**: temp-file + rename pattern.
- **Server authority**: server is authoritative for damage / loot / currency / achievements.
- **Determinism for rollback**: seeded RNG + fixed timestep mandatory.
- **Performance evidence**: capture from the engine's own profiler (engine-conventions.md should name it).

## Scope

The harness can't know about every custom engine. The custom-engine path is an escape hatch for in-house engines, hobby engines, or engines that don't fit the named sub-modes. The studio is responsible for keeping `engine-conventions.md` current.
