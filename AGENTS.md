# AGENTS.md - Agentic Coding Guidelines

> ## Workspace note (supersedes package-local instructions below)
>
> The repo is now a **single pnpm workspace** rooted at the top level
> (`pnpm-workspace.yaml` + root `pnpm-lock.yaml`). Install once at the root
> and run everything through filters:
>
> ```bash
> pnpm install            # root — do NOT run pnpm install inside a package
> pnpm test               # runs server/delivery/sdk/player suites
> pnpm --filter ./server test     # one package (filters match paths)
> pnpm --filter ./web lint
> pnpm --filter vod-api exec tsc --noEmit
> (cd transcoding && .venv/bin/python -m pytest)   # python logic tests
> ```
>
> The per-package "cd <pkg> && pnpm install" blocks below are legacy; treat
> root workspace commands as authoritative. Secret/hygiene rules still apply
> everywhere (never commit `.env*`/`.dev.vars*` except `.example` files).


This document provides guidelines for agents working on the Vod-app codebase.

## Project Overview

This is a monorepo with 4 packages:
- **web**: Next.js 16 frontend (React 19, Tailwind 4, TypeScript)
- **sdk**: TypeScript SDK for video uploads
- **delivery**: Cloudflare Workers for media delivery
- **server**: Hono API on Cloudflare Workers (Neon Postgres, WAE analytics)

---

## Build/Lint/Test Commands

### Web (Next.js Frontend)

```bash
# Install dependencies
cd web && pnpm install

# Development
pnpm dev          # Start Next.js dev server

# Build & Production
pnpm build        # Production build
pnpm start        # Start production server

# Linting
pnpm lint         # Run ESLint
```

### SDK (TypeScript Upload SDK)

```bash
cd sdk && pnpm install

pnpm build        # Build with tsup
pnpm dev          # Watch mode
pnpm typecheck    # TypeScript check only
```

### Delivery (Cloudflare Workers)

```bash
cd delivery && pnpm install

pnpm dev          # Local dev server (wrangler dev)
pnpm deploy       # Deploy to Cloudflare
pnpm test         # Run vitest tests
pnpm cf-typegen   # Generate Cloudflare types
```

### Server (Hono API on Cloudflare Workers)

```bash
cd server && pnpm install

pnpm dev          # Local dev via wrangler dev (port 8787)
pnpm deploy       # Deploy API worker to Cloudflare
pnpm cf-typegen   # Generate Worker binding types

# Database (Neon Postgres)
pnpm db:push      # Push Drizzle schema to Neon
pnpm db:migrate   # Run migrations
pnpm db:seed      # Seed dev data
```

Copy `server/.dev.vars.example` to `server/.dev.vars` and fill in secrets before running locally.

**Stack:** Cloudflare Workers + Neon (Postgres) + Workers Analytics Engine (playback + bandwidth) + R2 + Modal/QStash for transcoding.

### Running a Single Test

For the delivery package (uses vitest):

```bash
cd delivery
pnpm test -- run
pnpm test -- src/specific-test-file.test.ts
pnpm test -- --testNamePattern="specific test name"
```

---

## Code Style Guidelines

### TypeScript Configuration

- **Strict mode enabled** - All packages use strict TypeScript
- Use explicit types for function parameters and return types
- Avoid `any` - use `unknown` when type is truly unknown
- Use type inference for obvious cases (variable declarations, simple functions)

### Imports

- Use **path aliases** in web: `@/*` maps to `./web/*`
- Use absolute imports with `@/` prefix in web components
- Order imports: external libs → internal modules → relative local imports
- Use named exports for utilities, default exports for React components

```typescript
// Good
import { useState } from 'react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { useVideoUpload } from '@/hooks/use-video-upload'

// Types
import type { Video, UploadProgress } from '@/types'
```

### Naming Conventions

- **Files**: kebab-case for utilities (`auth-client.ts`), PascalCase for components (`VideoTable.tsx`)
- **Variables/functions**: camelCase
- **Types/interfaces**: PascalCase with `Props` suffix for component props
- **Constants**: SCREAMING_SNAKE_CASE for config values
- **React components**: PascalCase, match filename
- **Boolean variables**: use `isXxx`, `hasXxx`, `canXxx` prefixes

