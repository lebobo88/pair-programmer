---
id: web-runtime-validation@1
bare_id: web-runtime-validation
kind: contract
version: 1
title: Web runtime validation (live browser execution)
source_url: https://www.w3.org/TR/2024/WD-wai-aria-1.3-20240320/
generated_by: pp-daemon dump-rubrics
note: This file mirrors the registry in daemon/src/rubrics/registry.ts. Do not edit by hand — regenerate.
---
# Web runtime validation rubric

Score 0..1 per dimension. The browser-validator agent boots the project's
dev server and exercises the spec's acceptance criteria via either
`claude-in-chrome` MCP or headless Playwright. Findings are recorded as
{route, step, status, console_errors, network_errors, screenshot_path}.

- **route_reachability**: every profile route returned a renderable response
  (HTTP 200 OR SPA-route equivalent with mounted root). Routes that 404 or
  hang past the profile timeout score 0.
- **console_clean**: zero `console.error` and zero unhandled-rejection
  messages across all visited routes. Warnings are tolerated but counted.
- **network_clean**: zero 5xx responses; 4xx responses that aren't part of
  the asserted-failure flow score the dimension down.
- **acceptance_coverage**: every MUST/SHALL bullet from the spec stage's
  acceptance-criteria artifact has a matching {route, step, status=pass}
  finding, OR is explicitly annotated "no UI flow — verified by tests stage".
- **evidence_present**: at least one screenshot per visited route AND, when
  the engine is `chrome-mcp`, an evidence GIF at `<run>/browser-validation/`.
  Reports without evidence cannot be replayed.
- **engine_disclosed**: the report names the engine (`chrome-mcp` or
  `playwright`) and the dev-server base_url so the run is reproducible.

Outcome:
- pass: every dimension ≥ 0.7 AND severity in {clean, warnings}.
- revise: any dimension in [0.5, 0.7) OR severity = warnings with > 3 warnings.
- fail: any dimension < 0.5 OR severity = errors (any console error, any
  status="fail" finding, or any 5xx response).
