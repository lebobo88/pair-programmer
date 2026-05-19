---
description: Forge crown — convene a synthetic council (Architect + CTO + CISO + CDO) on a contested coding decision.
argument-hint: <question>
---

> _When the Forge cannot decide alone, summon the Executive crown to deliberate._ This command convenes a synthetic council of four perspectives — architect (functional), CTO, CISO, CDO — and applies the `debate-protocol` skill to surface positions, dissent, and a synthesized decision.

## Behavior

This command is fully implemented when Phase E (T3 — Hydra bidirectional + cross-crown handshakes) lands. Until then, this is a **manual orchestration** path:

1. Take `$ARGUMENTS` as the question to deliberate.
2. Spawn four agents in parallel via the Task tool: `architect`, `cto`, `ciso`, `cdo`. Brief each with the same question + the relevant code context.
3. Apply the `debate-protocol` skill to structure the positions and surface dissent.
4. Write the synthesized decision to `<cwd>/.harness/council/<timestamp>-decision.md`. If a pp run is active, also archive it under that run's artifact dir.
5. If TheEights is reachable, the architect's eights-write hook will already have recorded the decision as `type=decision-record, cell=influence` — no extra work needed.

Until Phase E ships, prefer `/board-meeting` from the ExecutiveSuite skill set for full board-level deliberation; this command is the smaller, code-decision-scoped variant.
