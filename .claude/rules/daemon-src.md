---
paths:
  - "daemon/src/**/*.ts"
---

# Editing rules for `daemon/src/**`

**A Claude-only mirror of several working agreements in `AGENTS.md`, not a replacement.** `AGENTS.md` is the
cross-tool contract that Codex, agy and Copilot read and `.claude/rules/` is not; Claude gets `AGENTS.md`
through the `@AGENTS.md` import in `CLAUDE.md`. **If the two disagree, `AGENTS.md` wins.**

## correct-module-before-edit

*Mirror of `### correct-module-before-edit` in `AGENTS.md`.*

Before editing a module, verify it is the one that **actually implements** the behaviour — not a stale copy,
compiled output, or a similarly-named file. **Editing the wrong module is a silent no-op**: the build passes,
the tests pass, and nothing you intended changed.

Two shapes this takes here specifically:

- **`dist/` is compiled output.** Editing it changes nothing durable and is overwritten by the next
  `npm run build`. The source is `daemon/src/`.
- **`daemon/src/db/schema.sql` is a human-readable mirror of `SCHEMA_SQL` in `schema.ts`, and the two have
  drifted before.** No test enforces full parity — only a narrow column check. A change to one is not a
  change to the other, and a fresh database is built from `schema.ts`. A column added to the *migration* but
  not to the *declaration* means an upgraded install works and a new install throws; that shipped once and
  was caught by a judge.

## git-plumbing

*Mirror of `### git-plumbing` in `AGENTS.md`.*

- In-flight git ops use **`trackedExeca`** (abortable on shutdown).
- Teardown-path git ops use **`trackedExecaNoRefuse`** (registered, not refused after seal).
- Destructive FS ops are guarded by **`isShuttingDown()`** — a shutdown-killed op must **never** trigger a
  destructive fallback.

`daemon/test/ws7-tracked-git.unit.mjs` is the test surface.

## Derived values come from the decision, not a correlate

*Mirror of `## Coding conventions` in `AGENTS.md`.*

From `AGENTS.md`'s coding conventions, repeated here because every violation found so far has been in this
directory. When a reported field depends on a decision or a state change, read it from **the decision
itself**, not from something that usually correlates with it. Proxy derivation masks drift and produces
silent data-integrity defects.

The worked examples are all real: `resumed: true` was derived from "a session row exists" rather than "we
passed `--continue`" (`antigravity-server.ts`, `codex-server.ts`, GitHub #43); `override_source` from the
model id matching a pin rather than from the override decision (#56).

## schema-change-is-two-objects

*Mirror of `### schema-change-is-two-objects` in `AGENTS.md`.*

If you add a table or a column:

- add it to **`SCHEMA_SQL`** so a fresh database has it,
- add it to the **migration** so an existing database gets it,
- bump **`SCHEMA_VERSION`** — earlier migrations shipped without bumping it and stayed at 7 until v10 had to
  reconcile the gap in one step,
- and mirror it into **`schema.sql`**.

Migrations must be **additive, guarded (`IF NOT EXISTS` / `PRAGMA table_info`), idempotent, and must rewrite
no existing row.** Prove it against a fixture built from the *previous* schema, not against the live
database — and prove a **fresh** database built from the declaration alone carries every object too, because
that is the assertion that catches a migration-only column.

## never-manufacture-a-ledger-row

*Mirror of `### never-manufacture-a-ledger-row` in `AGENTS.md`.*

`attempts` records **generation**. `verdicts` record **judgement**. Neither is a place to record that
something merely happened — that is what `execution_events` is for, and it is deliberately a separate table
whose writer touches neither. A failed vendor critique is **not** a generation attempt; conflating them makes
the attempt count a lie.

The same discipline applies to provenance generally: where the true value is not recoverable, record that it
is unknown. Do not guess it. `janitor`'s `untyped_producer_attempts` report is the pattern — it names rows
whose producer cannot be recovered and mutates nothing.
