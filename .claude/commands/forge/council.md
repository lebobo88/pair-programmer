---
description: Forge crown — convene a four-seat engineering council (architect, security-reviewer, data-modeler, strategy-author) to deliberate a contested coding decision.
argument-hint: <question>
---

> _When the Forge cannot decide alone, summon four engineering perspectives to deliberate._ This command convenes a synthetic council of four in-repo agents — `architect` (functional/system design), `security-reviewer` (security), `data-modeler` (data: entities, lineage, retention), `strategy-author` (strategy/tradeoff, kill-criteria) — and runs an inline deliberation sequence (positions → cross-examination → recorded dissent → synthesis) to surface a decision with dissent preserved.

## Behavior

This is a **manual orchestration** path invoked directly by the operator or driver:

1. Take `$ARGUMENTS` as the question to deliberate.
2. Spawn four agents in parallel via the Task tool: `architect`, `security-reviewer`, `data-modeler`, `strategy-author`. Brief each with the same question and the relevant code context.
3. Run the following numbered deliberation sequence, written inline (no external skill dependency):
   1. **Positions** — each of the four agents states its position independently, from its own seat's perspective, without seeing the others' output first.
   2. **Cross-examination** — each agent is shown the other three positions and may challenge or question them directly; challenges and responses are recorded verbatim.
   3. **Dissent** — any agent that still disagrees with the emerging consensus after cross-examination records its dissent explicitly, with reasoning. Dissent is never silently dropped, even in the final synthesis.
   4. **Synthesis** — the driving agent (or the invoking operator) synthesizes the four positions plus any recorded dissent into a single decision, citing which seat's concern drove which part of the decision.
4. The command MAY apply `.claude/skills/rubric-application.md` during synthesis to score tradeoffs consistently.
5. Write the synthesized decision (including the recorded dissent) to `<cwd>/.harness/council/<timestamp>-decision.md`. If a pp run is active, also archive it under that run's artifact dir.
6. If TheEights is reachable, the architect's eights-write hook will already have recorded the decision as `type=decision-record, cell=influence` — no extra work needed.
