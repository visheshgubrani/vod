# Deployment shapes

ClipMux is one codebase with a small number of axes that are chosen per
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
| Postgres | bundled/dev Postgres \| any `postgresql://` URL (including Neon as ordinary hosted Postgres) | `DATABASE_URL` |
| Transcode provider | `modal` \| `local` | `TRANSCODE_PROVIDER` (deployment setting; accepted jobs retain their provider) |
| Dispatch transport | `direct-http` \| `qstash` | `QSTASH_TOKEN` presence — unset means direct HTTPS to the Modal endpoint |
| Rate-limit store | `memory` \| `redis` (plain TCP) \| `upstash` (REST) | `REDIS_URL`, else `UPSTASH_REDIS_REST_URL` + `UPSTASH_REDIS_REST_TOKEN`, else in-memory |
| Analytics | on (default) \| off | `ANALYTICS_ENABLED`; writes go through the delivery worker |
| Analytics write | `delivery-worker` \| `none` | `ANALYTICS_ENABLED` plus `DELIVERY_URL` and `ANALYTICS_INGEST_SECRET` |
| Analytics read | `cloudflare-sql` \| `none` | `ANALYTICS_ENABLED` plus `ACCOUNT_ID` + `CLOUDFLARE_ANALYTICS_TOKEN` |

## Fixed, and why

| Axis | Value | Why |
| --- | --- | --- |
| Delivery | Cloudflare Worker + R2 (the `delivery/` worker) | It verifies playback JWTs per request and reads R2 through a native binding. There is no Node delivery worker, so no runtime axis exists here. |
| Object storage | Cloudflare R2 (S3 API) | The API, the Modal runner and the delivery worker each talk to R2 through their own path; a generic S3/MinIO backend is not implemented yet. |

Everything else in the platform is Node API + Cloudflare delivery: the same
Hono app, routes, state machine and Drizzle schema. The API Worker runtime is
archived at `archive/workers-api` / tag `v0-workers-checkpoint`.

## Fatal combinations

The composition root resolves the deployment before the server listens. Some
combinations cannot work at all; the server **refuses to start** and prints the
reason rather than looking healthy and failing later:

| Combination | Why it cannot work | Fix |
| --- | --- | --- |
| Unrecognised `TRANSCODE_PROVIDER` | Silently keeping the previous provider would run the wrong pipeline. | `modal` or `local`. |

`DB_DRIVER` is obsolete. If it is still set, the API starts and reports an
advisory: remove it. A Neon URL is a regular `DATABASE_URL`.

Absent or optional configuration is deliberately **not** fatal: the app boots
and `/health/config` reports it, which keeps a half-configured install visible
instead of turning into a boot crash loop.

## Environment variables that select the shape

| Variable | Effect |
| --- | --- |
| `DATABASE_URL` | postgres-js over TCP. Provider-neutral; a Neon URL is an ordinary connection string. |
| `REDIS_URL` | Plain Redis over TCP for rate limiting; takes precedence over Upstash. |
| `UPSTASH_REDIS_REST_URL` + `UPSTASH_REDIS_REST_TOKEN` | Upstash REST rate limiting. |
| `TRANSCODE_PROVIDER` | `modal` (default) or `local`. The deployment setting applies to new jobs; accepted jobs keep their recorded provider. |
| `LOCAL_TRANSCODE_ENABLED` | `false` stops new local submissions while accepted jobs drain. |
| `LOCAL_TRANSCODER_SECRET` | Shared only between the API and the one local worker. |
| `LOCAL_IMPORT_ORG_ID` | Optional existing organization that may browse mounted host folders; ordinary uploads need no import organization. |
| `UPLOADS_ENABLED` | `false` makes upload routes return 403, which is what lets a local-only install be valid without a raw bucket. |
| `QSTASH_TOKEN` | Set selects QStash dispatch; unset selects direct HTTP. |
| `ANALYTICS_ENABLED` | Default true. False stops playback/bandwidth collection and analytics queries. |
| `ANALYTICS_INGEST_SECRET` | Shared only between the Node API and the delivery worker. Independently generated from `JWT_SECRET`. |
| `ACCOUNT_ID` + `CLOUDFLARE_ANALYTICS_TOKEN` | Enable the Analytics Engine SQL reader used by the usage dashboard. |
| `DELIVERY_URL` | The single delivery base URL everywhere — playback URLs and playback-telemetry forwarding both read it. Without it, playback URLs are returned relative and analytics write is `none`. |
| `SWEEP_ENABLED` | Default true. False disables this instance’s in-process maintenance scheduler. Additional replicas must set it false. |
| `MAINTENANCE_INTERVAL_SECONDS` | Seconds between maintenance passes after each completion (default 900; positive integer in 1–2147483). |
| `TRANSCODE_INGEST_SECRET` | Signs outbound dispatch and verifies inbound callbacks. It wins over the legacy alias `MODAL_WEBHOOK_SECRET` in **both** directions. |

