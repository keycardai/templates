# SPEC: a2a-delegation-typescript

## Purpose

Run two A2A 1.0 JSON-RPC agents in one Keycard zone. The caller authenticates an incoming user token, then passes the verified token to `DelegationClient`. The client is constructed with the caller's Keycard credential, discovers the target, exchanges the incoming token for the target Resource, and calls the target. The target verifies the new bearer and returns its verified `sub`, `act`, and `aud`. The caller relays that report.

## Keycard provisioning

1. In a single zone, use the `keycard-sts` credential provider from `GET /zones/<zone-id>/providers`. Do not use the vault provider.
2. Create two Applications via `POST /zones/<zone-id>/applications`, with `consent: "implicit"`: identifiers `a2a-delegation-typescript-caller` and `a2a-delegation-typescript-target`. Record their returned IDs.
3. Create a password credential via `POST /zones/<zone-id>/application-credentials` with the caller's `application_id` and `type: "password"`. Save the returned `identifier` and `password` securely. The target only verifies tokens and needs no application credential.
4. Create two STS-backed Resources via `POST /zones/<zone-id>/resources`. For each agent, use its Application ID as `application_id`, the provider ID as `credential_provider_id`, `application_type: "native"`, and `prefix: true`. Use its base URL as `identifier` without a trailing slash: `http://localhost:9100` for the caller and `http://localhost:9101` for the target by default. Both serve A2A 1.0 over HTTP JSON-RPC at `<base-url>/a2a/jsonrpc`; production endpoints should use HTTPS.
5. Add both Resources as dependencies of the caller Application with `PUT /zones/<zone-id>/applications/<caller-app-id>/dependencies/<resource-id>`, using the returned Resource IDs. The target dependency permits the exchange; the caller dependency allows the test user token to be minted for the caller. The managed default app direct-access policy covers delegation; no custom Cedar policy is needed for the application flow. Impersonation is eval-only and is not needed when using a real user's token.

Use authorized Keycard CLI commands (for example, `keycard agent api -X POST /zones/<zone-id>/applications --org <org-id> -d '<json>'`) or the Console to provision these objects.

## Configuration to write

Copy `.env.example` to `.env` and configure:

- `KEYCARD_URL`: the zone's OAuth issuer URL.
- `KEYCARD_CLIENT_ID` and `KEYCARD_CLIENT_SECRET`: the caller password credential's returned identifier and password, not the caller Application ID.
- `CALLER_BASE_URL` and `TARGET_BASE_URL`: the actual registered Resource identifiers. The target value is also the URL used for discovery and token exchange.
- `CALLER_PORT` and `TARGET_PORT`: optional local listen ports, defaulting to `9100` and `9101`.

In `keycard.toml`, put the selected organization ID under `[org]` and zone ID under `[zone]`, both with key `id`. Leave `[credentials]` empty.

## Verification

```sh
npm ci
npm run build
npm run ci:verify
```

The smoke test starts both agents and checks their health, A2A 1.0 agent cards, registered resource metadata, and bearer challenges for unauthenticated `SendMessage` requests. For nondefault ports or Resource URLs, export the matching `CALLER_PORT`, `TARGET_PORT`, `CALLER_BASE_URL`, and `TARGET_BASE_URL` before running the script.

For the authenticated smoke test, start `npm run start:target` and `npm run start:caller` in separate terminals and send the request in [README.md](./README.md) using a user access token for the caller's Resource. Send the same request directly to the target with that token; expect HTTP 401. Through the caller, expect a report containing the user's identifier as `sub`, the caller Application identifier as `act.sub`, and only the target Resource identifier in `aud`.

Template Eval provisions its own Applications and per-run Resource URLs. In that flow, build the project but do not start either agent or modify the supplied config; the harness supplies the caller's credential at runtime and checks the two-agent flow.

## What the agent must not do

Do not invent resource IDs, commit secrets, disable audience verification, forward the incoming token to the target, or provision the agents in different zones.

## Handoff

Report both agent URLs, both Application identifiers, and how to verify the target's claim report. Do not include any credentials or tokens.
