# OpenVOD docs

Long-form reference that lives next to the code. The Fumadocs site in
`docs-site/` is a shorter, navigable version of the same material.

| Doc | What it is |
| --- | --- |
| [deployment-shapes.md](./deployment-shapes.md) | Canonical architecture reference: the choosable axes, what is fixed, fatal combinations, the runtime seam, `/health/config` |
| [deploy.md](./deploy.md) | The Compose deployment flow, Workers path, health checks, maintenance |
| [delivery-contract.md](./delivery-contract.md) | JWT, manifests, error codes, worker behavior |
| [b2b-upload-integration.md](./b2b-upload-integration.md) | Upload tokens + `@openvod/uploader` |
| [self-hosted-transcoding.md](./self-hosted-transcoding.md) | Self-hosted agent setup, hardware, troubleshooting |
| [handoff.md](./handoff.md) | Reliability/ownership/reclamation work and its migration procedure |

Documentation content is [CC-BY-4.0](https://creativecommons.org/licenses/by/4.0/).
The software is Apache-2.0 — see the repository [LICENSE](../LICENSE).

Start with [deployment-shapes.md](./deployment-shapes.md) to see what a
deployment can vary, then [deploy.md](./deploy.md) if you are bringing your own
keys up for the first time, then the [README quickstart](../README.md).
