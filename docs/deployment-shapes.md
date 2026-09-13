# Deployment shapes

OpenVOD is one codebase with a small number of axes that are chosen per
deployment, and everything else fixed on purpose. This page is the canonical
reference for both: what you can choose, which environment variable or
entrypoint chooses it, what cannot be combined, and what `GET /health/config`
reports back.

`GET /health/config` returns the resolved answer in its additive `deployment`
object, so an operator can see which choices are actually in force instead of
inferring them from defaults.

## Choosable axes

| Axis | Options | Selected by |
| --- | --- | --- |
| API runtime | Node \| Cloudflare Workers | which entrypoint you run — `pnpm dev` and Docker Compose are Node, `pnpm dev:workers` and `wrangler deploy` are Workers |
| Postgres transport | `postgres-js` (`DB_DRIVER=pg`) \| `neon-http` | `DB_DRIVER` |
| Transcode provider | `modal` \| `self-hosted` | `TRANSCODE_PROVIDER` (a per-job override is stored on the job) |
| Dispatch transport | `direct-http` \| `qstash` | `QSTASH_TOKEN` presence — unset means direct HTTPS to the Modal endpoint |
| Rate-limit store | `memory` \| `redis` (plain TCP, Node only) \| `upstash` (REST, both runtimes) | `REDIS_URL`, else `UPSTASH_REDIS_REST_URL` + `UPSTASH_REDIS_REST_TOKEN`, else in-memory |
| Analytics write | `workers-analytics-engine` \| `none` | the `PLAYBACK_ANALYTICS` binding (Workers only) |
| Analytics read | `cloudflare-sql` \| `none` | `ACCOUNT_ID` + `CLOUDFLARE_ANALYTICS_TOKEN` (works on both runtimes) |

## Fixed, and why

| Axis | Value | Why |
| --- | --- | --- |
| Delivery | Cloudflare Worker + R2 (the `delivery/` worker) | It verifies playback JWTs per request and reads R2 through a native binding. There is no Node delivery worker, so no runtime axis exists here. |
| Object storage | Cloudflare R2 (S3 API) | The API, the Modal runner and the delivery worker each talk to R2 through their own path; a generic S3/MinIO backend is not implemented yet. |

Everything else in the platform is runtime-independent: the same Hono app,
routes, state machine and Drizzle schema run on both runtimes.

## Fatal combinations

The composition root resolves the deployment before the server listens. Some
combinations cannot work at all; the server **refuses to start** and prints the
reason rather than looking healthy and failing later:

| Combination | Why it cannot work | Fix |
| --- | --- | --- |
| `DB_DRIVER=pg` on Workers | The Workers runtime forbids reusing a TCP socket across requests, so the first query succeeds and the rest fail with `Cannot perform I/O on behalf of a different request`. | `DB_DRIVER=neon-http` with a Neon URL, or run the API on Node (`pnpm dev`, Docker). |
| `REDIS_URL` on Workers | The runtime cannot open a plain TCP socket at all. | `UPSTASH_REDIS_REST_URL` + `UPSTASH_REDIS_REST_TOKEN` (REST works on both runtimes), or the in-memory limiter. |
| Unrecognised `TRANSCODE_PROVIDER` | Silently keeping the previous provider would run the wrong pipeline. | `modal` or `self-hosted`. |

Absent or optional configuration is deliberately **not** fatal: the app boots
and `/health/config` reports it, which keeps a half-configured install visible
instead of turning into a boot crash loop.

## Environment variables that select the shape

