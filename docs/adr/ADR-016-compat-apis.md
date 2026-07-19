# ADR-016: Backward-Compatible APIs (frozen frontends)
**Status:** Accepted (P7) **Date:** 2026-07-19
fry.farm/fry.market/FEM frontends are source-frozen. Compat adapters (packages/compat) expose the exact request/response contracts they consume, backed by Fry 3.0 services. Contract tests pin each response shape. Rationale: frontends work unchanged against new backend.
