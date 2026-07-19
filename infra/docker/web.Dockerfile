FROM node:22-alpine AS build
WORKDIR /app
COPY package.json tsconfig.json next.config.mjs ./
COPY app ./app
COPY lib ./lib
RUN npm install --no-audit --no-fund && npm run build
FROM nginx:alpine
COPY --from=build /app/out /usr/share/nginx/html
EXPOSE 3000
CMD ["nginx", "-g", "daemon off;"]
