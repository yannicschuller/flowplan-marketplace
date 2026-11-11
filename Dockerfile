# syntax=docker/dockerfile:1
# Flowplan Marketplace – image for Coolify's Dockerfile build pack (or any
# Docker host). Build with Next.js standalone output, run as the non-root
# user "node" with one data volume (/app/data: SQLite database, packages,
# previews and the generated secret key).
FROM node:26-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
# npm's download cache survives between builds (BuildKit cache mount).
RUN --mount=type=cache,target=/root/.npm npm ci
FROM deps AS build
COPY . .
# The CI checkout may be private (umask 077); the app runs as node.
RUN chmod -R a+rX /app
ENV NEXT_TELEMETRY_DISABLED=1
# The type check already runs in CI; image builds there skip it.
ARG FLOWPLAN_SKIP_TYPECHECK=""
RUN --mount=type=cache,target=/app/.next/cache npm run build
FROM node:26-bookworm-slim AS runtime
LABEL org.opencontainers.image.title="flowplan-marketplace" \
  org.opencontainers.image.description="Templates, workflows and looks for Flowplan – shared by the community, reviewed before they are published." \
  org.opencontainers.image.source="https://github.com/yannicschuller/flowplan-marketplace" \
  org.opencontainers.image.url="https://marketplace.flowplan.org" \
  org.opencontainers.image.licenses="AGPL-3.0-only"
# OS security updates; curl for Coolify's HTTP healthcheck inside the
# container; npm, npx and corepack are not needed at runtime.
RUN apt-get update && apt-get upgrade -y --no-install-recommends \
  && apt-get install -y --no-install-recommends curl \
  && rm -rf /var/lib/apt/lists/* \
  && rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
    /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 HOSTNAME=0.0.0.0 PORT=3000 \
  MARKETPLACE_DATA_DIR=/app/data NODE_OPTIONS=--disable-warning=ExperimentalWarning
RUN mkdir /app/data && chown node:node /app/data && chmod 700 /app/data
# Application files belong to root: the runtime user can't change them.
COPY --from=build /app/.next/standalone ./
COPY --from=build /app/.next/static ./.next/static
COPY --from=build /app/public ./public
# The Nutzungsbedingungen (read at runtime by lib/legal.ts).
COPY --from=build /app/content/legal ./content/legal
# Official templates, published on every start (lib/official.ts).
COPY --from=build /app/seed/official ./seed/official
USER node
VOLUME ["/app/data"]
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server.js"]
