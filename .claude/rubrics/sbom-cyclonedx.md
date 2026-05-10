---
id: sbom-cyclonedx@1
bare_id: sbom-cyclonedx
kind: security
version: 1
title: CycloneDX SBOM completeness
source_url: https://cyclonedx.org/specification/overview/
generated_by: pp-daemon dump-rubrics
note: This file mirrors the registry in daemon/src/rubrics/registry.ts. Do not edit by hand — regenerate.
---
# CycloneDX SBOM rubric

Score 0..1 per dimension:
- **components_listed**: every direct + transitive dependency named with version.
- **purl_present**: each component has a PURL (or vendor-locked equivalent).
- **license_disclosed**: license per component (SPDX expression where possible).
- **hashes_disclosed**: integrity hash per artifact.
- **vulnerabilities_referenced**: known CVEs cross-referenced (or absence asserted).
- **supplier_named**: supplier/origin field populated where known.

Outcome:
- pass: every dimension ≥ 0.7.
- revise: any dimension in [0.5, 0.7).
- fail: components_listed < 0.7.
