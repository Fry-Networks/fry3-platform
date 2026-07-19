# ADR-010: Hot-Wallet Safety
**Status:** Accepted (P7) **Date:** 2026-07-19
Hot wallet referenced only (never exposed). Live-transfer QA uses operator-controlled test wallet + smallest practical amount + round-trip, record both txids. Never real user wallets for destructive tests. Balance monitoring + alerting. Nonce/sequence correctness. Rationale: fund safety + no contract modification.
