---
id: web-runtime-validation@2
bare_id: web-runtime-validation
kind: contract
version: 2
title: "Web runtime validation (live browser execution, with asserted-failure carve-outs)"
source_url: https://www.w3.org/TR/2024/WD-wai-aria-1.3-20240320/
generated_by: pp-daemon dump-rubrics
note: This file mirrors the registry in daemon/src/rubrics/registry.ts. Do not edit by hand — regenerate.
---
# Web runtime validation rubric (v2)

Differs from `@1` by adding two carve-outs so that intentional failure
flows and spec-tolerated warnings do not auto-fail an otherwise-clean
run. The carve-outs require the browser-validator report to cite the
acceptance-criteria bullet that authorizes each waiver, so they cannot be
used to silently launder real errors.

Score 0..1 per dimension. The browser-validator agent boots the project's
dev server and exercises the spec's acceptance criteria via either
`claude-in-chrome` MCP or headless Playwright. Findings are recorded as
{route, step, status, console_errors, network_errors, screenshot_path}.

- **route_reachability**: every profile route returned a renderable response
  (HTTP 200 OR SPA-route equivalent with mounted root). Routes that 404 or
  hang past the profile timeout score 0.
- **console_clean**: zero `console.error` and zero unhandled-rejection
  messages across all visited routes. Warnings tolerated but counted,
  EXCEPT warnings explicitly classified by the spec as expected-noise /
  tolerance entries — these are excluded from the count when the report
  cites the spec section under `carve_outs.console_warnings[]`. Each
  carve-out entry is `{message_pattern, ac_ref}` where ac_ref is the
  acceptance-criteria bullet ID (e.g. "F-6") that classifies the warning.
- **network_clean**: zero unannotated 5xx responses. 5xx responses that
  the spec's acceptance criteria explicitly designate as the asserted-
  failure flow (e.g., procedural-fallback test cases) do NOT score the
  dimension down, provided the report cites the AC bullet under
  `carve_outs.network_5xx[]` as `{route, ac_ref}`. Uncited 5xx still
  scores 0. 4xx responses that aren't part of the asserted-failure flow
  score the dimension down (unchanged from @1).
- **acceptance_coverage**: every MUST/SHALL bullet from the spec stage's
  acceptance-criteria artifact has a matching {route, step, status=pass}
  finding, OR is explicitly annotated "no UI flow — verified by tests stage".
- **evidence_present**: at least one screenshot per visited route AND, when
  the engine is `chrome-mcp`, an evidence GIF at `<run>/browser-validation/`.
  Reports without evidence cannot be replayed.
- **engine_disclosed**: the report names the engine (`chrome-mcp` or
  `playwright`) and the dev-server base_url so the run is reproducible.

Carve-outs schema (optional reporter-supplied object on the verdict score):
```
carve_outs: {
  network_5xx?: [{ route: string, ac_ref: string }],
  console_warnings?: [{ message_pattern: string, ac_ref: string }],
}
```
A carve-out without `ac_ref` (or with an `ac_ref` that does not appear in
the cited acceptance-criteria artifact) MUST be ignored by the judge —
the strict @1 rule then applies to that finding.

Outcome:
- pass: every dimension ≥ 0.7 AND severity in {clean, warnings} after
  carve-outs are applied.
- revise: any dimension in [0.5, 0.7) OR severity = warnings with > 3
  *non-tolerated* warnings (warnings excluded by an authorized
  `console_warnings[]` carve-out are not counted).
- fail: any dimension < 0.5 OR severity = errors (any console error, any
  status="fail" finding, or any *uncited* 5xx response).
