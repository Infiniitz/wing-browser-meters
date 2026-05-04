# syntax=docker/dockerfile:1.7

# ---- Stage 1: install production dependencies ---------------------------------
FROM node:20-alpine AS deps
WORKDIR /app

# Install only what package-lock.json resolves, skipping devDependencies.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# ---- Stage 2: runtime image ---------------------------------------------------
FROM node:20-alpine AS runtime
WORKDIR /app

ENV NODE_ENV=production \
    PORT=3000

# tini = tiny init for proper SIGTERM/SIGINT handling inside the container.
RUN apk add --no-cache tini

COPY --from=deps /app/node_modules ./node_modules
COPY --chown=node:node . .

# Persistent config directory (mount a volume here). Pre-create + chown so the
# non-root `node` user can write on first launch.
RUN mkdir -p /app/data && chown -R node:node /app/data

USER node
EXPOSE 3000
VOLUME ["/app/data"]

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "server.js"]
