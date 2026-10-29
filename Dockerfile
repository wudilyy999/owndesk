# syntax=docker/dockerfile:1
# Adapted from the pinned MIT upstream Dockerfile; separate Web and Docker-owning worker.
FROM node:24.20.0-bookworm-slim AS build
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
# Build placeholders are public, short-lived inputs; deployments supply their own secrets.
RUN DATABASE_URL=postgresql://build:build@127.0.0.1/build \
    APP_URL=http://localhost:6797 \
    BETTER_AUTH_SECRET=public-build-placeholder-never-used-in-production \
    MASTER_KEY=0000000000000000000000000000000000000000000000000000000000000000 \
    INSTALL_ID=00000000-0000-4000-8000-000000000000 \
    npm run build \
 && npm prune --omit=dev \
 && rm -rf .next/cache

FROM node:24.20.0-bookworm-slim AS web
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 ARTIFACT_DIR=/app/data/artifacts
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/.next ./.next
COPY --from=build /app/package.json /app/package-lock.json /app/next.config.ts /app/tsconfig.json ./
COPY --from=build /app/lib ./lib
COPY --from=build /app/db ./db
COPY --from=build /app/worker ./worker
COPY --from=build /app/scripts ./scripts
COPY --from=build /app/workstation/controller/native-schema.mjs /app/workstation/controller/native-schema.d.mts ./workstation/controller/
COPY --from=build /app/licenses ./licenses
COPY --from=build /app/LICENSE /app/THIRD_PARTY.md /app/provenance.json ./
RUN mkdir -p /app/data/artifacts && chown node:node /app/data/artifacts
USER node
EXPOSE 6797
CMD ["node", "node_modules/next/dist/bin/next", "start", "--hostname", "0.0.0.0", "--port", "6797"]

FROM docker:29.7.2-dind AS docker-cli
FROM web AS worker
USER root
COPY --from=docker-cli /usr/local/bin/docker /usr/local/bin/docker
RUN apt-get update \
 && apt-get install -y --no-install-recommends iptables iproute2 \
 && rm -rf /var/lib/apt/lists/*
EXPOSE 6798
CMD ["node", "--import", "tsx", "worker/main.ts"]
