---
id: dcc-asset-validation@1
bare_id: dcc-asset-validation
kind: contract
version: 1
title: "DCC 3D asset & rig validation (Blender → engine)"
source_url: https://registry.khronos.org/glTF/specs/2.0/glTF-2.0.html
generated_by: pp-daemon dump-rubrics
note: This file mirrors the registry in daemon/src/rubrics/registry.ts. Do not edit by hand — regenerate.
---
# DCC asset & rig validation rubric

Validates a 3D asset (mesh and/or rig) produced in a DCC (Blender, via blender-mcp) against engine-import correctness and the studio geometry/rig budgets. The artifact MUST declare its target engine + platform tier and link capture evidence (viewport/import screenshots, exporter validation log, engine import log). Mirrors the RLM-Gaming `mesh-topology-budget` (mesh) and `rig-quality` (rig) acceptance bars.

Score 0..1 per cluster:

- **poly_topology**: within the declared tri/quad budget; quad-dominant; no n-gons on deforming/subdivided meshes; poles kept off deformation lines.
- **lod_chain**: an LOD ladder is present and monotonic with declared screen-coverage transition distances (or Nanite justified on UE5).
- **uv_layout**: UVs packed, no unintended overlap, consistent texel density (±10%); lightmap UVs present where required.
- **pbr_set**: material channels match the contract (albedo / ORM / normal / emissive); no engine-incompatible (e.g. Cycles-only) nodes on export.
- **transform_axis_scale**: scale=1 / rotation=0 applied; 1 unit = 1 m (or engine unit); pivot at the contract origin; correct up/forward axis preset for the target engine.
- **rig_hierarchy** *(rig only)*: single root at origin; unique bone names; no cycles; `.L/.R` symmetric; deform vs control separation.
- **skin_weights** *(rig only)*: per-vertex Σw = 1 (±1e-5); ≤4 influences; no distant-bone weights; no animated/non-uniform bone scale; no Euler jump > 120°/frame.
- **export_import**: exports to the target format (FBX / glTF 2.0 / USD) and imports cleanly in the engine (single root, baked anim, no validation errors).
- **provenance**: gen-AI assets carry a valid C2PA signature/sidecar (cross-ref `ai-content-provenance`).
- **capture_evidence**: each cluster above has a linked capture (viewport/import screenshot, exporter log, engine import log).

Outcome:
- pass: every applicable cluster ≥ 0.7 AND capture_evidence present.
- revise: any cluster in [0.5, 0.7) OR capture missing for one target.
- fail: any cluster < 0.5 OR a topology/weight/export claim made without any capture artifact.
