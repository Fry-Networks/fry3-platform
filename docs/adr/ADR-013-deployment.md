# ADR-013: Deployment Strategy
**Status:** Accepted (P7) **Date:** 2026-07-19
Side-by-side: new deploy dirs (/opt/fry3/...), new container names, nonconflicting ports, Fry-only networks/volumes, new Fry PG. Never overwrite legacy images. Preserve maintenance routing until cutover. docker compose up -d (only permitted daemonization). Pin by digest. Config-validate before start. Health+readiness probes. Rationale: reversible, no legacy interference.
