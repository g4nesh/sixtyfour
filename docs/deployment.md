# Atlas deployment

Atlas is a stateless streaming web application. Its live runtime is pinned to OpenRouter, while public replay remains zero-network. The browser never receives the OpenRouter key.

## Direct loopback production run with a caller-owned credential file

For a foreground local production run without copying a credential into the checkout, keep the credential file in a private caller-controlled location. The launcher consumes only this variable:

```dotenv
OPENROUTER_API_KEY=replace-with-a-newly-rotated-key
```

Build once, then validate the file and fixed local policy without starting a service:

```sh
npm run build
npm run local:openrouter:check -- --credentials-file /absolute/path/to/private-openrouter-credentials
```

Then start the prebuilt production server:

```sh
npm run local:openrouter -- --credentials-file /absolute/path/to/private-openrouter-credentials
```

The launcher calls Atlas's shared bounded credential-file reader, which uses Node's `parseEnv` utility and reads at most 16 KiB. The reader returns only a validated `OPENROUTER_API_KEY`; parsed `NODE_OPTIONS`, host paths, provider controls, and every other file entry are discarded without entering the process environment. Atlas then replaces the process environment and imports Vinext's `startProdServer` directly to serve the already-built `dist` directory. This path invokes neither the Vinext CLI nor the Vite development server, and it never prints the credential value. Its runtime policy is fixed to live OpenRouter research, `openai/gpt-5.4-nano`, the unauthenticated local-only bypass, `http://localhost:3000` attribution, and a strict `127.0.0.1:3000` listener. Operators who prefer the higher-quality model may explicitly configure `openai/gpt-5.4-mini` in the authenticated container or managed-host path; the loopback launcher intentionally accepts no model override.

This command is intentionally unsuitable for a tunnel, reverse proxy, LAN listener, or public host because its authentication bypass cannot be disabled. Use the authenticated container or managed-host path below for any non-loopback ingress.

## Rotate the disclosed key first

