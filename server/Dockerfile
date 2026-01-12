# --- STAGE 1: BUILDER ---
FROM node:22-slim AS builder
WORKDIR /app
RUN corepack enable

# 1. Install ALL dependencies (including devDeps for building)
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile

# 2. Copy source and build
COPY . .

RUN pnpm build 

# 3. Prune dependencies (remove devDeps like typescript/tsx)
ENV CI=true
RUN pnpm prune --prod


# --- STAGE 2: RUNNER (Production) ---
FROM node:22-slim AS runner
WORKDIR /app
ENV NODE_ENV=production

# 1. Security: Don't run as root
USER node

# 2. Copy only necessary files from builder
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/package.json ./package.json

# Copy Drizzle config if you run migrations at runtime (optional)
COPY --from=builder /app/drizzle ./drizzle 

EXPOSE 4080

# 3. Run pure JS (Fast & Low Memory)
CMD ["node", "dist/index.js"]