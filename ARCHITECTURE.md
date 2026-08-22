# pair-programmer Architecture

This document is the engineer-facing companion to [`README.md`](README.md) and
[`docs/USER_GUIDE.md`](docs/USER_GUIDE.md). It describes the runtime topology,
the daemon's MCP servers and subsystems, the nine-phase run lifecycle, and the
concepts that shape judging (tiered cross-/same-vendor routing, judge
escalation, and best-of-N + Borda selection).

pair-programmer is a TypeScript daemon (`daemon/`, Node 20) that orchestrates
code generation across **Claude**, **OpenAI Codex (GPT)**, and **Google** (via
the **Antigravity CLI**, `agy`) with tiered validation. It runs fully standalone, and also enrolls into the
sibling AI ecosystem as the **engineering squad** behind Hydra.

> Diagram convention: every Mermaid block below is mirrored by a redundant
> ASCII-art rendering of the same topology, so the document reads correctly in
> any viewer that does not render Mermaid.

---

## 1. C1 — System context

pair-programmer is the engineering harness. Hydra dispatches `DevTask`
envelopes to it; it replies with `DECISION_RECORD` envelopes. All sibling
integrations are **advisory and null-tolerant** — when a peer is offline the
harness degrades the corresponding feature to a no-op and the core
generate → judge → missability lifecycle is unaffected.

```mermaid
%%{init: {'theme':'dark'}}%%
graph TB
    subgraph MESH["AgentMesh — binding control plane (registry · lifecycle · audit · protocol edge)"]
        PP["pair-programmer<br/>(engineering squad / coding harness)"]

        HYDRA["Hydra<br/>multi-squad LangGraph supervisor"]
        EIGHTS["TheEights<br/>memory fabric + evolution + audit · root of trust"]
        SMITH["AgentSmith<br/>meta-governance / N1..N10 invariants"]
        EXEC["ExecutiveSuite<br/>C-Suite decision support"]
        RLM["RLM-Creative<br/>brand & visual advisory"]
        MB["MarketBliss<br/>brand-voice advisory"]
        SENATE["Senate<br/>legal-compliance squad (the Curia)"]
        XENIA["Xenia<br/>customer-support squad (the Hearth)"]
    end

    HYDRA -- "DevTask envelope" --> PP
    PP -- "DECISION_RECORD" --> HYDRA
    PP -- "episodic memory + prior critiques + evolution" --> EIGHTS
    PP -- ".claude/ artifacts validated vs invariants" --> SMITH
    PP -- "CSuiteDecisionPacket (strategic framing)" --> EXEC
    PP -- "CreativeBrief (visual-direction-advisory)" --> RLM
    PP -- "CreativeBrief (brand-voice-check)" --> MB
    SENATE -. "sibling squads under Hydra" .- HYDRA
    XENIA -. "sibling squads under Hydra" .- HYDRA
    MESH -. "enroll via mesh-manifest.yaml<br/>(fail-closed; authority stays TheEights→AgentSmith→Hydra)" .- PP
```

```
  +================ AgentMesh — binding control plane (tenth layer) ==============+
  ‖  ONE registry · ONE lifecycle supervisor · ONE audit timeline ·              ‖
  ‖  ONE protocol edge (A2A/REST/MCP-over-HTTP) · ONE operator console.          ‖
  ‖  Enroll via mesh-manifest.yaml (fail-closed). Authority stays:              ‖
  ‖  TheEights -> AgentSmith -> Hydra. AgentMesh routes + observes; never        ‖
  ‖  arbitrates.                                                                 ‖
  ‖                                                                              ‖
  ‖                       +-----------------------------+                        ‖
  ‖          DevTask  -->  |                             |  --> DECISION_RECORD  ‖
  ‖      (from Hydra)      |       pair-programmer        |     (to Hydra)       ‖
  ‖                       |   engineering squad / harness |                      ‖
  ‖                       +--+-----+--------+------+----+-+                       ‖
  ‖                          |     |        |      |    |                         ‖
  ‖            episodic      |     |        |      |    |   brand-voice           ‖
  ‖            memory +      |     |        |      |    |   advisory              ‖
  ‖            critiques     |     | .claude |      |    |                        ‖
  ‖                          v     v artifacts     v    v                        ‖
  ‖                     +--------+ +-------+  +-------+ +-----+ +----------+       ‖
  ‖                     |TheEights| |Smith |  |Exec   | | RLM | |MarketBliss|     ‖
  ‖                     | mem/evo | |N1-N10|  |Suite  | |creat| | brand    |      ‖
  ‖                     +--------+ +-------+  +-------+ +-----+ +----------+       ‖
  ‖                                                                              ‖
  ‖   Sibling squads under Hydra (not direct pp peers):                          ‖
  ‖     +----------------------+   +----------------------+                       ‖
  ‖     | Senate (the Curia)   |   | Xenia (the Hearth)   |                       ‖
  ‖     | legal-compliance     |   | customer-support     |                       ‖
  ‖     +----------------------+   +----------------------+                       ‖
  +==============================================================================+

  All sibling calls are advisory + null-tolerant (circuit-broken). Offline peer
  => feature degrades to no-op; generate/judge/missability core is unaffected.
```

