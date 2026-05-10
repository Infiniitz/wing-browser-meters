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
# su-exec = drop root after fixing bind-mounted volume ownership (./data often
# arrives root-owned or with host UIDs that mismatch user `node`).
RUN apk add --no-cache tini su-exec

COPY --from=deps /app/node_modules ./node_modules
COPY --chown=node:node . .

# Image-local default; bind mounts replace this path — startup chown fixes perms.
RUN mkdir -p /app/data && chown -R node:node /app/data

EXPOSE 3000
VOLUME ["/app/data"]

ENTRYPOINT ["/sbin/tini", "--"]
# Run briefly as root so `chown` applies to the mounted /app/data, then serve as `node`.
CMD ["sh", "-c", "chown -R node:node /app/data && exec su-exec node node server.js"]
