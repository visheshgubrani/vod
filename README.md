# OpenVOD

**Open-source, self-hosted video infrastructure. Bring your own keys.**

Paste your Cloudflare R2 credentials and Modal API key and get Mux-style
HLS/DASH ingestion: multipart uploads, GPU transcoding with adaptive-bitrate
ladders, signed playback URLs, AI subtitles & chapters, tenant webhooks and
usage analytics — running on your own accounts in minutes.

> Working title. Package scopes (`@openvod/*`), docs and CI branding are being
> unified around this name ahead of the public release.

## Why OpenVOD

- **BYOK**: no vendor lock-in — Cloudflare R2 (or any S3-compatible store) for
  storage, Modal for GPU transcoding, your Postgres for metadata.
- **Mux-style DX**: upload tokens → direct-to-R2 multipart uploads, typed
  transcode callbacks, playback JWTs with UA/domain binding.
- **Open**: Apache-2.0. Every optional integration (QStash, Upstash Redis,
  Workers Analytics Engine) has a zero-dependency fallback or a documented
  no-op.

## Repository layout

```
server/        Hono API — control plane (Cloudflare Worker or Node/Docker)
delivery/      Cloudflare Worker — media delivery (JWT, manifest rewriting, metering)
web/           Next.js dashboard + Developer Welcome (Vercel or Docker standalone)
sdk/           @openvod/uploader — TypeScript upload SDK (windowed multipart)
player/        @openvod/player — Vidstack-based React player (token auto-refresh)
transcoding/   Modal Python GPU pipeline (FFmpeg + Shaka + Whisper)
clipmux-docs/  Fumadocs documentation site
docs/          Long-form markdown (delivery contract, integrations, branding)
```

## Quickstart (5 minutes)

Both paths need: a Cloudflare account (R2 buckets + delivery worker), a
Postgres database, and a Modal account.

1. **Deploy the API + delivery workers**
   ```bash
   cd server && cp .dev.vars.example .dev.vars   # fill in your keys
   pnpm install && pnpm db:push                  # or drizzle-kit migrate
   wrangler deploy                                # deploy to Workers
   cd ../delivery && wrangler deploy              # set your media domain
   ```
2. **Deploy the transcoder to your Modal account**
   ```bash
   cd transcoding
   modal secret create r2-creds   # R2_ACCOUNT_ID/R2_ACCESS_KEY_ID/R2_SECRET_ACCESS_KEY/R2_BUCKET_NAME
   modal secret create groq-creds # GROQ_API_KEY (optional AI)
   modal deploy main.py
   ```
   Set `MODAL_WEBHOOK_URL`, `TRANSCODE_INGEST_SECRET` and
   `ALLOWED_CALLBACK_HOSTS=<your-api-host>` on the API side.
3. **Frontend** — Vercel (import `web/`) or Docker:
   ```bash
   docker compose up -d            # VPS path (see docs/deploy.md)
   ```
4. Open the dashboard, create your org + API key, and upload a video.

Full walkthroughs (R2 bucket + S3 CORS setup, wrangler domains, Modal
secrets, Neon/Postgres, cost estimates) live in the docs site and
`docs/` — start at [docs/README.md](docs/README.md) or the
[delivery contract](docs/delivery-contract.md).

## Development & tests

```bash
pnpm install                              # per-package (root workspace coming)
pnpm --filter server test                 # API unit/integration suites
pnpm --filter delivery test               # delivery worker (vitest pool-workers)
pnpm --filter sdk test                    # upload SDK (windowed parts, resume)
pnpm --filter player test                 # player token-refresh planning
(cd transcoding && .venv/bin/python -m pytest)  # pipeline logic tests
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for the TDD workflow and seams, and
[SECURITY.md](SECURITY.md) for reporting vulnerabilities.

## License

Apache-2.0 — see [LICENSE](LICENSE). Documentation content is CC-BY-4.0.