### AgentMesh enrollment

pair-programmer ships a control-plane manifest at
[`mesh-manifest.yaml`](mesh-manifest.yaml) (`apiVersion: agentmesh/v1`,
`kind: SiblingManifest`). It declares the harness runtime (`node20-ts`,
entrypoint `daemon/dist/index.js mcp`), the full `pp_harness` tool surface, the
lifecycle breaker (`gracefulShutdownMs: 10000`, crash-loop threshold 5 /
60 s), and a **`healthProbe`** that calls the cheap no-args `doctor` MCP tool
(`intervalMs: 20000`, `failureThreshold: 3`). The mesh control plane uses this
manifest to enroll the harness, route health checks, and resolve the gateway
backend key (`backendsKey: pp_harness`, reconciled against
`~/.hydra/backends.json`).

### WS-AUTH operator-capability tokens

pair-programmer does **not** mint or verify operator-capability tokens — it is
not a governance/ticket-write authority. Token minting lives in Hydra
(`hydra_core/auth/capability.py`, HMAC-SHA256 over canonical JSON, base64url;
degraded `sig=None` when `HYDRA_OPERATOR_KEY` is unset), and server-side
**enforcement** lives in TheEights and Xenia on governance / ticket writes.
The harness's ecosystem clients (`daemon/src/ecosystem/`) are read-mostly
consumers of TheEights memory/audit/constitution surfaces; the operator
capability simply gates the downstream governance writes the harness's results
may later trigger through Hydra.

---

## 2. C2 — Container topology

A Claude Code or GitHub Copilot CLI session is the **entrypoint / driver**: it
calls the daemon's MCP tools, dispatches sub-agents, and routes judging. The
daemon hosts **three MCP servers** over stdio:

| Server | Tools | Role |
|---|---|---|
| `pp_harness` | **75** | Orchestration: runs, stages, gates, taxonomy, missability, best-of-N, profiles, teams, rubrics, replay, janitor. |
| `pp_codex`   | **2** (`generate`, `critique`) | Bridges the external **Codex (GPT)** CLI. |
| `pp_agy`     | **2** (`generate`, `critique`) | Bridges the external **Antigravity CLI** (`agy`). |

A separate **read-only HTTP control plane** binds `127.0.0.1:7878`
(`daemon/src/http/server.ts`, idle-shutdown 10 min) for status inspection.
State persists to SQLite under `~/.pp-harness/`; per-run artifacts (attempts,
verdicts, snapshots, winner/loser worktrees) are archived under
`<run_id>/` directories.

```mermaid
%%{init: {'theme':'dark'}}%%
graph LR
    subgraph Entrypoints
        CC["Claude Code CLI"]
        CP["GitHub Copilot CLI"]
    end

    subgraph Daemon["pp-daemon (Node 20 / TypeScript)"]
        H["pp_harness<br/>75 MCP tools"]
        CX["pp_codex<br/>generate · critique"]
        GM["pp_agy<br/>generate · critique"]
        HTTP["HTTP control plane<br/>127.0.0.1:7878 (read-only)"]
    end

    CODEX["Codex (GPT) CLI"]
    AGY["Antigravity CLI (agy)"]
    DB[("SQLite<br/>~/.pp-harness/")]
    ART[("Per-run artifacts<br/>&lt;run_id&gt;/ + worktrees")]

    CC --> H
    CP --> H
    CC -.-> CX
    CC -.-> GM
    CX --> CODEX
    GM --> AGY
    H --> DB
    H --> ART
    H --> HTTP
```

