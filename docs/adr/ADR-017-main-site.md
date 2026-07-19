# ADR-017: Main Site (frynetworks.com) — Rebuild vs Retain Wix

**Status:** Accepted (evidence-decided P7)
**Date:** 2026-07-19

## Context
`frynetworks.com` apex is Wix-hosted (`saf7001.wixsite.com/fry-networks`), fronted by Bunny zone 6146466 (fouc-staging) with 5 edge rules (careers/whitepaper/litepaper/docs/explorer overrides). Prior sessions show repeated Wix pain: HEAD embeds don't run scripts, large-payload stalls, viewBox/HTML-injection bugs, baked-loading-screen complexity, documentServices bulk-mutation fragility. Wix content export needs the Wix MCP (ExecuteWixAPI).

## Evidence
- Wix is the #1 source of frynetworks.com defects in memory (FOUC, SVG viewBox collapse, injection-order scramble, nuclear-hide, loading-overlay).
- The site is primarily content + links + docs (whitepaper/litepaper) + forms. No heavy app logic that requires Wix.
- Bunny already proxies/overrides several paths to non-Wix origins (docs-launch).

## Decision
**Rebuild the main site in the monorepo (`apps/web`)** — a clean static/SSR site (React/Next) hosting required public content + docs + forms + links to every surviving Fry app. Retain Wix ONLY as an archived reference (read-only export). Do NOT copy the Wix implementation. Deploy behind Bunny zone 6146466 (repoint origin from Wix to the new origin), preserving the docs/whitepaper/litepaper edge-rule destinations.

## Rationale
- Wix is the dominant defect source; a clean static site is simpler, faster, testable, and version-controlled.
- Full desktop/mobile/browser E2E is achievable only with owned source.

## Consequences
- Wix export archived (P3/P1); content migrated to `apps/web`.
- Bunny zone 6146466 origin repoint is a reversible mutation (backup zone config first — done: `02-maintenance/apex-zone-config-backup.json`).
- Required public content inventory built from Wix recon before cutover.
