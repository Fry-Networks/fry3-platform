# ADR-009: Integration Equivalence (Storj/Space Acres)
**Status:** Accepted (P7) **Date:** 2026-07-19
storage_capability = healthy_storj OR healthy_space_acres, counted ONCE even if both healthy. Neither = not counted. Separate telemetry preserved per provider. Same OR-substitution principle applied to any other mutually-substitutable integrations. Tested: all 4 combinations (off/off, storj-only, spaceacres-only, both). Rationale: no penalty for running one provider, no double-reward for running both.
