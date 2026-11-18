# Build for both Oracle Ampere (arm64) and x86 hosts:
#   docker buildx build --platform linux/arm64,linux/amd64 -f deploy/Dockerfile -t invoice-collector .

# ---- build stage: toolchain for native modules (re2, better-sqlite3), UI build ----
FROM node:22-bookworm-slim AS build
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json vite.config.ts index.html ./
COPY src ./src
# The UI imports shared code (naming, types, settings types) from server/.
COPY server ./server
RUN npm run build
# Drop dev dependencies; native modules stay as compiled above.
RUN npm prune --omit=dev

# ---- runtime stage: no compilers ----
FROM node:22-bookworm-slim
ENV NODE_ENV=production \
    PORT=3100 \
    DATA_DIR=/data
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json tsconfig.json server.ts ./
COPY server ./server
COPY recipes ./recipes
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 3100
# node:22-slim has no curl; probe with node's built-in fetch.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||3100)+'/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
CMD ["node", "--import", "tsx", "server.ts"]