Never deploy an OpenRouter key that has appeared in chat, source control, a screenshot, or a shell command. Delete that key in OpenRouter, create a replacement, and configure only the replacement. OpenRouter documents both [key rotation](https://openrouter.ai/docs/cookbook/administration/api-key-rotation) and [key deletion](https://openrouter.ai/docs/api/api-reference/api-keys/delete-keys).

Atlas uses the current `openrouter:web_search` server tool rather than the deprecated web plugin. Each Atlas search action sets both the native-provider `max_uses` hint and OpenRouter's provider-independent `max_tool_calls: 1` hard stop, while retaining the existing bounded citation limits. OpenRouter charges web-search usage in addition to model tokens; see the [server-tool documentation](https://openrouter.ai/docs/guides/features/server-tools/web-search).

Paid OpenRouter credit avoids relying on a free-model allowance, but it is not a promise of unlimited throughput: model/provider availability and account or key limits can still apply. Set an OpenRouter key spend limit and monitor usage rather than treating the current balance as a hard deployment budget. OpenRouter explains the distinction in its [rate-limit and credit FAQ](https://openrouter.ai/docs/faq).

## Persistent local iMac service

For zero cloud-compute cost without Docker, build Atlas once and install the checked-in user LaunchAgent. The foreground installer reads a caller-selected dotenv file once through the shared bounded reader, consumes only `OPENROUTER_API_KEY`, and atomically writes that one entry to `~/Library/Application Support/Atlas/openrouter.env`. The generated LaunchAgent reads only this managed snapshot and runs the production Vinext build on `127.0.0.1:3000` with `openai/gpt-5.4-nano`.

From a durable checkout, build and write the LaunchAgent plist:

```sh
npm run build
npm run macos:service -- install \
  --project-root="$PWD" \
  --env-file-path="$PWD/.env" \
  --node-path="$(command -v node)" \
  --home-directory="$HOME"
launchctl bootstrap "gui/$(id -u)" "$HOME/Library/LaunchAgents/chat.ganstlr.atlas-backend.plist"
```

The install command must run in the foreground because it is the only step that reads the caller-owned source path. Atlas creates the managed directory with mode `0700`, writes the snapshot with mode `0600`, and rejects symlink substitution. Neither the source path nor the key is written into the plist, command output, or logs. After a successful install, the original source can be moved or removed without affecting the service.

The LaunchAgent starts after login, restarts Atlas after any exit, writes application logs under `~/Library/Logs/Atlas`, and wraps the process in `caffeinate -i` so ordinary idle sleep does not make the backend disappear. Rotate or remove those log files as part of normal host maintenance. The service does not run while the iMac is powered off, before a user logs in after reboot, after logout, or during manually requested sleep.

Check health and service state without exposing the provider key:

```sh
curl --fail http://127.0.0.1:3000/api/health
launchctl print "gui/$(id -u)/chat.ganstlr.atlas-backend"
npm run macos:service -- status \
  --project-root="$PWD" \
  --node-path="$(command -v node)" \
  --home-directory="$HOME"
```

`status` does not reread the caller-owned source. It reports whether the plist matches the desired snapshot-only definition and whether the managed directory and snapshot are present, private, symlink-free, and parseable, without returning credential contents.

Restart after a new production build:

```sh
launchctl kickstart -k "gui/$(id -u)/chat.ganstlr.atlas-backend"
```

To rotate the credential, rerun the foreground install with the replacement caller-owned source, then restart the loaded job. Reinstall atomically replaces the managed snapshot and restores its private file modes:

```sh
npm run macos:service -- install \
  --project-root="$PWD" \
  --env-file-path="/absolute/path/to/replacement-openrouter-credentials" \
  --node-path="$(command -v node)" \
  --home-directory="$HOME"
launchctl kickstart -k "gui/$(id -u)/chat.ganstlr.atlas-backend"
```

To remove it, unload the job before deleting its plist:

```sh
launchctl bootout "gui/$(id -u)/chat.ganstlr.atlas-backend"
npm run macos:service -- uninstall \
  --project-root="$PWD" \
  --node-path="$(command -v node)" \
  --home-directory="$HOME"
```

Uninstall removes only the exact LaunchAgent plist and managed credential snapshot. It preserves the caller-owned source, application logs, and runtime state. A deleted managed snapshot is not recoverable; reinstall from the caller-owned source or a replacement credential file if the service is needed again.

This LaunchAgent is deliberately loopback-only and uses the unauthenticated local bypass. Do not attach it to a tunnel, LAN listener, or public reverse proxy; use the authenticated container path for non-loopback ingress.

## Local iMac container deployment

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

## Public managed hosting

### Render Blueprint: zero-cost public preview

The root `render.yaml` provisions one public Render web service from the verified Docker image. It uses the Free instance type, waits for the linked `main` branch checks to pass before automatic deploys, and disables preview environments. It intentionally uses Render's default TCP readiness probe rather than an HTTP deployment gate; Atlas still exposes `/api/health` for external verification after the service is live. Render supplies the external HTTPS URL to Atlas at runtime, so no deployment hostname is hardcoded.

The public URL exposes the Atlas shell to anyone, but it does **not** make paid live research anonymous. The existing Atlas authorization gate remains enabled: a visitor needs the independent Atlas access token before the server will spend OpenRouter credit. Atlas also admits only one active live stream per server process, bounding accidental overlapping spend. This does not replace per-principal rate limits or a hard deployment-wide spend ceiling.

The live slot remains held until the upstream research iterator has actually unwound after a terminal result, failure, or client cancellation. Cancellation does not release the slot early while provider or tool cleanup is still active. If that cleanup hangs, the process deliberately stays closed to new live runs until it is restarted rather than risk concurrent provider work. Keep the managed service at one instance unless a future deployment adds distributed admission control; each additional process would otherwise own an independent slot.

To create the service:

1. Rotate any OpenRouter key that has appeared in chat or another insecure channel.
2. Open [Deploy Atlas to Render](https://render.com/deploy?repo=https%3A%2F%2Fgithub.com%2Fg4nesh%2Fsixtyfour). If needed, sign in and authorize Render to read the public repository; the Blueprint is fixed to `main`.
3. When Render prompts during the initial Blueprint creation, enter a replacement `OPENROUTER_API_KEY` and a separate random `ATLAS_API_TOKEN` of at least 32 bytes. Enter both directly in Render; do not commit them, put them in `render.yaml`, or upload a local `.env` file.
4. Apply the Blueprint and wait for `/api/health` to pass. Open the assigned `*.onrender.com` URL and use the Atlas token in the unlock form.

Render stores both prompted values as runtime environment secrets because their Blueprint entries use `sync: false`. The tracked policy fixes live mode to OpenRouter, disables the localhost authorization bypass, uses `openai/gpt-5.4-nano`, and self-references Render's assigned `RENDER_EXTERNAL_URL` for OpenRouter attribution. The OpenRouter key never reaches browser code.

Free Render services are suitable for a public demonstration, not dependable production. They spin down after 15 minutes without inbound traffic, can take about a minute to wake, have monthly runtime and outbound-transfer limits, and can be suspended for unusually high outbound traffic. Atlas Deep research intentionally makes multiple outbound requests, so expect cold starts and keep OpenRouter key limits conservative. See [Render's Free instance limits](https://render.com/docs/free), [Docker deployment guide](https://render.com/docs/docker), and [Blueprint reference](https://render.com/docs/blueprint-spec).

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
- `OPENROUTER_MODEL=openai/gpt-5.4-nano`
- `OPENROUTER_SITE_URL` set to the service's canonical public HTTPS URL
- replacement `OPENROUTER_API_KEY` and independent `ATLAS_API_TOKEN` in Secret Manager

The service may allow unauthenticated HTTP access to its static shell and deterministic replay; Atlas still rejects live research until the user establishes the signed Atlas session. Add Google IAM/IAP in front if all application content must be private.

### Other free tiers

- **Oracle Always Free** provides substantially more raw VM capacity, but you own ARM image builds, TLS, firewalling, OS updates, monitoring, and idle-reclamation risk. It is free compute, not effortless deployment. See [Always Free resources](https://docs.oracle.com/en-us/iaas/Content/FreeTier/freetier_topic-Always_Free_Resources.htm).
- **Koyeb Free** currently offers one small 0.1-vCPU/512-MB web instance and scales to zero after idle time. It is suitable for a preview, not a dependable Deep-research backend. See [Koyeb instances](https://www.koyeb.com/docs/reference/instances).
- **Cloudflare Workers Free** is not a container host and currently permits only 10 ms CPU plus 50 external subrequests per invocation. Atlas Deep runs can approach or exceed those limits. A tunnel to the iMac is a better use of Cloudflare's free services. See [Workers limits](https://developers.cloudflare.com/workers/platform/limits/).

## Secret and ingress invariants

- Never put `OPENROUTER_API_KEY` or `ATLAS_API_TOKEN` in a `NEXT_PUBLIC_*` variable.
- Never copy a secret into the Dockerfile, Compose YAML, GitHub Actions file, image, report, trace, browser storage, or command-line argument.
- `LIVE_PROVIDER=openrouter` fails closed unless an OpenRouter key exists; it never falls back to an accidentally configured OpenAI, Gemini, or Anthropic key.
- The OpenRouter key authorizes provider spending. The separate Atlas token authorizes use of this deployment. Rotate them independently.
- Keep the container's public endpoint behind HTTPS. The signed browser session cookie is Secure and is intentionally unavailable over plain remote HTTP.
- Atlas enforces one active live investigation per process. Keep the host at one instance unless a distributed gate is added; horizontal replicas each have their own process-local permit.
- A canceled client keeps its permit until upstream cleanup unwinds. A stuck cleanup therefore fails closed and requires a process restart before another live run can begin.

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
