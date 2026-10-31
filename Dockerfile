# Guff API: build with the full toolchain, run with production dependencies only.
FROM node:22-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY seed-assets ./seed-assets
USER node
EXPOSE 4100
# Build the indexes (and load the demo if the database is empty), then start the API.
CMD ["sh", "-c", "node dist/scripts/setup.js && node dist/server.js"]