### React Components

- Use function components with hooks
- Use `React.forwardRef` for components that need ref forwarding
- Set `displayName` for all exported components
- Prefer composition over inheritance
- Extract reusable logic into custom hooks (`useXxx`)

```typescript
// Component pattern
export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
    variant?: 'primary' | 'secondary'
    size?: 'sm' | 'md' | 'lg'
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
    ({ className, variant = 'primary', ...props }, ref) => {
        return <button ref={ref} className={cn(styles[variant], className)} {...props} />
    }
)

Button.displayName = 'Button'
export { Button }
```

### Error Handling

- Use descriptive error messages
- Catch and wrap errors with context
- Never expose internal errors to users without sanitization
- Use try/catch for async operations with proper error propagation

```typescript
// Good
try {
    const result = await fetchData()
    return result
} catch (error) {
    if (error instanceof AuthError) {
        throw new Error('Please log in again')
    }
    throw new Error(`Failed to fetch data: ${error instanceof Error ? error.message : 'Unknown error'}`)
}
```

### HTTP/API Patterns

- Use standard HTTP methods (GET, POST, PUT, DELETE)
- Return appropriate status codes
- Use consistent response wrapper patterns
- Handle loading and error states in UI

### Cloudflare Workers

- Pass `CloudflareBindings` as generics to Hono:
  ```typescript
  const app = new Hono<{ Bindings: CloudflareBindings }>()
  ```
- Use vitest with `@cloudflare/vitest-pool-workers` for testing

### Tailwind CSS

- Use Tailwind 4 in web package
- Use `cn()` utility from `@/lib/utils` to merge classNames
- Follow mobile-first responsive design
- Keep custom styles minimal; prefer Tailwind utilities

### Database

- Use Drizzle ORM with Neon (PostgreSQL)
- Run migrations via drizzle-kit
- Use proper typing with Drizzle's type inference

### Best Practices

- Keep functions small and focused (single responsibility)
- Use early returns to reduce nesting
- Prefer const over let, avoid var
- Use optional chaining (`?.`) and nullish coalescing (`??`)
- Extract magic numbers into named constants
- Add TODO comments for incomplete code: `// TODO(username): description`
- Remove commented-out code before committing

---

## Environment Variables

**Web:** set `NEXT_PUBLIC_API_BASE_URL` and `NEXT_PUBLIC_AUTH_BASE_URL` (defaults to `http://localhost:8787` for wrangler dev).

**Server (Cloudflare Worker):** copy `server/.dev.vars.example` → `server/.dev.vars` for local `wrangler dev`. Production secrets are set via `wrangler secret put`.

Key server variables:
- `DATABASE_URL` — Neon Postgres connection string
- `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL`, `FRONTEND_URL`
- `ACCOUNT_ID`, `CLOUDFLARE_ANALYTICS_TOKEN` — Analytics Engine SQL API (playback + bandwidth)
- `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, bucket names
- `QSTASH_TOKEN`, `MODAL_WEBHOOK_URL`, `MODAL_WEBHOOK_SECRET`, `BACKEND_URL`
- `JWT_SECRET`, `DELIVERY_WORKER_URL`
- `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN` (rate limiting)

---

## Common Tasks

### Adding a new API route (server)
1. Create route file in `server/src/routes/`
2. Register in `server/src/app.ts`
3. Use `c.executionCtx.waitUntil()` for fire-and-forget background work

### Adding a new component (web)
1. Create in `web/components/` with proper subdirectory
2. Export from index if part of a collection
3. Use existing UI components from `web/components/ui/`

### Adding a new Worker endpoint (delivery)
1. Add route in `delivery/wrangler.jsonc`
2. Create handler in `delivery/src/`
3. Add test coverage

---

## Dependencies

- **web**: Next.js 16, React 19, Tailwind 4, better-auth, TanStack Query
- **server**: Hono, Drizzle ORM, Neon serverless, better-auth, AWS SDK (R2), Upstash QStash/Redis
- **delivery**: Hono, Cloudflare Workers, jose
- **sdk**: TypeScript, tsup
