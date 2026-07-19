# ADR-002: Runtime Stack
**Status:** Accepted (P7) **Date:** 2026-07-19
Node 22 + TypeScript everywhere (one language). Fastify (api/services), React/Next (frontends), Prisma→PostgreSQL, Redis (queues/cache), Docker per host. Integer/base-unit arithmetic (bigint). Rationale: minimal language/framework count, typed interfaces, single CI. Consequences: algosdk pinned 2.x (3.x breaking) for chain reads.
