# Security policy

## Supported version

Security fixes are applied to the current `main` branch. Atlas is an evaluation-stage system; no older release line is maintained.

## Reporting a vulnerability

Do not open a public issue for a suspected vulnerability or include credentials, private personal data, or exploit payloads in an issue. Use GitHub's private vulnerability-reporting flow for this repository. Include the affected commit, a minimal reproduction, impact, and any suggested mitigation. Remove secrets and unnecessary personal information from traces and screenshots.

## Operational boundary

The checked-in configuration is replay-only. The OpenRouter credential is a server-side binding and must never use a `NEXT_PUBLIC_*` name. Non-local live HTTP research requires an independent `ATLAS_API_TOKEN`: the dashboard sends it once to `/api/live/session` and thereafter uses a signed, short-lived HttpOnly session cookie, while direct API clients may continue to send the matching `Authorization: Bearer …` header. The provider key never enters the browser; the Atlas access token is entered only into the explicit unlock form and is not written to browser storage by Atlas. The local bypass is set only by the development script and loopback-bound Compose service. Public operators should also place Atlas behind an authenticated gateway with per-principal rate and cost controls.

Atlas is not a background-check service and must not be used for adverse or high-impact decisions. See [docs/safety.md](docs/safety.md) for the source, identity, and data-handling boundaries.
