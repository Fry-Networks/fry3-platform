# ADR-012: Subdomain Consolidation (scored, evidence-decided)

**Status:** Accepted (evidence-decided P7, no predetermined bias)
**Date:** 2026-07-19

## Context
dashboard/byod/vote/explorer currently separate subdomains (own Bunny zones + HERMES00 nginx server blocks). Decision: keep, merge into `frynetworks.com` routes, or redirect. Scored on: authentication, cookie/security boundaries, failure isolation, deployment complexity, existing links, external consumers (FEM/mobile), caching, maintenance, operational burden, rollback.

## Scoring (1=bad, 5=good)
| Criterion | Keep subdomains | Merge into frynetworks.com routes |
|---|---|---|
| Authentication consistency | 3 (separate cookie domains) | 5 (single session) |
| Cookie/security boundary | 5 (isolation) | 3 (shared scope) |
| Failure isolation | 5 (independent zones) | 2 (one blast radius) |
| Deployment complexity | 3 (per-zone deploys) | 4 (one app) |
| Existing external links | 5 (preserved) | 2 (need redirects) |
| External consumers (FEM/mobile) | 5 (stable API hosts) | 3 |
| Caching | 4 (per-zone) | 4 |
| Maintenance (single point) | 4 | 3 |
| Operational burden | 3 (many zones) | 5 (one) |
| Rollback | 4 | 3 |
| **Total** | **41** | **34** |

## Decision
**Keep subdomains** for dashboard/explorer/vote/byod (failure isolation + existing links + FEM/mobile stability outweigh consolidation simplicity). `frynetworks.com` apex = rebuilt main site (ADR-017) that LINKS to each surviving app. Preserve all existing public URLs; add redirects only where a surface is merged. `dao.` merges into `vote.` (redirect) — they were the same app.

## Consequences
- All current subdomain URLs keep working.
- Main site rebuilt with correct links to every app.
- Compat redirects for any merged surface (dao→vote).
