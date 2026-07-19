FROM node:22-alpine AS build
WORKDIR /app
COPY package.json tsconfig.json next.config.mjs ./
COPY app ./app
RUN npm install --no-audit --no-fund && npm run build
FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/out ./out
# serve the static export (output:export config) on 3000
RUN npm install --no-audit --no-fund -g serve@latest
USER node
EXPOSE 3000
CMD ["serve", "-s", "out", "-l", "3000"]
