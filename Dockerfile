# One immutable image for every Durable Runner role. The default CMD runs the
# API; the worker, coordinator and migration roles run the same image with a
# command override, e.g.:
#
#   docker run IMAGE node dist/server/src/worker/worker.js
#   docker run IMAGE node dist/server/src/coordinator/coordinator.js
#   docker run IMAGE node dist/server/src/db/migrate.js
#
# No process manager: each container runs exactly one Node process, matching
# the intended one-container-per-role deployment.

# Base image: bookworm-slim rather than alpine. Every production dependency
# (fastify, pg, drizzle-orm) is pure JavaScript with no install scripts, so
# musl would work, but glibc keeps DNS resolution, stack traces and any
# future optional native addon behaving exactly like local Node. The size
# difference does not justify a second libc to debug.

FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.base.json ./
COPY server ./server
COPY web ./web
RUN npm run build

# Production dependencies are installed in a separate stage so the runtime
# image never contains tsx, typescript, vite, vitest or drizzle-kit. The
# deployed processes run compiled JavaScript with plain `node`.
FROM node:24-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

FROM node:24-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/dist/server ./dist/server
# The compiled migrator resolves its migrations folder relative to its own
# compiled location (dist/server/src/db/migrate.js -> dist/server/drizzle),
# and tsc does not copy .sql/meta files into the build output. The checked-in
# migration artifacts are therefore copied to the exact path the compiled
# code expects, as packaging, without touching application code.
COPY server/drizzle ./dist/server/drizzle
# CA bundle for verifying the RDS server certificate on the cloud (DB_*)
# connection path; ECS task definitions set DB_SSL_CA_FILE to this path.
# Checked into the repo (provenance in server/certs/README.md) rather than
# downloaded here, so every build packages the same reviewed file.
COPY server/certs/rds-global-bundle.pem ./certs/rds-global-bundle.pem
# The API resolves web/dist from process.cwd(); WORKDIR is /app, so the
# built frontend must land at /app/web/dist.
COPY --from=build /app/web/dist ./web/dist
COPY package.json ./

# Run as the unprivileged user the official Node image already ships
# (uid/gid 1000). Nothing in the app writes to the image filesystem, so no
# permission fixups are needed.
USER node

# No image-level HEALTHCHECK: this same image also runs the worker,
# coordinator and migration roles, which expose no HTTP listener, so any
# baked-in check would falsely report them unhealthy. The API serves
# /api/health/live (process up, no dependencies) and /api/health/ready
# (PostgreSQL reachable, 503 otherwise) for the orchestrator to wire into
# the API role's own health/readiness checks.
#
# No init process (tini): each container runs a single Node process as PID 1,
# the worker and coordinator handle SIGTERM themselves, and no production
# code path spawns child processes that could become zombies.
CMD ["node", "dist/server/src/index.js"]
