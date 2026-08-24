# Atlas deployment

Atlas is a stateless streaming web application. Its live runtime is pinned to OpenRouter, while public replay remains zero-network. The browser never receives the OpenRouter key.

## Rotate the disclosed key first

Never deploy an OpenRouter key that has appeared in chat, source control, a screenshot, or a shell command. Delete that key in OpenRouter, create a replacement, and configure only the replacement. OpenRouter documents both [key rotation](https://openrouter.ai/docs/cookbook/administration/api-key-rotation) and [key deletion](https://openrouter.ai/docs/api/api-reference/api-keys/delete-keys).

Atlas uses the current `openrouter:web_search` server tool rather than the deprecated web plugin. Each Atlas search action sets both the native-provider `max_uses` hint and OpenRouter's provider-independent `max_tool_calls: 1` hard stop, while retaining the existing bounded citation limits. OpenRouter charges web-search usage in addition to model tokens; see the [server-tool documentation](https://openrouter.ai/docs/guides/features/server-tools/web-search).

Paid OpenRouter credit avoids relying on a free-model allowance, but it is not a promise of unlimited throughput: model/provider availability and account or key limits can still apply. Set an OpenRouter key spend limit and monitor usage rather than treating the current balance as a hard deployment budget. OpenRouter explains the distinction in its [rate-limit and credit FAQ](https://openrouter.ai/docs/faq).

## Local iMac deployment

This is the recommended zero-cloud-compute-cost setup. It exposes Atlas only on the iMac loopback interface.

Requirements:

- Docker Desktop with Compose v2
- A newly rotated OpenRouter key
- The repository checkout

Configure the ignored runtime files through the hidden-input prompt:

```sh
npm run container:configure
npm run container:up
```

Open `http://localhost:3000`. Check health without revealing configuration:

```sh
curl --fail http://127.0.0.1:3000/api/health
```

Useful lifecycle commands:

```sh
npm run container:logs
npm run container:down
```

`container:configure` writes three ignored, owner-readable files:

- `secrets/openrouter_api_key`: the replacement provider key
- `secrets/atlas_api_token`: a generated, independent dashboard/API access token
- `.env.atlas`: non-secret OpenRouter model and container settings

The Compose service mounts the two secrets read-only at runtime. They are excluded from Git, the Docker build context, and image layers. The container runs as an unprivileged user, drops Linux capabilities, uses a read-only root filesystem, writes only to bounded temporary filesystems, rotates logs, and restarts unless explicitly stopped.

To rotate only the provider key later:

```sh
npm run container:configure -- --rotate
npm run container:up
```

The independent Atlas access token remains stable, so rotating OpenRouter does not invalidate dashboard sessions.

## Private remote access from the iMac

Use a **named Cloudflare Tunnel** pointing to `http://127.0.0.1:3000`, then protect its hostname with a Cloudflare Access identity policy. Tunnel connections are outbound-only, so do not open a home-router port. Cloudflare documents [named tunnels](https://developers.cloudflare.com/tunnel/) and the [Zero Trust Free setup](https://developers.cloudflare.com/cloudflare-one/setup/).

Before starting a tunnel, change this generated line in `.env.atlas`:

```dotenv
ATLAS_ALLOW_UNAUTHENTICATED_LOCAL=false
OPENROUTER_SITE_URL=https://atlas.your-domain.example
```

Then recreate the Atlas service with `npm run container:up`. Do not configure the tunnel to replace the public request host with `localhost`; Atlas uses the public host to expose the browser authorization gate honestly.

Do not use a Quick Tunnel: Cloudflare describes it as development-only and it does not support server-sent event streams. Preserve Atlas's incremental NDJSON response rather than buffering it in a proxy.

For defense in depth, a non-loopback Atlas page also requires its generated Atlas access token. The browser exchanges that token once for a short-lived, signed, HttpOnly, Secure, SameSite session; it does not store the token in local storage or send it with each research request. On macOS, copy the token without printing it:

```sh
pbcopy < secrets/atlas_api_token
```

Paste it into the Atlas unlock prompt, then clear the clipboard:

```sh
printf '' | pbcopy
```

Keep `ATLAS_ALLOW_UNAUTHENTICATED_LOCAL=true` only while Atlas is used directly through its loopback-bound port. Disable it before attaching a tunnel or reverse proxy, and never enable it on a public cloud service or directly exposed port.

## Managed hosting recommendation

### Google Cloud Run

Cloud Run is the best managed fit when the iMac should not stay online. It accepts this Dockerfile, supports streaming responses, defaults to a five-minute request timeout, and permits up to 60 minutes. Its request-based billing can scale to zero and includes a monthly free allowance, but a billing account is required and excess usage is billable. See [Cloud Run pricing](https://cloud.google.com/run/pricing), [request timeouts](https://docs.cloud.google.com/run/docs/configuring/request-timeout), and [streaming/WebSocket guidance](https://docs.cloud.google.com/run/docs/triggering/websockets).

Start with:

- request-based billing
- minimum instances `0`
- maximum instances `1`
- concurrency `1`
- one vCPU and one GiB of memory
- request timeout `3600` seconds
- `ATLAS_LIVE_ENABLED=true`
- `LIVE_PROVIDER=openrouter`
- `ATLAS_ALLOW_UNAUTHENTICATED_LOCAL=false`
- `OPENROUTER_MODEL=openai/gpt-5.4-mini`
- `OPENROUTER_SITE_URL` set to the service's canonical public HTTPS URL
- replacement `OPENROUTER_API_KEY` and independent `ATLAS_API_TOKEN` in Secret Manager

The service may allow unauthenticated HTTP access to its static shell and deterministic replay; Atlas still rejects live research until the user establishes the signed Atlas session. Add Google IAM/IAP in front if all application content must be private.

### Other free tiers

- **Oracle Always Free** provides substantially more raw VM capacity, but you own ARM image builds, TLS, firewalling, OS updates, monitoring, and idle-reclamation risk. It is free compute, not effortless deployment. See [Always Free resources](https://docs.oracle.com/en-us/iaas/Content/FreeTier/freetier_topic-Always_Free_Resources.htm).
- **Koyeb Free** currently offers one small 0.1-vCPU/512-MB web instance and scales to zero after idle time. It is suitable for a preview, not a dependable Deep-research backend. See [Koyeb instances](https://www.koyeb.com/docs/reference/instances).
- **Render Free** sleeps after 15 idle minutes, may take about a minute to wake, and may suspend unusually outbound-heavy services. Atlas intentionally performs many public-source requests, so this is a poor fit. See [Render Free limitations](https://render.com/docs/free).
- **Cloudflare Workers Free** is not a container host and currently permits only 10 ms CPU plus 50 external subrequests per invocation. Atlas Deep runs can approach or exceed those limits. A tunnel to the iMac is a better use of Cloudflare's free services. See [Workers limits](https://developers.cloudflare.com/workers/platform/limits/).

## Secret and ingress invariants

- Never put `OPENROUTER_API_KEY` or `ATLAS_API_TOKEN` in a `NEXT_PUBLIC_*` variable.
- Never copy a secret into the Dockerfile, Compose YAML, GitHub Actions file, image, report, trace, browser storage, or command-line argument.
- `LIVE_PROVIDER=openrouter` fails closed unless an OpenRouter key exists; it never falls back to an accidentally configured OpenAI, Gemini, or Anthropic key.
- The OpenRouter key authorizes provider spending. The separate Atlas token authorizes use of this deployment. Rotate them independently.
- Keep the container's public endpoint behind HTTPS. The signed browser session cookie is Secure and is intentionally unavailable over plain remote HTTP.
- Run one Deep investigation at a time until measured resource and OpenRouter spend data justify higher concurrency.

## Verification

Before publishing an image:

```sh
npm run verify
npm run security:audit
docker compose --env-file .env.atlas config
docker compose --env-file .env.atlas build --no-cache
npm run container:up
curl --fail http://127.0.0.1:3000/api/health
```

The local machine must actually have Docker for the last three checks. Source-level and Node tests are not evidence that a container image ran successfully.
