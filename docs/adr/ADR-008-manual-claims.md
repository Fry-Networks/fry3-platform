# ADR-008: Manual Claims + Hot Wallet
**Status:** Accepted (P7) **Date:** 2026-07-19
Manual claims from dashboard. Server calculates amount (never client). Idempotency key. Transactional reservation. Hot-wallet balance+fee check. Safe retry. State machine PENDING→RESERVED→DISPATCHED→CONFIRMED→RECONCILED. Reconciliation job. Chain txId stored. Rate-limit + alert on unusual patterns. No secret exposure. NO smart-contract change; normal authorized transfer from existing reward hot wallet (op://Wallets/nnagvb2qd2myce5xxiaqy3oecm, reference only).
