---
id: metric-dictionary@1
bare_id: metric-dictionary
kind: data
version: 1
title: Metric dictionary completeness
source_url: https://www.dama.org/cpages/body-of-knowledge
generated_by: pp-daemon dump-rubrics
note: This file mirrors the registry in daemon/src/rubrics/registry.ts. Do not edit by hand — regenerate.
---
# Metric dictionary rubric

For analytics / data products:
- **definition**: business definition stated unambiguously.
- **formula**: mathematical/SQL formula given.
- **grain**: aggregation grain (per-user, per-day, etc.) explicit.
- **lineage**: source tables and transformation steps named.
- **freshness_sla**: target lag from source-of-truth stated.
- **owner**: human or team accountable for accuracy named.
- **deprecation_policy**: replacement metric named when this one is sunset.

Outcome:
- pass: every dimension ≥ 0.7.
- revise: any in [0.5, 0.7).
- fail: definition or grain < 0.5 (without these the metric isn't operable).
