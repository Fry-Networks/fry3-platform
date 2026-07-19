# ADR-004: Authentication
**Status:** Accepted (P7) **Date:** 2026-07-19
Session JWT (httpOnly cookie) + wallet proof (sign challenge with Algorand address) for wallet-auth. Never request seed/private key/mnemonic. Server-side authorization on every request (not just frontend). Rate-limit + audit security-sensitive actions. Rationale: preserve existing users/wallets; prevent cross-wallet exposure.
