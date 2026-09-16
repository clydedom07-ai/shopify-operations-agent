# syntax=docker/dockerfile:1

# The agent runs TypeScript directly on Node's native type-stripping (no build
# step), so the image is just: Node 24 + prod dependencies + source. All durable
# state lives in Postgres (SIGTERM returns cleanly even on memory), so the
# container is stateless and safe to stop, redeploy, and scale away to zero.

FROM node:24-alpine AS base
WORKDIR /app
ENV NODE_ENV=production

# --- Dependencies ---------------------------------------------------------
# Frozen lockfile + prod-only: dev deps (vitest, tsc) are build-time only and
# never ship. The lockfile step is isolated first so dependency changes
# reinstall alone instead of replaying the whole image.
FROM base AS deps
RUN corepack enable && corepack prepare pnpm@10.30.1 --activate
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile --prod

# --- Runtime --------------------------------------------------------------
FROM base AS runtime
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src

# Bind to the container network so the HTTP API is reachable from the host.
# No .env is baked in — configuration comes from the runtime environment
# (Docker -e, compose, or the orchestrator's secret store).
ENV HOST=0.0.0.0
ENV PORT=3000
EXPOSE 3000

# Non-root. State lives in Postgres, so the process never writes to its own
# filesystem.
USER node

# `--env-file-if-exists` tolerates a mounted .env for local runs and ignores a
# missing one in production. Migrations auto-run inside the process at boot.
CMD ["node", "--env-file-if-exists=.env", "src/index.ts"]