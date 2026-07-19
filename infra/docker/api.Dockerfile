# Fry 3.0 API — multi-stage, self-contained esbuild bundle, non-root.
# Build context: platform/ (workspace root).

# ---- build stage ----
FROM node:22-alpine AS build
WORKDIR /app
COPY apps/api ./apps/api
COPY packages/reward-policy ./packages/reward-policy
COPY packages/integration-health ./packages/integration-health
COPY services/heartbeat-ingest ./services/heartbeat-ingest
COPY services/claim-dispatcher ./services/claim-dispatcher
WORKDIR /app/apps/api
RUN npm install --no-audit --no-fund && npm install --no-audit --no-fund esbuild
# typecheck + tests gate the build
RUN npx tsc --noEmit -p tsconfig.json
RUN npx vitest run
# deterministic self-contained bundle (workspace deps inlined)
RUN npx esbuild src/server.ts --bundle --platform=node --format=esm --target=node22 \
      --alias:@fry3/reward-policy=../../packages/reward-policy/src/index.ts \
      --alias:@fry3/integration-health=../../packages/integration-health/src/index.ts \
      --alias:@fry3/heartbeat-ingest=../../services/heartbeat-ingest/src/online-state.ts \
      --alias:@fry3/claim-dispatcher=../../services/claim-dispatcher/src/claim.ts \
      --external:fastify --outfile=dist/server.mjs

# ---- runtime stage ----
FROM node:22-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY apps/api/package.json ./
RUN npm install --no-audit --no-fund --omit=dev fastify@^4.28.0
COPY --from=build /app/apps/api/dist/server.mjs ./server.mjs
USER node
EXPOSE 3000
ENV PORT=3000
CMD ["node", "server.mjs"]
