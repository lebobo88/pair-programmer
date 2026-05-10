---
id: nist-ai-rmf-measure@1
bare_id: nist-ai-rmf-measure
kind: ai
version: 1
title: NIST AI RMF — Measure function
source_url: https://www.nist.gov/itl/ai-risk-management-framework
generated_by: pp-daemon dump-rubrics
note: This file mirrors the registry in daemon/src/rubrics/registry.ts. Do not edit by hand — regenerate.
---
# NIST AI RMF Measure rubric

Score 0..1 per outcome:
- **eval_suite_present**: documented evals covering capability + safety dimensions.
- **eval_baseline**: baseline scores recorded; regression alerts wired.
- **drift_monitoring**: live monitoring for input distribution shift.
- **bias_assessment**: subgroup performance measured (where applicable).
- **failure_taxonomy**: known failure modes catalogued with examples.
- **hitl_thresholds**: confidence thresholds for human review explicit.

Outcome:
- pass: every outcome ≥ 0.7.
- revise: any in [0.5, 0.7).
- fail: eval_suite_present < 0.5 OR hitl_thresholds < 0.5.
