# syntax=docker/dockerfile:1.7
#
# @feynman/server image. Two-stage: build runs `tsc -b` so the runtime stage
# can `node dist/index.js` directly (no tsx loader in production).
#
# Rationale: 2A's exports map points at TS sources for IDE ergonomics, but
# shipping `tsx` into the image would (a) double the image's startup
# time per cold start (loader chain runs on every `require`/`import`) and (b)
# muddy the runtime — Pi itself spawns Node children and we don't want the
# loader leaking into them. We compile once at build time.

FROM node:22-bookworm-slim AS builder
WORKDIR /app

# Copy workspace manifest + lockfile so npm can install the full workspace.
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/protocol/package.json ./packages/protocol/
COPY packages/core/package.json ./packages/core/
COPY packages/cli/package.json ./packages/cli/
COPY packages/extensions/package.json ./packages/extensions/
COPY packages/prompts/package.json ./packages/prompts/
COPY packages/server/package.json ./packages/server/

# Install full deps for building. `--ignore-scripts` avoids per-package
# postinstalls that may shell out to native toolchains; the server doesn't
# need them.
RUN npm ci --ignore-scripts

# Copy sources.
COPY packages/protocol ./packages/protocol
COPY packages/core ./packages/core
COPY packages/extensions ./packages/extensions
COPY packages/prompts ./packages/prompts
COPY packages/server ./packages/server
COPY skills ./skills
COPY tsconfig.base.json ./tsconfig.base.json

# Compile the server (and any package whose `build` script is `tsc -b`).
RUN npm run -w @feynman/protocol build && \
    npm run -w @feynman/core build && \
    npm run -w @feynman/server build

# ---- Runtime stage ----------------------------------------------------------

FROM node:22-bookworm-slim AS runtime
WORKDIR /app

# wget for HEALTHCHECK.
RUN apt-get update && apt-get install -y --no-install-recommends wget && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production
ENV FEYNMAN_PORT=7777
ENV FEYNMAN_BIND=0.0.0.0
ENV FEYNMAN_VAULT=/vault

# Copy node_modules (prod deps only) + compiled output + assets.
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/packages ./packages
COPY --from=builder /app/skills ./skills

# Stage the server's bundled assets into the .feynman/ layout that
# syncBundledAssets expects (themes/, agents/) at the server's appRoot.
RUN mkdir -p /app/packages/server/.feynman && \
    cp -r /app/packages/server/assets/agents /app/packages/server/.feynman/agents && \
    if [ -d /app/packages/server/assets/themes ]; then cp -r /app/packages/server/assets/themes /app/packages/server/.feynman/themes; fi && \
    if [ -f /app/packages/server/assets/SYSTEM.md ]; then cp /app/packages/server/assets/SYSTEM.md /app/packages/server/.feynman/SYSTEM.md; fi

# Skills are referenced at the server package's appRoot under `skills/`.
RUN ln -s /app/skills /app/packages/server/skills

WORKDIR /vault
EXPOSE 7777

HEALTHCHECK --interval=15s --timeout=3s --start-period=10s --retries=5 \
    CMD wget -qO- "http://127.0.0.1:${FEYNMAN_PORT:-7777}/v1/health" >/dev/null || exit 1

ENTRYPOINT ["node", "/app/packages/server/dist/index.js"]
