# OpenVOD docs

Two documentation surfaces, with different audiences. The split is deliberate:

- **[`docs-site/`](../docs-site)** — the published Fumadocs site. For developers
  integrating OpenVOD into an application and operators deploying it: quickstart,
  framework integration guides, the `/v1` API reference, the error catalogue and
  the configuration reference.
- **`docs/`** (this folder) — maintainer-facing material that belongs next to the
  code: cross-service contracts, architecture rationale, build recipes and known
  gaps.

If you are *using* OpenVOD, start at the docs site. If you are *changing* it,
this folder is the reference for how the pieces fit together.

| Doc | What it is | Audience |
| --- | --- | --- |
| [deployment-shapes.md](./deployment-shapes.md) | Canonical architecture reference: the choosable axes, what is fixed and why, fatal combinations, the runtime seam, the `/health/config` contract | Maintainer |
| [delivery-contract.md](./delivery-contract.md) | The wire contract between the delivery worker, the API and the transcoder: object layout, playback JWT, manifest rewriting, transcode payloads, the self-hosted agent protocol | Maintainer |
| [deploy.md](./deploy.md) | The Compose deployment flow, the Workers path, the minimum Cloudflare surface, health checks and background maintenance | Operator |
| [self-hosted-transcoding.md](./self-hosted-transcoding.md) | Self-hosted agent setup, hardware sizing, day-two operation and troubleshooting | Operator |
| [transcoding-toolchain.md](./transcoding-toolchain.md) | The FFmpeg/Shaka build recipe, `versions.env` as the single source of version truth, release gates and rollout | Maintainer |
| [known-gaps.md](./known-gaps.md) | What the platform deliberately does not do yet, weak guarantees worth knowing about, and deferred roadmap work | Maintainer |

## What is not here

The two files that used to live here are gone:

- **`b2b-upload-integration.md`** — superseded by the docs site, which covers the
  same ground with more precision: [Your first video](../docs-site/content/docs/first-video.mdx),
  [Uploads](../docs-site/content/docs/upload.mdx),
  [Webhooks](../docs-site/content/docs/webhooks.mdx),
  [Playback](../docs-site/content/docs/playback.mdx) and the
  [API reference](../docs-site/content/docs/api-reference/index.mdx).
- **`handoff.md`** — documented a specific migration that has landed. The gaps it
  recorded are still open and now live in [known-gaps.md](./known-gaps.md).

## Verifying a claim

Everything in this folder is meant to be traceable to code. When a doc and the
code disagree, the code is right — and the doc is the bug. The usual sources:

| Claim about | Source of truth |
| --- | --- |
| Deployment axes, fatal combinations | `server/src/runtime/deployment.ts`, `server/src/lib/config.ts` |
| Public capability reporting | `server/src/lib/agentCapabilities.ts`, `server/src/routes/health.ts` |
| Playback JWT, object layout | `server/src/routes/video.ts`, `delivery/src/` |
| Self-hosted agent protocol | `server/src/routes/transcoder.ts` |
| Transcode error codes | `transcoding/openvod_transcoder/errors.py` |
| Toolchain versions | `transcoding/toolchain/versions.env` |

Documentation content is [CC-BY-4.0](https://creativecommons.org/licenses/by/4.0/).
The software is Apache-2.0 — see the repository [LICENSE](../LICENSE).
