---
name: rubric-application
description: How to invoke a rubric and emit structured rubric scores. Loaded by judge agents. The 13 standard-aligned rubrics live in the daemon registry; mirror copies under `.claude/rubrics/<id>.md` are generated via `pp-daemon dump-rubrics`.
---

# Rubric application

Every judge verdict pins a `rubric_id`. The driver gets the right rubric id from `mcp__pp_harness__gate_eligible_judges` (field `rubric_id`); the judge agent then fetches the rubric body via `mcp__pp_harness__get_rubric(id)` and applies it.

Rubric ids are version-suffixed: `wcag-2.2-aa@1`, `owasp-asvs-l1@1`, `c4-system-context@1`, etc. Pinning the version means a verdict is reproducible against the exact rubric it was scored with.

## How to fetch a rubric

```jsonc
// request
{ "id": "wcag-2.2-aa@1" }

// response
{
  "id": "wcag-2.2-aa@1",
  "kind": "design",
  "version": "1",
  "title": "WCAG 2.2 Level AA",
  "source_url": "https://www.w3.org/WAI/standards-guidelines/wcag/",
  "markdown": "# WCAG 2.2 AA rubric\n\nScore 0..1 for each principle...",
  "schema_json": { /* JSON Schema for the score object */ }
}
```

If `get_rubric` returns `null`, the rubric id is wrong or the rubric was deleted from the registry. Fall back to the closest match (`list_rubrics` returns all 13 with their kinds) and surface a warning.

## How to emit a verdict

The judge agent passes the rubric markdown into the cross-vendor or same-vendor `critique` tool as the `rubric_md` parameter. The Codex/Gemini critique helpers force a structured response:

```json
{
  "outcome": "pass" | "fail" | "revise",
  "critique_md": "...",
  "score": { "<dimension-1>": 0.0..1.0, "<dimension-2>": 0.0..1.0, ... }
}
```

The dimensions are the bullets at the top of every rubric body (e.g. `perceivable`, `operable`, `understandable`, `robust` for WCAG). The judge MUST score every dimension named in the rubric — `verdict-rubric-coverage` (PostToolUse hook) warns if fewer than 3 dimensions are present.

Then call `mcp__pp_harness__record_verdict`:

```jsonc
{
  "attempt_id":     "attempt_xxx",
  "judge_producer": "gemini",
  "judge_model_id": "gemini-2.5-pro",
  "rubric_id":      "wcag-2.2-aa@1",
  "outcome":        "revise",
  "critique_md":    "Missing focus-visible state; states 4/8 named.",
  "score_json":     { "perceivable": 0.8, "operable": 0.55, "understandable": 0.7, "robust": 0.7 }
}
```

The daemon computes `cross_vendor` from `judge_producer` vs `attempt.producer`. The driver does not pass that flag.

## Outcome envelope (default for every rubric)

- **pass** — every named dimension ≥ 0.7 AND no rubric-specific must-have failed.
- **revise** — any dimension in `[0.5, 0.7)` and no rubric-specific must-have failed (this is the band where Reflexion ×1 is most likely to help).
- **fail** — any dimension `< 0.5`, OR any rubric-specific must-have absent (each rubric body names which ones).

Rubric-specific must-haves examples:
- WCAG: `< 6/8` states named in the screen-state matrix.
- OWASP ASVS L2: threat model not present on a data-handling change.
- OpenAPI 3.1 stability: `schema_validity < 0.7` (an invalid spec is not a valid contract).
- C4 system context: any of `{system_boundary, users_personas, external_systems} < 0.5`.
- RFC 2119: `musts_clear < 0.5` (vague requirements aren't requirements).
- Metric dictionary: `definition` or `grain < 0.5`.
- NIST AI RMF Govern: `roles_responsibilities` or `incident_response < 0.5`.
- NIST AI RMF Measure: `eval_suite_present` or `hitl_thresholds < 0.5`.

## What the run-finalizer does with rubric ids

The verdicts table stores `rubric_id` per verdict. Replay (`pp-daemon replay <run_id>`) reconstructs the run including the exact rubric body that was used. If a rubric is updated to v2, prior runs are unaffected — they pin v1.

## Authoring a project-local rubric override

You can drop a markdown file at `.claude/rubrics/<custom-id>.md` and reference it as a `rubric_id`; the daemon will fall back to disk if the registry has no match. Keep the dimension list explicit so judges score consistently.
