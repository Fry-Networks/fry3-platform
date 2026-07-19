# ADR-005: Device Identity
**Status:** Accepted (P7) **Date:** 2026-07-19
One canonical device identity (hardware-derived canonicalId from migration.fem_key_map). Prevent duplicate/conflicting registrations via unique canonicalId + minerKey. FemInstance separate (per-install). Rationale: one device = one reward stream; no ghost duplicates.
