# Web-engines gotcha-pack (Babylon.js 9, three.js, PlayCanvas, Phaser)

Read this file when the active profile is `game-dev-web`. The engineer / technical-artist agents must respect these idioms before composing code.

## Browser frame budget

- **16.67 ms / frame at 60 fps**, but the browser steals time too — main-thread work for layout, paint, GC, JIT compilation. Realistic budget: 12–14 ms for the game.
- **`requestAnimationFrame`** is the only correct render loop. `setInterval` / `setTimeout` are wrong.
- **Tab-blur** suspends rAF; design pause behavior accordingly.
- **Off-screen rendering** (`OffscreenCanvas` + Worker) can lift main-thread pressure when your engine supports it.

## GC pressure

- **No allocations in the render loop** — pooling, pre-allocated arrays, `THREE.Vector3` reuse.
- `Array.prototype.map` / `filter` / `reduce` allocate; loops are cheaper in hot paths.
- Closures capture; avoid creating closures per-frame.
- Watch for hidden allocations: template strings, JSON.stringify, `Object.assign`, spread syntax.

## Babylon.js 9 specifics

- **`Engine` / `Scene` / `Mesh` / `Material`** is the core hierarchy. `Scene.render()` is called from the rAF loop.
- **NodeMaterial** / **NodeMaterialEditor** is the modern shader authoring path. Older `ShaderMaterial` is still supported.
- **GLTF pipeline** is canonical for asset loading (`SceneLoader.AppendAsync`).
- **IBL (image-based lighting)**: use `.env` files (Babylon's compressed environment format).
- **InstancedMesh** for repeated geometry; **ThinInstance** for very large counts.
- **Performance Priority Mode** enables aggressive optimizations (`scene.performancePriority = ScenePerformancePriority.Aggressive`).

## three.js specifics

- **`Scene` / `Camera` / `Renderer` / `Mesh`** is the core hierarchy. `renderer.render(scene, camera)` is called from the rAF loop.
- **Renderer setup** matters: `WebGLRenderer({ antialias, powerPreference })`. `powerPreference: "high-performance"` for desktop / discrete GPU; `"low-power"` for mobile.
- **Scene graph** is mutated directly via `add()` / `remove()`; reuse `Mesh` and `Material` instances.
- **Postprocessing** via `EffectComposer` (separate package).
- **InstancedMesh** for repeated geometry.

## Asset streaming

- **Browser fetch + IndexedDB** for asset persistence. First load is network-bound; subsequent loads are cache-bound.
- **Service Workers** can cache assets aggressively; design for cache-busting with content-hashed URLs.
- **GLTF + Draco compression** for meshes; **KTX2 / Basis Universal** for textures (compressed, GPU-friendly).

## Mobile web

- **Mobile browsers throttle aggressively**: TDP, thermal, background-tab. Design for variable framerate.
- **Touch input** != mouse; design controls for touch primary, mouse secondary.
- **Viewport** management is critical; lock orientation if needed.

## Save data

- **`localStorage`** for small (< 5 MB) sync state; **`IndexedDB`** for larger or structured.
- **Atomic save**: write to a temp key, then commit via a single transaction. Browsers don't crash mid-write often, but tab-close mid-write is real.
- **Cloud save** via your backend; design for offline-first with reconciliation on reconnect.

## Networking

- **WebSockets** for real-time; **WebRTC DataChannels** for peer-to-peer (requires signaling).
- **Server-authoritative**: client cannot be trusted (browsers expose everything). All gameplay state derives from the server.

## Browser-validator integration

- The `game-dev-web` profile inherits `web-ui`'s browser-validator + visual-regression-runner stages. They run against the dev server's index route by default; override `runtime_smoke_test.routes` in `<project>/.harness/profile.yaml` for canvas-driven flows.
- Console errors / network errors fail the browser-validation stage. Prefer warnings over errors for non-fatal issues.

## Anti-patterns to refuse

- Allocations in the render loop (any `new`, any spread, any array method that allocates).
- `setInterval` / `setTimeout` for the render loop.
- `JSON.stringify` per-frame for debug.
- Large textures uncompressed (use KTX2 / Basis).
- Loading all assets upfront on a slow connection (stream).
- Trusting client-sent gameplay state.
