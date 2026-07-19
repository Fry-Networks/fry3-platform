FROM node:22-alpine
WORKDIR /app
# copy workspace sources needed by api
COPY apps/api ./apps/api
COPY packages/reward-policy ./packages/reward-policy
COPY packages/integration-health ./packages/integration-health
COPY services/heartbeat-ingest ./services/heartbeat-ingest
COPY services/claim-dispatcher ./services/claim-dispatcher
WORKDIR /app/apps/api
RUN npm install --no-audit --no-fund && npx tsc -p tsconfig.json || true
EXPOSE 3000
CMD ["node", "--experimental-strip-types", "src/server.ts"]
