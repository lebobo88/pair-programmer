# Rubrics — authoring guide

The harness ships 13 standard-aligned rubrics. The canonical source is `daemon/src/rubrics/registry.ts`; mirror copies live at `.claude/rubrics/<bare-id>.md` and are regenerated via `pp-daemon dump-rubrics`.

## Built-ins

| id | kind | use at gate |
|---|---|---|
| `wcag-2.2-aa@1` | design | UX / design-system on `web-ui` profile |
| `owasp-asvs-l1@1` / `owasp-asvs-l2@1` | security | security stages |
| `c4-system-context@1` | design | architecture stages |
| `openapi-3.1-stability@1` | contract | contracts on `api-platform` / `sdk` |
| `asyncapi-3.1-stability@1` | contract | event-contract stages |
| `slsa-l2@1` / `slsa-l3@1` | security | supply-chain on `enterprise` |
| `sbom-cyclonedx@1` | security | supply-chain |
| `nist-ai-rmf-govern@1` | ai | ai-controls govern stage |
| `nist-ai-rmf-measure@1` | ai | ai-controls eval-suite stage |
| `rfc-2119-normative@1` | spec | spec author outputs |
| `metric-dictionary@1` | data | `data-product` data stages |

## Authoring a custom rubric

1. Add an entry to `daemon/src/rubrics/registry.ts` with a fresh id and version.
2. Run `npm run build` then `node dist/index.js dump-rubrics` to regenerate `.claude/rubrics/`.
3. Reference it from a profile (`required_rubrics: { <gate_type>: <id>@<version> }`) or a team yaml (`stages[].judge.rubric`).

## Project-local override

Drop a rubric file at `<project>/.claude/rubrics/<bare-id>.md`. The loader (`daemon/src/rubrics/loader.ts`) tries the registry first, then falls back to the project file if the id is unknown to the registry. The override's id is taken from the filename; version defaults to `0` if not in the id.

## Verdict envelope

Every rubric body ends with the standard envelope:
- `pass` — every named dimension ≥ 0.7 AND no rubric-specific must-have failed.
- `revise` — any dimension in [0.5, 0.7).
- `fail` — any dimension < 0.5, or any rubric-specific must-have absent.

Judges MUST score every dimension; the `verdict-rubric-coverage` PostToolUse hook warns when fewer than 3 dimensions are present.
