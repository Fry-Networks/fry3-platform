# Fry Networks 3.0 Platform

Clean-room canonical rebuild. Fry 3.0 only.

## Structure
- `apps/` — web (frynetworks.com), api, dashboard, explorer, vote, byod, helpdesk-web, timeclock
- `services/` — reward-engine, claim-dispatcher, heartbeat-ingest, bridge-relayer, timeclock-backend, discord-bot, helpdesk-bot
- `packages/` — db (Prisma), types, reward-policy, integration-health, compat
- `infra/` — docker, nginx, migrations
- `docs/adr` — Architecture Decision Records

## Principles
Integer/base-unit token arithmetic. Server time. Idempotent jobs. Transactional reward ledger. Offline devices earn zero. Storj/Space Acres OR-substitution. No Fry 2.0 runtime.
