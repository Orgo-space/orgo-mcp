# syntax=docker/dockerfile:1.7
# ─────────────────────────────────────────────────────────────────────────────
# Orgo MCP — production image for the hosted HTTP server (dist/http.js).
#
# Multi-stage:
#   1. builder — installs all deps (dev + prod), runs the data bundler + tsc
#   2. runtime — ships only the production deps + the built dist/ + LICENSE
#
# Image weight after the second stage is ~150 MB (node-slim) of which ~6 MB
# is the bundled enriched OpenAPI. Smaller than distroless+alpine combos that
# break native `fetch` and AbortSignal in subtle ways.
#
# Non-root, HEALTHCHECK against /healthz, tini for proper PID-1 signal handling.
# ─────────────────────────────────────────────────────────────────────────────

ARG NODE_VERSION=20.18-bookworm-slim

# ── 1. builder ───────────────────────────────────────────────────────────────
FROM node:${NODE_VERSION} AS builder

WORKDIR /build

# Install deps first for better layer caching when only source changes
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

# Copy source + scripts
COPY tsconfig.json ./
COPY src ./src
COPY scripts ./scripts

# The bundler reads from /Users/alex/api-docs by default; override to a path
# we copy in at build time. The api-docs/ tree must be present in the build
# context (mounted, vendored, or fetched in CI before `docker build`).
COPY api-docs /api-docs
ENV ORGO_DOCS_REPO=/api-docs

RUN npm run build

# ── 2. runtime ───────────────────────────────────────────────────────────────
FROM node:${NODE_VERSION} AS runtime

# tini is ~250 KB and gives us proper signal forwarding (SIGTERM -> node)
RUN apt-get update \
 && apt-get install -y --no-install-recommends tini ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Production deps only — drops typescript, tsx, @types/*, ~80 MB savings
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force

# Compiled output + bundled data + license
COPY --from=builder /build/dist ./dist
COPY LICENSE README.md ./

# Run as non-root. The node image already has a `node` user (uid 1000).
USER node

ENV NODE_ENV=production \
    PORT=3333 \
    HOST=0.0.0.0

EXPOSE 3333

HEALTHCHECK --interval=15s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3333)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "dist/http.js"]

# ─────────────────────────────────────────────────────────────────────────────
# Support MCP — the public face of the support agent (dist/support.js).
#
#   docker build --target support -t orgo-support-mcp .
#
# Two things make this a separate target rather than a CMD override on the image
# above:
#
#   1. It must not contain the Orgo API client. `check-support-isolation.mjs`
#      runs inside the build, so an import that reconnects the data path fails
#      the image rather than shipping. Enforcement belongs where it cannot be
#      skipped, not in a CI step someone can rerun with --no-verify.
#
#   2. It needs no api-docs tree and no OpenAPI bundle, so it skips build:data
#      entirely and builds in a fraction of the time.
#
# The image carries no facts, so it is safe to publish. The index is mounted at
# runtime over FACTS_PATH (the production box reads it from SSM); without a
# mount the index is empty, which is a valid state that escalates every question.
# ─────────────────────────────────────────────────────────────────────────────

# ── support builder ──────────────────────────────────────────────────────────
FROM node:${NODE_VERSION} AS support-builder

WORKDIR /build

COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

COPY tsconfig.json ./
COPY src ./src
COPY scripts ./scripts

# tsc only. No build:data, no api-docs dependency.
RUN npx tsc

# The isolation guard. Fails the build if dist/support.js can reach the Orgo API,
# an OAuth validator, or tenant resolution — directly or transitively.
RUN node scripts/check-support-isolation.mjs

# ── support runtime ──────────────────────────────────────────────────────────
FROM node:${NODE_VERSION} AS support

RUN apt-get update \
 && apt-get install -y --no-install-recommends tini ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force

COPY --from=support-builder /build/dist ./dist
COPY LICENSE ./

# Stamped by CI so /healthz and every log line report which snapshot is live.
ARG SOURCE_SHA=unknown
ENV SOURCE_SHA=${SOURCE_SHA}

USER node

ENV NODE_ENV=production \
    PORT=8080 \
    HOST=0.0.0.0 \
    FACTS_PATH=/app/facts.serve.json

EXPOSE 8080

HEALTHCHECK --interval=15s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "dist/support.js"]
