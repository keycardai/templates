# SPEC: mcp-server-java-spring-ai

## Purpose

A Keycard-protected Spring AI MCP server whose `hello` tool runs after Spring Security authenticates the user and checks the token's `mcp:tools` scope.

## Keycard provisioning

Use the active Keycard org and zone. Select the zone's `keycard-sts` credential provider. Create or reuse an Application with the project name as both `name` and stable `identifier` and with `consent: "implicit"` for local development.

Create an MCP Resource with the Streamable HTTP endpoint URL as its `identifier` (by default `http://localhost:8000/mcp`). Set `scopes` to `["mcp:tools"]`, `application_id` to the Application's ID, and `credential_provider_id` to the zone provider's ID. The Application provides the Resource. No application credential, dependency or custom Cedar policy is needed.

## Configuration to write

Write `KEYCARD_URL` in `.env` using the zone's OIDC issuer URL. Set `KEYCARD_RESOURCE_ID` to the registered Resource URL. If omitted or blank it defaults to `http://localhost:<PORT>/mcp`. `PORT` defaults to `8000`. Export the file's values before startup.

Put the existing org and zone IDs under `[org]` and `[zone]` in `keycard.toml` and leave `[credentials]` empty.

## Verification

Use JDK 17 or newer. From the template directory, load the configuration, build and run the smoke checks.

```bash
set -a
source .env
set +a
./gradlew installDist
bash scripts/ci-verify.sh
```

The script starts `./build/install/mcp-server-java-spring-ai/bin/mcp-server-java-spring-ai`. It verifies that `GET /healthz` returns 200, `GET /.well-known/oauth-protected-resource/mcp` names the registered Resource, and `GET /.well-known/oauth-authorization-server` returns the zone's OAuth metadata. An unauthenticated `POST /mcp` returns 401 with a Bearer challenge containing the protected-resource metadata URL. A user with a token for the Resource and scope `mcp:tools` can call `hello` with `{"name":"Ada"}` to receive `Hello, Ada!`.

## What the agent must not do

Do not commit secrets, invent identifiers, select a vault provider, or put runtime configuration in `keycard.toml`.

## Handoff

Give the user the org, zone, Application and Resource identifiers, issuer URL and MCP URL. Include the command to start the installed server and how to call the tool with a Keycard-authorized MCP client.
