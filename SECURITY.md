# Security Policy

OpenVOD processes video on infrastructure you control, but a vulnerability in
the code can still put your keys, media, or tenants at risk. Please report
issues responsibly.

## Reporting a vulnerability

**Do not open a public GitHub issue for security problems.**

- Report privately by emailing **maintainers@openvod.dev** (PGP key published
  here when available), or
- If you have access, use GitHub's private vulnerability reporting
  (Security → Report a vulnerability).

Include, if possible:

- Affected package(s) and version(s) / commit hash,
- A minimal reproduction (steps, payloads, configuration),
- Impact assessment (what an attacker can achieve),
- Suggested fix, if you have one.

You will receive an acknowledgement within 72 hours and a status update at
least every 7 days until resolution. We ask that you do not disclose the issue
publicly until we publish a fix or grant permission (typical window: 90 days).

## Scope

In scope: `server/`, `delivery/`, `web/`, `sdk/`, `player/`, `transcoding/`,
docs build config. Out of scope: your own deployment configuration (leaked
keys, misconfigured buckets), Cloudflare/Modal/Neon platform issues, and
third-party dependencies already handled by their own disclosure programs
(please still report dependency upgrades here if unpatched upstream).

## Key handling & rotation

This project stores no credentials in the repository. Historical note: an R2
key pair was once committed in `transcoding/.env`; the file was purged from all
history and the key rotated. Lessons codified below:

- `.env`/`.dev.vars` files are never tracked; only `.example` templates are.
- Regenerable build artifacts (`dist/`, `__pycache__/`, lockfile-adjacent
  output) are never tracked.
- If you believe a secret reached this repository, **rotate it immediately**
  and open a private report so history can be scrubbed.

## Threat model (summary)

OpenVOD is a BYOK platform: deployments hold Cloudflare R2 credentials and a
Modal webhook secret server-side, plus a shared playback `JWT_SECRET` used by
the API and the delivery worker.

- **Playback tokens**: HS256 JWTs bound to `video_id`, `org_id`, normalized
  user-agent hash, optional domain allowlist, and `exp`. The delivery worker
  verifies tokens on every request for signed content. UA binding is advisory
  (native players/casting devices are exempt); treat tokens as bearer
  credentials with limited lifetime — keep them out of logs and share URLs
  only with intended viewers.
- **Ingest/webhook secrets**: constant-time comparisons are used; secret values
  must never be logged. Debug logging must stay behind env flags.
- **SSRF**: the transcoder validates every redirect hop and rejects private/
  loopback/link-local targets; callback hosts are allowlisted.
- **Tenant isolation**: videos and API keys are scoped to organizations;
  membership checks are enforced at per-video endpoints. Dashboard routes
  trust the active organization from the session.

Full documentation lives in the docs site (`Security model` section).

## Supported versions

Only the latest `main` is supported. Releases receive security backports for
the most recent minor version when published.
