# ADR-003: Database Strategy

**Status:** Accepted (evidence-decided P7)
**Date:** 2026-07-19

## Context
Fry data today: ARES00 MongoDB (10 Fry DBs: main/frystaking/dbrewards/PoC/creds/migration/measurements/public_explorer/fry_explorer/frynetworks) + HEPH00 MariaDB (timeclock, 2 DBs). Azimuth co-located on ARES (separate `azimuth*` PG cluster — DO NOT TOUCH). Reward data is relational/auditable/transactional.

## Decision
Consolidate Fry data into a **canonical PostgreSQL** instance (separate from Azimuth's cluster; separate Fry DB + role + schema + grants; prefer a dedicated Fry PG instance). Prisma ORM. Canonical schema (21 models). Integer/base-unit amounts as string. Immutable ledger. Migration provenance table.

## Rationale
- Reward ledger needs transactions + auditability + FK constraints (Mongo lacks both).
- One canonical reward ledger, device identity, user/wallet model.
- Azimuth isolation: separate instance/DB/role, zero cluster-wide changes without zero-impact proof.

## Consequences
- Migrate Mongo (main/frystaking/etc.) + MariaDB (timeclock) → PG via idempotent migration scripts + reconciliation (P9).
- Legacy DBs preserved read-only, never deleted.
