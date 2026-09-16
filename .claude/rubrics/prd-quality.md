---
id: prd-quality@1
bare_id: prd-quality
kind: spec
version: 1
title: PRD quality
source_url: https://www.rfc-editor.org/rfc/rfc2119
generated_by: pp-daemon dump-rubrics
note: This file mirrors the registry in daemon/src/rubrics/registry.ts. Do not edit by hand — regenerate.
---
# PRD quality rubric

Score 0..1 for each dimension. Applies to PRD / product-requirements artifacts.

- **problem_statement**: the problem being solved is named plainly, with who
  has it and why it matters — not just a feature description.
- **users_and_jobs**: every user/persona is named with the job(s) they are
  trying to get done.
- **scope_and_non_goals**: in-scope work is bounded and explicit non-goals are
  named to prevent scope drift.
- **functional_requirements**: requirements use RFC 2119 normative language
  (MUST / SHOULD / MAY) precisely — MUST for non-negotiable behavior, no
  imperative "will" standing in for MUST.
- **acceptance_criteria**: every functional requirement has a concrete,
  testable acceptance criterion — verifiable pass/fail without further
  interpretation.
- **nfrs**: non-functional requirements (performance, security, reliability,
  accessibility, etc.) are named where they matter to the feature.
- **success_metrics**: the PRD states how success will be measured after
  ship, not just what will be built.
- **risks_and_open_questions**: known risks and open questions are surfaced
  rather than silently assumed away.

Outcome — exactly one of the following three applies (total, mutually
exclusive partition; mirrors Hydra's `prd-quality@1` judge rubric in
`hydra_core/judge/registry.py` so a PRD artifact scores identically
regardless of which side judges it):
- pass: problem_statement, functional_requirements and acceptance_criteria
  (the structural minimum) are all ≥ 0.6, AND no dimension equals 0.
- fail: any dimension equals 0, OR any of {problem_statement,
  functional_requirements, acceptance_criteria} < 0.4.
- revise: every other score vector (i.e. neither pass nor fail applies).