| Variable | Effect |
| --- | --- |
| `DB_DRIVER` | `pg` (postgres.js over TCP) or `neon-http`. The dev template and the Compose stack set `pg`; anything else falls back to `neon-http`. |
| `REDIS_URL` | Plain Redis over TCP for rate limiting. Node runtime only; takes precedence over Upstash. |
| `UPSTASH_REDIS_REST_URL` + `UPSTASH_REDIS_REST_TOKEN` | Upstash REST rate limiting; the only external store usable on Workers. |
| `TRANSCODE_PROVIDER` | `modal` (default) or `self-hosted`. The choice is stored per job, so changing it never reroutes work that already exists. |
| `SELF_HOSTED_ENABLED` | `false` stops new self-hosted submissions while accepted jobs drain; it never moves a local file to Modal. |
| `UPLOADS_ENABLED` | `false` makes upload routes return 403, which is what lets a local-only install be valid without a raw bucket. |
| `QSTASH_TOKEN` | Set selects QStash dispatch; unset selects direct HTTP. |
| `ACCOUNT_ID` + `CLOUDFLARE_ANALYTICS_TOKEN` | Enable the Analytics Engine SQL reader used by the usage dashboard. |
| `DELIVERY_URL` | The single delivery base URL everywhere — playback URLs and the transcode completion callback both read it. Without it, playback URLs are returned relative. |
| `TRANSCODE_INGEST_SECRET` | Signs outbound dispatch and verifies inbound callbacks. It wins over the legacy alias `MODAL_WEBHOOK_SECRET` in **both** directions. |

A deployment that configures none of the optional variables is still valid: it
runs on in-memory rate limiting, direct HTTP dispatch, no analytics reader and
no analytics writer.

## The runtime seam

`server/src/runtime/` is the composition root convention. `deployment.ts`
resolves the axes above once, purely and without throwing, into a
`DeploymentShape` plus fatal and non-fatal problems. `node.ts` and `workers.ts`
are separate composition roots that turn that resolution into runtime
capabilities (database, rate-limit store, analytics sinks, background work,
bindings) and each expose the same shape. An entrypoint imports exactly one
root and hands the result to `createApp`; tests can build either one. Wiring
lives in the roots and decisions live in `deployment.ts` — a new runtime-only
capability belongs behind a port, not in a route.

One platform object is not a capability but a per-request argument: the
`ExecutionContext` Hono exposes as `c.executionCtx`, which routes read to
dispatch tenant webhooks and to schedule post-response work. Workers pass the
real one to `app.fetch`; Node has none, so `createNodeRequestHandler` installs
the tracked stand-in (`nodeExecutionContext`) in one place. Hono's getter
*throws* rather than returning undefined, so a request handler that omits it
turns every webhook-dispatching route — `POST /api/upload/url` included — into a
500.

## `/health/config` contract

The `deployment` object is additive to the rest of the response (`ready`,
`checks`, `problems`, `advisories`, `maintenance`, `transcode` are unchanged)
and contains no secrets:

```json
{
  "deployment": {
    "runtime": "node",
    "dbTransport": "postgres-js",
    "rateLimitStore": "redis",
    "transcodeProvider": "modal",
    "selfHostedEnabled": false,
    "modalDispatch": "direct-http",
    "analyticsWrite": "none",
    "analyticsRead": "cloudflare-sql",
    "uploadsEnabled": true,
    "deliveryRuntime": "cloudflare-worker",
    "deliveryUrl": "https://media.example.com"
  }
}
```

`deliveryUrl` is `null` when `DELIVERY_URL` is unset. `modalDispatch` describes
the transport used for Modal jobs; self-hosted jobs are queued in Postgres and
do not use it.

## Why the two runtimes differ

Cloudflare Workers has no TCP sockets and no Analytics Engine *writes* outside
its own binding, so a Postgres connection string, a plain `REDIS_URL` and a
playback-telemetry write sink are all impossible there. Node has all three.
Everything that can be shared is shared; the axes above are exactly the places
where the runtime's capabilities, not our preferences, decide. This is why
`pnpm dev` (Node) works with the local dev Postgres out of the box and
`pnpm dev:workers` needs `DB_DRIVER=neon-http` with a Neon URL **by design**,
not as a workaround.

## Where to go next

- [deploy.md](./deploy.md) — the Compose deployment flow
- [../README.md](../README.md) — BYOK prerequisites and the first-run walkthrough
- [../CONTRIBUTING.md](../CONTRIBUTING.md) — the development workflow
