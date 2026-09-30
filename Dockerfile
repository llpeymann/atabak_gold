# syntax=docker/dockerfile:1
#
# Production image for the atabak_gold bot.
# - Node.js 22 only (NestJS 11 requires Node >= 20), no Python, no Python dependencies.
# - No apt packages are required: all runtime dependencies are pure JavaScript.
# - The final stage contains only the production build and production dependencies.

# --- Stage 1: dependencies ---------------------------------------------------
FROM node:22-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

# --- Stage 2: build ----------------------------------------------------------
FROM node:22-bookworm-slim AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build \
    && npm prune --omit=dev --no-audit --no-fund

# --- Stage 3: runtime --------------------------------------------------------
FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app

COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/package.json ./package.json

# Market state persistence (MARKET_STATE_FILE) must be writable by the runtime user,
# otherwise the state could not survive a restart.
RUN mkdir -p /app/data && chown -R node:node /app/data
VOLUME ["/app/data"]

EXPOSE 3000

# Run as the unprivileged user that ships with the Node image.
USER node

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 3000) + '/health').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["node", "dist/main.js"]
