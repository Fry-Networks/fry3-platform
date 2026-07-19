FROM node:22-alpine AS build
WORKDIR /app
COPY package.json tsconfig.json next.config.mjs ./
COPY app ./app
RUN npm install --no-audit --no-fund && npm run build
FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app ./
EXPOSE 3000
CMD ["npm", "start"]
