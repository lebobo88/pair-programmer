# Constitution — {{PROJECT_NAME}}

> "One head that cannot die." — The Constitution is the immortal head of
> this project. The harness will read it, hash it, and attest against it.
> No agent will ever rewrite it. Amendments are HITL-only via
> `/pp:constitution amend`.

**Adopted**: {{ADOPTED_DATE}}
**Amendment policy**: HITL-only via `/pp:constitution amend`

---

## Article I — Identity

Describe what this project is, in one short paragraph. What it does, who
it serves, what it explicitly is NOT.

> _(Replace this paragraph. pp will never edit Article I — it is the
> covenantal voice of the project author.)_

---

## Article II — Invariants

Hard guarantees no run may violate. Each invariant is a single,
machine-checkable claim. Phrase them as positive statements.

- _(example) All user-facing strings ship through the i18n pipeline._
- _(example) No PII may be logged at any severity._
- _(example) Every database migration includes a corresponding rollback
  script._

---

## Article III — Forbidden Operations

Operations the harness must refuse OR strongly warn about. The
`constitution-guard` hook reads these bullets when a destructive shell
operation is attempted; matches surface as advisory output (the existing
`block-destructive-shell` hook remains the hard enforcement layer).

- _(example) Auto-merge to main without smoke pass._
- _(example) Dropping data without a migration runbook._
- _(example) Removing tests without a documented replacement._

---

## Article IV — Required Attestations

Stages or taxonomy sections whose finalization MUST be attested against
this constitution. The `constitution-attestation` missability check
enforces this at finalize_run time.

- Section 4.11 (release): every release-stage run requires a passing
  attestation against the current `constitution_sha`.
- Section 4.16 (retirement): every retirement-stage run requires a
  passing attestation.

---

## Article V — Amendment Procedure

Constitutional amendments are not made casually:

1. Author the change as a diff in a separate branch.
2. Run `/pp:constitution amend` and confirm via HITL.
3. The harness records a new `constitution_sha` and binds future runs to
   it. Existing runs replay against their original SHA.

> _(End of constitution. pp records this file's SHA on every run.)_
