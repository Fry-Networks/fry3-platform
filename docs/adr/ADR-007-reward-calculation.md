# ADR-007: Reward Calculation
**Status:** Accepted (P7) **Date:** 2026-07-19
One canonical Fry 3.0 engine. Deterministic, versioned policy (RewardPolicy.weights), integer/base-unit. Transactional ledger, immutable accrual events, idempotent jobs (idempotencyKey=deviceId+intervalStart+policyVersion). Integration eligibility evidence-based (no config-toggle). Full audit per amount. Rationale: correctness + auditability + no double-pay.
