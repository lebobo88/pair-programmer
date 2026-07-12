---
id: supabase-contract-stability@1
bare_id: supabase-contract-stability
kind: contract
version: 1
title: Supabase / PostgREST contract stability
source_url: https://supabase.com/docs/guides/database/postgres/row-level-security
generated_by: pp-daemon dump-rubrics
note: This file mirrors the registry in daemon/src/rubrics/registry.ts. Do not edit by hand — regenerate.
---
# Supabase contract-stability rubric

Use this rubric when the contract artifact is Supabase-shaped — Postgres
schema + RLS policies + PostgREST views + Realtime channels + Edge Functions
— rather than a REST OpenAPI document. The OpenAPI rubric mis-fits because
the failure modes here are RLS gaps and migration reversibility, not
operation enumeration.

Score 0..1 per dimension:
- **schema_validity**: tables/columns/types declared; foreign keys explicit; PKs present; check-constraints stated.
- **rls_coverage**: every user-facing table has at least one RLS policy AND `alter table ... enable row level security`. Tables that intentionally disable RLS must carry an inline justification comment naming the trust boundary.
- **auth_model**: policies reference `auth.uid()` / `auth.jwt()` / `auth.role()` explicitly; service-role bypass is called out and confined to server-side callers.
- **realtime_channels**: any table in a realtime publication declares replica identity (full / index) and the publication membership is explicit; broadcast / presence channel naming is documented.
- **migrations_reversibility**: every migration has both an `up` and a `down` (or a written justification when `down` is unsafe, e.g., data-destructive); migrations are ordered monotonically.
- **versioning**: PostgREST view / RPC versioning policy stated; breaking schema changes (column drops, type narrowings, NOT NULL additions on existing columns) gated behind a deprecation window.
- **breaking_change_policy**: `drop column` / `alter type` / RLS-tightening migrations name the deprecation window and a successor.

Outcome:
- pass: every dimension ≥ 0.7.
- revise: any dimension in [0.5, 0.7).
- fail: rls_coverage < 0.7 (an unsecured user-facing table is a structural failure) OR schema_validity < 0.5 OR a breaking change shipped without a stated deprecation window.
