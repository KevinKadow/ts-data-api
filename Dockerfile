# Pinned multi-platform manifest; update deliberately with deploy/images.json.
FROM node:22.23.5-bookworm-slim@sha256:e9f565d32859f0cbfb52125eafe8be39390f24dac302dc3cdf566e8ba3ab21ee AS dependencies
WORKDIR /app
COPY package*.json ./
RUN npm ci

FROM dependencies AS build
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:22.23.5-bookworm-slim@sha256:e9f565d32859f0cbfb52125eafe8be39390f24dac302dc3cdf566e8ba3ab21ee AS api
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/build ./build
COPY deploy/runtime ./deploy/runtime
USER node
ENTRYPOINT ["node", "deploy/runtime/start.cjs"]
CMD ["node", "build/main.js"]

# Provisioning runs only on explicit operator invocation, never on service startup.
FROM node:22.23.5-bookworm-slim@sha256:e9f565d32859f0cbfb52125eafe8be39390f24dac302dc3cdf566e8ba3ab21ee AS deployment-tools
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl gnupg openssl age mosquitto-clients mosquitto \
    && curl -fsSL https://pgp.mongodb.com/server-8.0.asc | gpg --dearmor -o /usr/share/keyrings/mongodb.gpg \
    && echo 'deb [signed-by=/usr/share/keyrings/mongodb.gpg] https://repo.mongodb.org/apt/debian bookworm/mongodb-org/8.0 main' > /etc/apt/sources.list.d/mongodb.list \
    && apt-get update && apt-get install -y --no-install-recommends mongodb-database-tools \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY scripts/reader-indexes.cjs ./scripts/reader-indexes.cjs
COPY deploy ./deploy
COPY package.json package-lock.json ./
ENTRYPOINT ["node", "deploy/cli.cjs"]