```
   +-------------+      +-------------------+
   | Claude Code |      | GitHub Copilot CLI|     (driver / entrypoint)
   +------+------+      +---------+---------+
          |                       |
          |   MCP (stdio)         |
          v                       v
   +--------------------------------------------------+
   |                pp-daemon (Node 20)               |
   |  +-----------+  +----------+  +----------+        |
   |  | pp_harness|  | pp_codex |  | pp_agy   |        |
   |  | 75 tools  |  | gen/crit |  | gen/crit |        |
   |  +-----+-----+  +----+-----+  +----+-----+        |
   |        |             |             |              |
   |        |        +----v----+   +----v----+         |
   |        |        |Codex CLI|   | agy CLI |         |
   |        |        +---------+   +---------+         |
   |   +----v---------------------+                    |
   |   | HTTP control plane       |  127.0.0.1:7878    |
   |   | (read-only, idle 10m)    |  (status only)     |
   |   +--------------------------+                    |
   +-----------+--------------------+-----------------+
               |                    |
       +-------v-------+    +-------v--------------------+
       | SQLite        |    | Per-run artifacts          |
       | ~/.pp-harness |    | <run_id>/ + git worktrees  |
       +---------------+    +----------------------------+
```

---

## 3. Run lifecycle (9 phases)

`/pp:run` walks a request through nine phases:
**triage → profile → taxonomy → stage loop (judge + Reflexion ×1) →
missability → master-plan patch → finalize**. The stage loop is itself the
generate → judge (→ Reflexion retry ×1) cycle; on a final fail the stage
**surfaces** for human review rather than shipping.

```mermaid
%%{init: {'theme':'dark'}}%%
stateDiagram-v2
    [*] --> Triage
    Triage --> Profile : class + signals
    Profile --> Taxonomy : profile snapshot
    Taxonomy --> StageLoop : sections + missability_required

    state StageLoop {
        [*] --> Generate
        Generate --> Judge : artifact
        Judge --> Archive : pass
        Judge --> Reflexion : fail (×1)
        Reflexion --> Judge : critique fed back
        Judge --> Surfaced : fail again (cap)
        Archive --> [*]
    }

    StageLoop --> Missability : all stages passed
    Missability --> MasterPlan : 56 checks
    MasterPlan --> Finalize : patch PROJECT_MASTER.md
    Finalize --> [*] : complete
    StageLoop --> Surfaced : judge tool failure / cap hit
    Surfaced --> [*] : human review
```

```
 triage ──▶ profile ──▶ taxonomy ──▶ ┌─ STAGE LOOP ──────────────┐
                                     │  generate ──▶ judge        │
                                     │      ▲          │ pass     │
                                     │      │ critique │          │
                                     │   reflexion ◀── │ fail ×1  │
                                     │      (then surfaced on cap)│
                                     └────────────┬───────────────┘
                                                  │ all pass
                                     missability (56) ──▶ master-plan patch
                                                  └──▶ finalize (complete | surfaced)
```

Invariants enforced across the loop: **Reflexion ×1** (exactly one
critique-fed retry per stage), a **loop ceiling** of 6 validator calls per run,
and judge **halt-on-tool-failure** (a broken critique CLI surfaces the run
rather than fabricating a pass).

---

## 4. C3 — Daemon subsystems

The daemon source (`daemon/src/`) is organized into the following subsystems
(verified against the directory tree):

| Subsystem | Path | Responsibility |
|---|---|---|
| MCP servers | `mcp/` | `harness-server.ts` (75 tools), `codex-server.ts`, `antigravity-server.ts`, the CLI runner, and the critique bridge/schema. |
| Orchestrator | `orchestrator/` | Runs, stages, gates, taxonomy, missability, best-of-N + diff-entropy, profiles, teams, forums, design templates, master-plan, AGENTS.md sync, TDD gate, replay, janitor, worktrees, `artifact-validators/`. |
| Ecosystem | `ecosystem/` | TheEights client + writes, Hydra context + envelopes. All null-tolerant / circuit-broken. |
| Hooks | `hooks/` | Hook dispatcher + bash-safety guard (29 hooks across 5 events). |
| Security | `security/` | Secret-scan, untrusted-envelope handling (PII/prompt-injection boundary). |
| DB | `db/` | SQLite database, schema, and migrations. |
| HTTP | `http/` | Read-only control plane on `127.0.0.1:7878`. |
| Rubrics | `rubrics/` | Rubric loader, registry, and dump tooling. |
| Util | `util/` | Locks, logger, paths, prices, and graceful **`shutdown.ts`**. |

