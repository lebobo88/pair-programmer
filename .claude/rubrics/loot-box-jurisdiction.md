---
id: loot-box-jurisdiction@1
bare_id: loot-box-jurisdiction
kind: security
version: 1
title: "Loot-box / chance-based reward jurisdiction matrix"
source_url: https://www.franssentolboom.nl/en/loot-boxes-an-overview-of-recent-developments/
generated_by: pp-daemon dump-rubrics
note: This file mirrors the registry in daemon/src/rubrics/registry.ts. Do not edit by hand — regenerate.
---
# Loot-box jurisdiction rubric

Score 0..1 per region cluster. Each region has its own posture; the economy_spreadsheet must declare per-region behavior.

- **belgium**: paid loot-boxes effectively banned (criminal-prosecution stance). MUST disable for BE accounts or remove the mechanic entirely.
- **netherlands**: complicated quasi-ban; 2025 Antwerp ruling extended scope. MUST restrict tradeable loot or convert to known-outcome purchases.
- **eu_general**: EU Digital Fairness Act draft (expected late 2025 / 2026) likely to introduce EU-wide rules; design SHOULD anticipate.
- **china**: drop rates MUST be published publicly per regulator requirement.
- **apple_ios**: drop rates MUST be disclosed per App Store guidelines for any chance-based purchase.
- **google_play**: drop rates MUST be disclosed for chance-based mechanics.
- **us / others**: ESRB requires "In-Game Purchases (Includes Random Items)" notice; some US states have proposed laws.
- **age_gating**: paid loot-boxes MUST NOT be offered to under-18 / under-13 paths regardless of region.

Outcome:
- pass: every region cluster ≥ 0.7 AND a per-region table in the economy_spreadsheet artifact.
- revise: any cluster in [0.5, 0.7) OR any region missing from the table.
- fail: paid loot-box implemented without per-region gating, OR drop rates not declared in regions where required.
