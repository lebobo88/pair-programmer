---
id: plan-decomposition-quality@1
bare_id: plan-decomposition-quality
kind: spec
version: 1
title: Plan decomposition quality
source_url: https://www.rfc-editor.org/rfc/rfc2119
generated_by: pp-daemon dump-rubrics
note: This file mirrors the registry in daemon/src/rubrics/registry.ts. Do not edit by hand — regenerate.
---
# Plan decomposition quality rubric

Score 0..1 for each dimension. Judges a PLAN artifact on whether it
decomposes the stated goal into a sound, dependency-correct, testable set of
steps. Dimension names mirror Hydra's `plan-decomposition-quality@1` judge
rubric (`hydra_core/judge/registry.py`) on the same 0..1 scale so a plan
artifact scores identically regardless of which side judges it.

- **goal_fidelity**: the plan's goal restatement and steps actually address
  the stated goal — no drift, no scope invention.
- **decomposition_soundness**: each step is a coherent, right-sized unit of
  work; the whole covers the goal without gaps or needless overlap.
- **dependency_correctness**: dependency edges reflect real ordering
  constraints; the dependency graph is acyclic and non-dangling.
- **acceptance_testability**: each step's acceptance criteria are concrete
  enough to verify pass/fail without further interpretation.
- **envelope_typing**: each step's envelope type and target match the kind
  of work described.
- **risk_surfacing**: risks, non-goals, and open questions are populated
  where the plan has real uncertainty; silence on an obvious risk counts
  against this dimension.
- **ceiling_respect**: the plan's scope and step count are proportionate to
  its stated rigor and do not invite loop-ceiling or envelope-ceiling
  exhaustion.
- **cell_coverage** (ADVISORY): whether the plan's steps map sensibly onto
  an eight-cell classification vocabulary, when a cell classifier is
  available. When the classifier is unavailable this dimension MUST be
  scored as skip/advisory and MUST NOT fail the rubric — it enriches
  judgment when reachable, never gates it.

Outcome:
- pass: every non-advisory dimension ≥ 0.7.
- revise: any non-advisory dimension in [0.5, 0.7).
- fail: any of {goal_fidelity, decomposition_soundness, dependency_correctness} < 0.5 — these are the structural minimum. cell_coverage never fails the rubric.