```mermaid
%%{init: {'theme':'dark'}}%%
flowchart TB
    subgraph daemon_src["daemon/src/"]
        MCP["mcp/<br/>harness · codex · antigravity · cli-runner · critique-bridge"]
        ORCH["orchestrator/<br/>runs · gates · taxonomy · missability · best-of-n · profiles · teams · forums · master-plan · replay · janitor · artifact-validators/"]
        ECO["ecosystem/<br/>eights-client · eights-writes · hydra-context · hydra-envelopes"]
        HOOKS["hooks/<br/>dispatcher · bash-safety"]
        SEC["security/<br/>secret-scan · untrusted-envelope"]
        DB["db/<br/>database · schema"]
        HTTP["http/<br/>server (7878)"]
        RUB["rubrics/<br/>loader · registry · dump"]
        UTIL["util/<br/>lock · logger · paths · prices · shutdown"]
    end

    MCP --> ORCH
    ORCH --> DB
    ORCH --> RUB
    ORCH --> ECO
    MCP --> SEC
    HOOKS --> ORCH
    MCP --> UTIL
    HTTP --> DB
```

```
   daemon/src/
   ├── mcp/            harness(75) · codex · antigravity · cli-runner · critique-bridge
   ├── orchestrator/   runs · gates · taxonomy · missability · best-of-n ·
   │                   profiles · teams · forums · master-plan · replay ·
   │                   janitor · tdd-gate · worktree · artifact-validators/
   ├── ecosystem/      eights-client · eights-writes · hydra-context · hydra-envelopes
   ├── hooks/          dispatcher · bash-safety        (29 hooks / 5 events)
   ├── security/       secret-scan · untrusted-envelope
   ├── db/             database · schema
   ├── http/           server                          (127.0.0.1:7878, read-only)
   ├── rubrics/        loader · registry · dump
   └── util/           lock · logger · paths · prices · shutdown
```

### Graceful shutdown

On MCP transport disconnect (`stdin` end / `transport.onclose`), SIGTERM/SIGINT,
or an unhandled rejection, the daemon runs a single idempotent
`shutdownAndExit` (`util/shutdown.ts`). It (1) refuses new child spawns, (2)
**aborts all in-flight CLI children** (SIGTERM → 2 s grace → SIGKILL), and (3)
**releases project locks** — but only once every child is confirmed dead. If any
child is unconfirmed at the cap deadline, *all* locks are conservatively
retained (never release a lock while its child may still be alive); the janitor
TTL reaper sweeps retained locks later.

---

## 5. Judging concepts

### 5.1 Judge escalation (gpt-5.4 default → gpt-5.5 opt-in)

Codex critique runs on **`gpt-5.4`** by constitutional default (JUDGE-1 — do not
change). A higher-capability **`gpt-5.5`** is reached only by **opt-in
escalation** for major-scope / last-resort gates; it is never the automatic
default. (Source: `daemon/src/config.ts` `DEFAULT_MODELS`.)

```mermaid
%%{init: {'theme':'dark'}}%%
flowchart LR
    GATE["Critique gate"] --> DEF{"major-scope /<br/>last-resort?"}
    DEF -- "no (default)" --> G54["gpt-5.4<br/>codex_critique"]
    DEF -- "yes (opt-in)" --> G55["gpt-5.5<br/>codex_critique_escalated"]
```

```
   critique gate ──▶ default ─────────────▶ gpt-5.4   (constitutional JUDGE-1)
                  └▶ opt-in escalation ───▶ gpt-5.5   (major-scope / last-resort only)
```

### 5.2 Tiered judging (cross-vendor vs same-vendor)

High-stakes gates (spec, design, security, contracts) require a judge from a
**different vendor** than the generator. Lower-stakes gates (code style, docs,
lint) may be judged by a **different model from the same vendor** — with Codex
same-vendor *upgrading* to cross-vendor when the generator already used
GPT-5.4, and agy falling back to same-model only when no alternative exists.
`gate_eligible_judges` resolves the required tier per gate.

