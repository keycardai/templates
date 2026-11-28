# SPEC: a2a-delegation-java

## Purpose

A Java A2A 1.0 caller that delegates a message on behalf of a verified user, and a target that shows the verified subject, actor chain and audience from the exchanged token.

## Keycard provisioning

Use the active Keycard org and zone. Select the zone's `keycard-sts` credential provider. Create or reuse the `<name>-caller` and `<name>-target` Applications, using those names as their stable identifiers and `consent: "implicit"` for local development.

For each Application, create a Resource with `application_id` set to that Application ID, `credential_provider_id` set to the zone provider ID, and `identifier` set to the agent's HTTP(S) base URL without a trailing slash or path. Use `http://localhost:9100` for the caller and `http://localhost:9101` for the target by default. The agents speak A2A 1.0 JSON-RPC at `/a2a/jsonrpc`, which is the card's interface URL suffix.

Create a password credential for the caller using `keycard agent api -X POST /zones/<zone-id>/application-credentials --org <org-id> -d '{"application_id":"<caller-app-id>","type":"password"}'`. The returned `identifier` and `password` are the caller's client ID and secret. The target verifies tokens without an application credential.

Add the target Resource as a dependency of the caller Application using `keycard agent api -X PUT /zones/<zone-id>/applications/<caller-app-id>/dependencies/<target-resource-id> --org <org-id>`. This lets the caller exchange a user token for the target Resource. No custom Cedar policy is needed for the regular user token flow.

## Configuration to write

Write the zone's OIDC issuer URL as `KEYCARD_URL` in `.env`. Set `CALLER_BASE_URL` and `TARGET_BASE_URL` to the exact registered Resource identifiers. Export these values before starting the agents. Supply `KEYCARD_CLIENT_ID` and `KEYCARD_CLIENT_SECRET` to the caller process from the secret store. Set `PORT` per process if overriding the caller's default of `9100` or the target's default of `9101`.

Put the existing org and zone IDs under `[org]` and `[zone]` in `keycard.toml` and leave `[credentials]` empty.

## Verification

Use JDK 17 or newer. From the template directory, load the configuration and inject the caller credentials before verifying.

```bash
set -a
source .env
set +a
./gradlew installDist
PORT=9100 bash scripts/ci-verify.sh
```

The script starts `./build/install/a2a-delegation-java/bin/a2a-delegation-java` with roles `caller` and `target` on `PORT` and `PORT + 1`. If provisioned on different local ports, use the first of the two consecutive ports for the script. It checks `GET /healthz`, the A2A 1.0 JSONRPC interface and bearer authentication requirement at `/.well-known/agent-card.json`, OAuth metadata, and 401 Bearer challenges from unauthenticated `POST /a2a/jsonrpc` on both agents.

For authenticated verification, start the two roles and use the `SendMessage` command in [README.md](./README.md) with a user token for the caller. The target's report must have `sub` equal to the user, `act.sub` equal to the caller's Application identifier, and `aud` containing only `TARGET_BASE_URL`. Send the same request directly to the target with the same token to verify it returns 401 with `error="invalid_token"`.

## What the agent must not do

Do not commit secrets, invent identifiers, register the Applications in different zones, or put runtime configuration in `keycard.toml`. Do not forward the original user token to the target or configure either verifier without its own audience.

## Handoff

Give the user both base URLs and agent card URLs, the org and zone IDs, and both Application and Resource identifiers. Provide the start commands and the expected `sub`, `act` and `aud` report, without credential values.
