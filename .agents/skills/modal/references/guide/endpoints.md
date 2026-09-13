# Endpoints

Modal Endpoints let you deploy models from the
[Modal Library](https://modal.com/library)—or your own custom weights—as
production-ready inference APIs.

* **Fast inference** — tuned open-source serving engines, with speculative
  decoding where supported, behind Modal's low-latency request proxy.
* **Managed infrastructure** — Modal handles provisioning, routing, and
  capacity management.
* **Open and inspectable** — use familiar OpenAI- and Anthropic-compatible APIs;
  [inspect or adapt the generated source](/docs/guide/dedicated-endpoints#view-the-generated-source)
  behind a Dedicated Endpoint.

Choose between two serving modes:

|              | [Shared Endpoints](/docs/guide/shared-endpoints) | [Dedicated Endpoints](/docs/guide/dedicated-endpoints) |
| ------------ | ------------------------------------------------ | ------------------------------------------------------ |
| **Best for** | Fast, fully managed inference                    | Isolated capacity and custom models                    |
| **Models**   | Selected models from the Modal Library           | All Modal Library models, plus custom weights          |
| **Billing**  | Per token                                        | Compute resources                                      |
| **Capacity** | Managed by Modal                                 | Configurable autoscaling, including scale-to-zero      |

## Create an endpoint

Browse the [Modal Library](https://modal.com/library) to choose a model and see
which serving modes it supports. Then create an Endpoint from the
[**Endpoints**](https://modal.com/endpoints) tab in the dashboard.

## Proxy tokens

Shared Endpoints always require a
[Proxy Token](/docs/guide/webhook-proxy-auth). Dedicated Endpoints require one
by default. Create one with the CLI:

```bash
modal workspace proxy-tokens create
```

Join the token ID and secret with a period (`.`) and pass them as a bearer token:

```
Authorization: Bearer wk-<id>.ws-<secret>
```

The combined value can be used as the API key in an OpenAI-compatible client.
See [Proxy Tokens](/docs/guide/webhook-proxy-auth) for environment scoping and
other authentication options. Dedicated Endpoints can also be created with
`--unauthenticated`.

## Call an endpoint

Text-generation models on both Shared and Dedicated Endpoints can be called
through the OpenAI-compatible Chat Completions and Responses APIs or the
Anthropic-compatible Messages API. Embedding models can be called through the
OpenAI-compatible Embeddings API.

The dashboard shows the Endpoint URL and model name. This example uses the Chat
Completions API and a [proxy token](#proxy-tokens):

```bash
curl "<your-endpoint-url>/v1/chat/completions" \
  -H "Authorization: Bearer $MODAL_PROXY_TOKEN_ID.$MODAL_PROXY_TOKEN_SECRET" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "<model-name>",
    "messages": [{ "role": "user", "content": "Hello!" }]
  }'
```

See [Endpoint integrations](/docs/guide/endpoint-integrations) for connecting
coding agents like OpenCode, Codex, and Claude Code to a Shared Endpoint.
