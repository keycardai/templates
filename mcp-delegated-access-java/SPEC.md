# SPEC: mcp-delegated-access-java

## Purpose

A Keycard-protected Java MCP server that exchanges a signed-in user's verified token for a Resource-scoped token using the server's own application credential.

## Keycard provisioning

Use the active Keycard org and zone. Select the zone's `keycard-sts` credential provider and carry forward its ID. Create or reuse an Application with the project name as both `name` and stable `identifier` and with `consent: "implicit"` for local development.

Create an MCP Resource with the Streamable HTTP endpoint URL as its `identifier` (by default `http://localhost:8000/mcp`). Set `scopes` to `["mcp:tools"]`, `application_id` to the Application's ID, and `credential_provider_id` to the zone provider's ID. The Application provides the Resource and exchanges for that same Resource. No separate dependency or custom Cedar policy is needed.

Create a password credential for the Application. With the Keycard CLI, use `keycard agent api -X POST /zones/<zone-id>/application-credentials --org <org-id> -d '{"application_id":"<application-id>","type":"password"}'`. The returned `identifier` and `password` are the client ID and secret.

## Configuration to write

Write `KEYCARD_URL` in `.env` using the zone's OIDC issuer URL. Set `KEYCARD_RESOURCE_ID` to the registered Resource URL. If omitted or blank it defaults to `http://localhost:<PORT>/mcp`. `PORT` defaults to `8000`.

Supply the Application credentials as `KEYCARD_CLIENT_ID` and `KEYCARD_CLIENT_SECRET` via the process environment from the deployment's secret store. Put the existing org and zone IDs under `[org]` and `[zone]` in `keycard.toml` and leave `[credentials]` empty. Java reads these runtime settings from the process environment.

## Verification

Use JDK 17 or newer. From the template directory, load the non-secret configuration and inject the credentials, then build and run the smoke checks.

```bash
set -a
source .env
set +a
./gradlew installDist
bash scripts/ci-verify.sh
```

The script starts `./build/install/mcp-delegated-access-java/bin/mcp-delegated-access-java`, checks `GET /healthz` and the protected-resource and authorization-server metadata, and checks that unauthenticated `POST /mcp` and `GET /broker` return 401 with Bearer challenges. With a user token for `KEYCARD_RESOURCE_ID` carrying `mcp:tools`, `GET /broker` returns `brokered: true` after a successful exchange. The response contains only the outcome and token metadata.

## What the agent must not do

Do not commit secrets, invent identifiers, select a vault provider, or put credentials or runtime configuration in `keycard.toml`. Do not put a token in the broker response.

## Handoff

Give the user the org, zone, Application and Resource identifiers, issuer URL, MCP URL and broker URL. Provide the installDist start command and the instructions for injecting credentials without including credential values.
