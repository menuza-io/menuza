# Build from the monorepo root:
#   docker build -f apps/tenant-api/Dockerfile -t tenant-api .
# Production is linux/arm64 (OCI Ampere A1). 

FROM node:22-bookworm-slim AS base

ENV NODE_ENV=production

RUN apt-get update && apt-get install -y openssl sqlite3 ca-certificates \
	&& rm -rf /var/lib/apt/lists/*

FROM base AS deps

WORKDIR /myapp

ADD package.json package-lock.json .npmrc ./
RUN npm ci --include=dev

FROM base AS build

ARG COMMIT_SHA
ENV COMMIT_SHA=$COMMIT_SHA

WORKDIR /myapp

COPY --from=deps /myapp/node_modules /myapp/node_modules
ADD . .

FROM base

ENV PORT="8080"
ENV TENANT_DB_DIR="/data/tenants"
ENV NODE_ENV="production"

WORKDIR /myapp

COPY --from=deps /myapp/node_modules /myapp/node_modules
COPY --from=build /myapp/packages /myapp/packages
COPY --from=build /myapp/apps/tenant-api /myapp/apps/tenant-api
COPY --from=build /myapp/package.json /myapp/package.json

RUN mkdir -p /data/tenants \
	&& echo "#!/bin/sh\nset -x\nsqlite3 \"\$1\"" > /usr/local/bin/tenant-db-cli \
	&& chmod +x /usr/local/bin/tenant-db-cli

WORKDIR /myapp/apps/tenant-api

EXPOSE 8080

HEALTHCHECK --interval=10s --timeout=3s --start-period=10s --retries=3 \
	CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/health').then((r)=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["npm", "start"]
