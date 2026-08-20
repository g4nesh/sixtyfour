# Security policy

## Supported version

Security fixes are applied to the current `main` branch. Atlas is an evaluation-stage system; no older release line is maintained.

## Reporting a vulnerability

Do not open a public issue for a suspected vulnerability or include credentials, private personal data, or exploit payloads in an issue. Use GitHub's private vulnerability-reporting flow for this repository. Include the affected commit, a minimal reproduction, impact, and any suggested mitigation. Remove secrets and unnecessary personal information from traces and screenshots.

## Operational boundary

The checked-in configuration is replay-only. Provider credentials are server-side bindings and must never use a `NEXT_PUBLIC_*` name. Non-local live HTTP research requires `ATLAS_API_TOKEN` and a matching `Authorization: Bearer …` header; the local bypass is set only by the development script and loopback-bound Compose service. Public operators should also place Atlas behind an authenticated gateway with per-principal rate and cost controls.

Atlas is not a background-check service and must not be used for adverse or high-impact decisions. See [docs/safety.md](docs/safety.md) for the source, identity, and data-handling boundaries.
