# ADR-011: Discord + Help Desk Architecture
**Status:** Accepted (P7) **Date:** 2026-07-19
Clean rebuild: discofrybot successor (discord-bot service) + helpdesk-bot (discord_tickets successor). Typed config, least-privilege, command registration scripts, health, structured logs, rate-limit, idempotent interactions, ticket audit, test-guild + prod-guild guard. @everyone ONLY for operator-approved announcements; no mass-mention/prod-channel test posts. Rationale: safe support continuity.
