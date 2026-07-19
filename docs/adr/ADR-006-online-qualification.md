# ADR-006: Online-Device Qualification
**Status:** Accepted (P7) **Date:** 2026-07-19
Reward-eligible iff verified heartbeat within onlineThresholdSeconds (default 300, configurable, server time). States: ONLINE/DEGRADED/OFFLINE/DISABLED/BANNED. Offline/stale/never-seen/banned/disabled = ZERO. Replay defense via unique nonce. Clock-skew rejection (>120s future). Rationale: no ghost rewards; defend fabricated/replayed heartbeats.
