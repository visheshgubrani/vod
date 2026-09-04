# syntax=docker/dockerfile:1
# OpenVOD dashboard (Next.js standalone). Build context MUST be repo root.

FROM node:22-alpine AS deps
WORKDIR /repo
RUN corepack enable

COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY web/package.json web/package.json
COPY server/package.json server/package.json
COPY sdk/package.json sdk/package.json
COPY player/package.json player/package.json
COPY delivery/package.json delivery/package.json
COPY clipmux-docs/package.json clipmux-docs/package.json

# clipmux-docs runs `fumadocs-mdx` in postinstall, which cannot run inside
# this image — strip it before installing (scripts are not part of the lockfile).
RUN node -e "const fs=require('fs');const p='clipmux-docs/package.json';const j=JSON.parse(fs.readFileSync(p));if(j.scripts&&j.scripts.postinstall)delete j.scripts.postinstall;fs.writeFileSync(p,JSON.stringify(j,null,2))"

RUN pnpm install --frozen-lockfile

FROM deps AS build
# Public env vars are baked at build time (Next.js requirement)
ARG NEXT_PUBLIC_API_BASE_URL=http://localhost:8787/api
ARG NEXT_PUBLIC_AUTH_BASE_URL=http://localhost:8787/api/auth
ARG NEXT_PUBLIC_FRONTEND_URL=http://localhost:3000

ENV NEXT_PUBLIC_API_BASE_URL=$NEXT_PUBLIC_API_BASE_URL
ENV NEXT_PUBLIC_AUTH_BASE_URL=$NEXT_PUBLIC_AUTH_BASE_URL
ENV NEXT_PUBLIC_FRONTEND_URL=$NEXT_PUBLIC_FRONTEND_URL
ENV NEXT_TELEMETRY_DISABLED=1

COPY web ./web
RUN pnpm --filter ./web build

# ── runner (standalone server) ─────────────────────────────────────────────
FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

RUN addgroup --system --gid 1001 nodejs \
  && adduser --system --uid 1001 nextjs

# Monorepo standalone nests under .next/standalone/web/ — use it as /app root.
COPY --from=build --chown=nextjs:nodejs /repo/web/.next/standalone/web/. ./
COPY --from=build --chown=nextjs:nodejs /repo/web/.next/static ./.next/static
COPY --from=build --chown=nextjs:nodejs /repo/web/public ./public

# Next's traced node_modules preserves pnpm store symlinks, which break the
# standalone server — reinstall production deps cleanly from the traced
# package.json instead.
RUN rm -rf node_modules && npm install --omit=dev --no-audit --no-fund

USER nextjs

EXPOSE 3000

HEALTHCHECK --interval=20s --timeout=5s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:3000/').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