```mermaid
%%{init: {'theme':'dark'}}%%
flowchart TB
    A["Artifact + gate_type"] --> R{"high-stakes?<br/>(spec/design/security/contracts)"}
    R -- "yes" --> CV["CROSS-VENDOR judge<br/>(different vendor than generator)"]
    R -- "no" --> SV["SAME-VENDOR judge<br/>(different model, same vendor)"]
    SV --> U{"Codex gen used GPT-5.4?"}
    U -- "yes" --> CV2["upgrade → cross-vendor"]
    U -- "no" --> SV2["same-vendor stands<br/>(agy: same-model fallback if forced)"]
```

```
   gate ─▶ high-stakes (spec/design/security/contracts) ─▶ CROSS-VENDOR judge
        └▶ low-stakes (code/docs/lint) ─▶ SAME-VENDOR (diff model)
                                           └─ Codex+GPT-5.4 generator ⇒ upgrade to cross-vendor
                                           └─ agy, no alternative      ⇒ same-model fallback
```

### 5.3 Best-of-N fan-out + Borda count

For major-scope requests the harness fans out **N parallel candidates** (a mix
of models/seeds) into isolated **git worktrees**. A tournament judge ranks them;
when **N ≥ 3** the winner is chosen by **Borda count** (plus diff-entropy to
break low-information ties). The winner's worktree is committed and merged back;
losers are archived via `archive_winner_and_losers`.

```mermaid
%%{init: {'theme':'dark'}}%%
flowchart LR
    REQ["major-scope request"] --> FAN(("fan-out N"))
    FAN --> C1["candidate 1<br/>worktree"]
    FAN --> C2["candidate 2<br/>worktree"]
    FAN --> C3["candidate N<br/>worktree"]
    C1 --> BC["Borda count<br/>(+ diff-entropy tiebreak)"]
    C2 --> BC
    C3 --> BC
    BC --> W["winner → commit + merge"]
    BC --> L["losers → archived"]
```

```
   request ─▶ fan-out N candidates (model/seed mix, isolated worktrees)
                 ├─ candidate 1 ─┐
                 ├─ candidate 2 ─┼─▶ tournament judge ─▶ Borda count (N≥3)
                 └─ candidate N ─┘         + diff-entropy tiebreak
                                              ├─ winner ─▶ commit + merge back
                                              └─ losers ─▶ archived
```

---

## 6. Model tiers

Claude generation runs on a tier ladder resolved by the driver
(`daemon/src/config.ts`):

| Tier | Claude model (entrypoint) | Reach |
|---|---|---|
| haiku  | `claude-haiku-4-5-20251001` | bottom of `TIER_ORDER` ladder |
| sonnet | `claude-sonnet-4-6` | middle of ladder |
| opus   | `claude-opus-4-7` | top of `TIER_ORDER`; `shiftTier` clamps here |
| **fable** | `claude-fable-5` | **capability-gated** — off the auto-escalation ladder |

**Fable-5** is never reached by automatic `shiftTier` escalation. It is selected
only via explicit operator config: (a) the **`deep-reasoning-team`**
(`.claude/teams/deep-reasoning-team.yaml`), (b) an explicit per-stage
`generator.model_tier: fable` in any team yaml, or (c) a profile's
`model_tier_policy.per_stage_override[<stage.kind>]: fable`. There is no `--tier
fable` CLI flag and `fable` is intentionally absent from `TIER_ORDER`, so
`shiftTier("opus", +1)` clamps at opus and can never auto-escalate. (GitHub
Copilot mirrors pin Opus one rev lower — `claude-opus-4-6` — via
`COPILOT_CLAUDE_TIER_MODELS`.)

---

## 7. Where to read more

- [`README.md`](README.md) — overview, quick start, ecosystem table.
- [`docs/USER_GUIDE.md`](docs/USER_GUIDE.md) — canonical reference (commands,
  agents, teams, profiles, rubrics, forums, hooks, MCP tools, security model).
- [`taxonomy_blueprint.md`](taxonomy_blueprint.md) — the 16-section taxonomy.
- [`CONSTITUTION.md`](CONSTITUTION.md) — the Immortal Head (rule of faith).
- [`mesh-manifest.yaml`](mesh-manifest.yaml) — AgentMesh control-plane manifest.