A deployment that configures none of the optional variables is still valid: it
runs on in-memory rate limiting, direct HTTP dispatch, no analytics reader and
no analytics writer.

## The runtime seam

`server/src/runtime/` is the composition root convention. `deployment.ts`
resolves the axes above once, purely and without throwing, into a
`DeploymentShape` plus fatal and non-fatal problems. `node.ts` turns that
resolution into capabilities (database, rate-limit store, analytics forwarding,
background work) and exposes the same shape. The Node entrypoint hands the
result to `createApp`. Wiring lives in the root and decisions live in
`deployment.ts` — a new platform-specific capability belongs behind a port,
not in a route.

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
    "localTranscodeEnabled": true,
    "modalDispatch": "direct-http",
    "analyticsEnabled": true,
    "analyticsWrite": "delivery-worker",
    "analyticsRead": "cloudflare-sql",
    "uploadsEnabled": true,
    "deliveryRuntime": "cloudflare-worker",
    "deliveryUrl": "https://media.example.com"
  }
}
```

`deliveryUrl` is `null` when `DELIVERY_URL` is unset. `modalDispatch` describes
the transport used for Modal jobs; local jobs are queued in Postgres and
do not use it.

## The API is Node; delivery is Cloudflare

The API always runs on Node. Playback is always the Cloudflare Worker in
`delivery/`. Analytics Engine *writes* happen on that worker: the player posts
to Node `POST /api/playback/journal`, which validates events, resolves each
video's organization, and forwards normalized rows to
`POST /internal/analytics/playback` on the delivery worker.

`analyticsWrite` is `"delivery-worker"` when `ANALYTICS_ENABLED` is on and
`DELIVERY_URL` plus `ANALYTICS_INGEST_SECRET` are set; otherwise `"none"`.
That value is configured capability, not remote liveness.

## Analytics has two independent halves

| Half | Needs | Where it works |
| --- | --- | --- |
| **Read** (`analyticsRead: 'cloudflare-sql'`) | `ANALYTICS_ENABLED`, `ACCOUNT_ID` + `CLOUDFLARE_ANALYTICS_TOKEN`, and the dataset to already exist | Node — HTTPS call to the SQL API |
| **Write** (`analyticsWrite: 'delivery-worker'`) | `ANALYTICS_ENABLED`, `DELIVERY_URL`, `ANALYTICS_INGEST_SECRET`, and the delivery worker's `PLAYBACK_ANALYTICS` binding | Node forwards; delivery writes |

Forwarding is best-effort: a five-second timeout, no retries, no queue. Accepted
events are not a durable-storage promise. Geographic enrichment is out of
scope (`country` is `"unknown"` unless a later trusted source is added).

`ANALYTICS_ENABLED=false` stops playback and bandwidth collection and analytics
queries. Media delivery still works. Existing datasets are not deleted. The
dashboard shows a disabled/unavailable notice rather than implying zero usage.

Bandwidth writes still happen on the delivery worker (`USAGE_ANALYTICS` /
`bandwidth_usage`) when analytics are enabled.

## Where to go next

- [deploy.md](./deploy.md) — the Compose deployment flow
- [../README.md](../README.md) — BYOK prerequisites and the first-run walkthrough
- [../CONTRIBUTING.md](../CONTRIBUTING.md) — the development workflow
