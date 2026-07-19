# ADR-001: Repository Structure

**Status:** Accepted (evidence-decided P7)
**Date:** 2026-07-19

## Context
Fry ecosystem = 125 repos across `Fry-Foundation` org + multi-host sprawl (HERMES00/HEPH00/ZEUS00/ARES00/EPIMETHEUS/frybot). Accumulated undocumented coupling. Zero Azimuth repos in org (rename-safe).

## Decision
Single monorepo `fry-networks/platform` (pnpm workspaces): `apps/`, `services/`, `packages/`, `infra/`, `docs/`. Obsolete repos archived (final GitHub phase), never deleted, metadata exported first.

## Rationale
- One canonical source of truth per entity; no hidden cross-service imports.
- Minimal service/framework/language count (TypeScript/Node + PostgreSQL).
- Atomic cross-module refactors; single CI; single test gate.

## Consequences
- 124 legacy repos → classify → archive proven-unused (P19).
- New platform repo created early (P12) with branch protection + CI.
