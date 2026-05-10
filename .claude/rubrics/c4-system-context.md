---
id: c4-system-context@1
bare_id: c4-system-context
kind: design
version: 1
title: "C4 system-context view"
source_url: https://c4model.com/
generated_by: pp-daemon dump-rubrics
note: This file mirrors the registry in daemon/src/rubrics/registry.ts. Do not edit by hand — regenerate.
---
# C4 system-context rubric

Architecture artifacts must clearly identify:
- **system_boundary**: what the system IS, plainly named.
- **users_personas**: every user/operator/admin role, with their goals.
- **external_systems**: every external dependency named with the relationship arrow direction.
- **decisions_and_tradeoffs**: ADRs cite alternatives considered and why rejected.
- **runtime_topology**: how components are deployed; where state lives.
- **failure_modes**: what happens if a critical dependency fails.

Outcome:
- pass: all six items ≥ 0.7.
- revise: any item in [0.5, 0.7).
- fail: any of {system_boundary, users_personas, external_systems} < 0.5 — these are the structural minimum.
