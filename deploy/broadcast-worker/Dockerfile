# Broadcast worker only. The bot itself keeps building on Timeweb App Platform as before.
# Build from the repository root:
#   docker build -f deploy/broadcast-worker/Dockerfile -t gamenight-broadcast-worker .

FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.json ./
RUN npm ci --no-audit --no-fund
COPY server/src ./server/src
RUN npm run build && npm prune --omit=dev

FROM node:22-alpine
ENV NODE_ENV=production \
    BROADCAST_HEARTBEAT_FILE=/tmp/gnh-broadcast-worker.heartbeat
WORKDIR /app
COPY --from=build --chown=node:node /app/package.json ./
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
USER node
HEALTHCHECK --interval=60s --timeout=10s --start-period=90s --retries=3 \
  CMD ["node", "dist/broadcastWorkerMain.js", "--healthcheck"]
CMD ["node", "dist/broadcastWorkerMain.js", "--daemon"]
