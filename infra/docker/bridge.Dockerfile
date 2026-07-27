# Fry 3.0 bridge (Tooth B) — PG<->Mongo drift monitor. Multi-stage esbuild bundle, non-root.
# Build context: platform/ (workspace root). Mirrors api.Dockerfile.
# Additive: NOT public; brought up only at the P9c flip (DRY_RUN=0 set then).

# ---- build stage ----
FROM node:22-alpine AS build
WORKDIR /app
COPY services/bridge ./services/bridge
COPY packages/db ./packages/db
WORKDIR /app/services/bridge
RUN npm install --no-audit --no-fund && npm install --no-audit --no-fund esbuild
# generate Prisma client (runtime.ts imports @prisma/client)
WORKDIR /app/packages/db
RUN npm install --no-audit --no-fund && npx prisma generate
WORKDIR /app/services/bridge
# typecheck (full, incl runtime/index with drivers present) + tests gate the build
RUN npx tsc --noEmit -p tsconfig.json
RUN npx vitest run
# self-contained bundle; prisma + mongodb external (installed in runtime stage)
RUN npx esbuild src/index.ts --bundle --platform=node --format=esm --target=node22 \
      --external:mongodb --external:@prisma/client --external:.prisma \
      --outfile=dist/index.mjs

# ---- runtime stage ----
FROM node:22-alpine
ENV NODE_ENV=production
RUN apk add --no-cache openssl openssl3 libc6-compat 2>/dev/null || apk add --no-cache openssl
WORKDIR /app
COPY packages/db/package.json ./packages/db/package.json
COPY packages/db/prisma ./packages/db/prisma
COPY services/bridge/package.json ./services/bridge/package.json
WORKDIR /app/packages/db
RUN npm install --no-audit --no-fund --omit=dev && npx prisma generate
WORKDIR /app/services/bridge
RUN npm install --no-audit --no-fund --omit=dev mongodb@^6.9.0 @prisma/client
COPY --from=build /app/services/bridge/dist/index.mjs ./index.mjs
ENV NODE_PATH=/app/packages/db/node_modules:/app/services/bridge/node_modules
USER node
CMD ["node", "index.mjs"]
