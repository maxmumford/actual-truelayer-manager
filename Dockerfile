# syntax=docker/dockerfile:1

# Debian (glibc) base so better-sqlite3 uses its prebuilt binaries; build-essential
# + python3 are present as a fallback in case a source build is needed.
FROM node:24-bookworm-slim AS build
WORKDIR /app
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json* ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:24-bookworm-slim AS runtime
ENV NODE_ENV=production
ENV APP_BIND_HOST=0.0.0.0
ENV APP_PORT=3020
ENV APP_DATA_DIR=/app/data
WORKDIR /app
RUN mkdir -p /app/data
COPY package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
# Drop root. The `node` user (uid/gid 1000) ships with the base image; /app/data
# must be owned by it so the SQLite database and generated encryption key remain
# writable.
RUN chown -R node:node /app
USER node
EXPOSE 3020
# Node-based healthcheck avoids depending on wget/curl being installed.
HEALTHCHECK --interval=30s --timeout=5s --retries=3 CMD \
  node -e "require('http').get('http://127.0.0.1:'+(process.env.APP_PORT||3020)+'/health',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"
CMD ["node", "dist/index.js"]
