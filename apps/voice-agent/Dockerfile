# syntax=docker/dockerfile:1
#
# LiveKit Cloud agent image for the voice worker. The build context is not the
# repository root: `npm run deploy:livekit -w voice-agent` stages a pruned
# monorepo (`turbo prune voice-agent --docker`) and uploads that directory:
#   json/   workspace package.json files + pruned package-lock.json
#   full/   source of voice-agent and the workspace packages it imports
# LiveKit Cloud injects LIVEKIT_URL, LIVEKIT_API_KEY, and LIVEKIT_API_SECRET at
# runtime; every other variable comes from the agent's secrets.

ARG NODE_VERSION=22
FROM node:${NODE_VERSION}-bookworm-slim AS base

# The LiveKit native core reads the system trust store, which slim images lack.
RUN apt-get update -qq \
	&& apt-get install --no-install-recommends -y ca-certificates \
	&& rm -rf /var/lib/apt/lists/*

FROM base AS build

WORKDIR /app

COPY json/ ./
# Scripts stay off: the root `prepare` script runs husky, a dev dependency.
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund

COPY full/ ./
# LiveKit drops `.env.*` files from uploads, so the varlock schema travels
# under another name.
RUN mv apps/voice-agent/env.schema apps/voice-agent/.env.schema

FROM base

ARG UID=10001
RUN adduser \
	--disabled-password \
	--gecos "" \
	--home "/app" \
	--shell "/sbin/nologin" \
	--uid "${UID}" \
	appuser

WORKDIR /app
COPY --from=build --chown=appuser:appuser /app /app
USER appuser

WORKDIR /app/apps/voice-agent
ENV NODE_ENV=production

CMD ["node", "--import=tsx", "src/main.ts", "start"]
