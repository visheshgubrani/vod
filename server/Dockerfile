# syntax=docker/dockerfile:1
# OpenVOD API — Node runtime via tsx (no bundler binaries in image).
# Zero-touch boot: migrations run before the server starts.
# Build context MUST be the repo root (monorepo workspace).

FROM node:22-slim
WORKDIR /repo
RUN corepack enable

COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY server/package.json server/package.json
COPY web/package.json web/package.json
COPY sdk/package.json sdk/package.json
COPY player/package.json player/package.json
COPY delivery/package.json delivery/package.json
COPY docs-site/package.json docs-site/package.json

RUN pnpm install --frozen-lockfile --filter vod-api

COPY server ./server

ENV NODE_ENV=production
ENV PORT=4080
ENV HOSTNAME=0.0.0.0
ENV DB_DRIVER=pg

WORKDIR /repo/server

EXPOSE 4080

HEALTHCHECK --interval=15s --timeout=5s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:4080/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["sh", "-c", "node_modules/.bin/tsx src/node/migrate.ts && exec node_modules/.bin/tsx src/node/server.ts"]
