# SPEC for mcp-delegated-access-typescript

## Purpose

Serve a Keycard-protected MCP tool that exchanges the signed-in user's bearer token for a downstream token and uses it to call a protected profile API. The MCP Application authenticates each exchange with its own client credential.

## Keycard provisioning

Use an existing zone and its `keycard-sts` credential provider.

1. Register an Application, using a stable identifier such as `mcp-delegated-access-typescript`. Use implicit consent for the local example. Create a password application credential and retain its identifier and password securely.
2. Register a zone-native Resource for Streamable HTTP MCP with identifier `http://localhost:<PORT>/mcp` for local use, or the same public `/mcp` URL clients will use when deployed. Set the MCP Application as its owner (`application_id`), use the STS provider (`credential_provider_id`), and advertise `mcp:tools` in `scopes_supported`.
3. Register a second zone-native Resource for the downstream HTTP API, also backed by STS. Use `http://localhost:<PORT>/profile` for the included API. Use a distinct, exact identifier with prefix matching disabled. Add this Resource as a dependency of the MCP Application with `PUT /zones/<zone-id>/applications/<application-id>/dependencies/<downstream-resource-id>`. Use the downstream Resource's Keycard record ID in this API path.
4. Make the MCP Application available to the intended users under the zone's normal access rules. No custom Cedar policy is required for the exchange with the configured dependency.

## Configuration to write

- Set `KEYCARD_URL` in `.env` to the zone's OAuth issuer.
- Set `KEYCARD_RESOURCE_ID` to the registered MCP identifier, or omit it when that identifier is `http://localhost:<PORT>/mcp`.
- Set `KEYCARD_DOWNSTREAM_URL` to the reachable profile API URL, or omit it for `http://localhost:<PORT>/profile`.
- Set `KEYCARD_DOWNSTREAM_RESOURCE_ID` to the registered downstream identifier when it differs from `KEYCARD_DOWNSTREAM_URL`. The OAuth audience and the network destination may differ, for example when the listener is reached at localhost in eval.
- `PORT` is optional and defaults to `8000`.
- Supply the Application credential identifier as `KEYCARD_CLIENT_ID` and the password as `KEYCARD_CLIENT_SECRET` in the process environment.
- Use the active organization and zone IDs for `[org].id` and `[zone].id` in `keycard.toml`. Leave `[credentials]` empty.

## Verification

Use Node.js 20.19 or later. Run these commands from the template directory with the configuration above and `curl` and `jq` installed.

```sh
npm ci
npm run build
npm run ci:verify
npm start
```

The smoke test expects `/healthz` to return `{"status":"ok"}`, the discovery documents to identify the bound MCP Resource and Keycard issuer, and `/mcp`, `/broker`, and `/profile` to require a bearer token.

Connect an OAuth-capable MCP client to `http://localhost:8000/mcp`, sign in, and call `get_profile` with no arguments. Expect `{"subject":"<signed-in-user-subject>"}` from the downstream API. With the same user access token, check the broker.

```sh
curl -fsS http://localhost:8000/broker \
  -H "Authorization: Bearer $MCP_ACCESS_TOKEN" | jq -e '.brokered == true'
```

## What the agent must not do

Do not commit credentials or expose inbound or exchanged tokens in logs, responses, or the handoff. Use the exact registered identifiers and keep the downstream audience distinct from the MCP audience. Do not send the inbound token to the downstream endpoint.

## Handoff

Share the zone issuer, Application identifier, both Resource identifiers, the MCP connection URL, and the commands to build and start. Tell the user where to supply the application credential without printing it.
