# ADR-015: Data Migration
**Status:** Accepted (P7) **Date:** 2026-07-19
Mongo (ARES) + MariaDB (timeclock) → canonical PG. Idempotent scripts, MigrationProvenance (unique source triple), restore-to-isolated, exact reconciliation (users/wallets/devices/pending-claims/BYOD/votes exact). Deterministic repair rules (logged). Final-sync: writer census + high-water marks + delta replay + exact reconcile. Legacy DBs preserved read-only. Rationale: zero data loss + provable parity.
