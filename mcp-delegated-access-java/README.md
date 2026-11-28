# mcp-delegated-access-java

A Keycard-protected MCP server with a `hello` tool and a delegated-access broker. Jetty hosts the MCP Java SDK's Streamable HTTP transport. The broker uses a Keycard grant to exchange the caller's verified token for one scoped to the server's Resource.

## Run locally

Use JDK 17 or newer, `curl`, and `jq`. Follow [SPEC.md](./SPEC.md) to provision Keycard.

```bash
cp .env.example .env
# Edit .env for your Keycard zone and Resource.
set -a
source .env
set +a
# Inject KEYCARD_CLIENT_ID and KEYCARD_CLIENT_SECRET from your secret store.
./gradlew installDist
./build/install/mcp-delegated-access-java/bin/mcp-delegated-access-java
```

Connect a Keycard-authorized MCP client to `http://localhost:8000/mcp` and call `hello` with `{"name":"Ada"}`. The tool returns `Hello, Ada!`. With the same user access token in your environment, try the broker.

```bash
curl -fsS -H "Authorization: Bearer $USER_ACCESS_TOKEN" http://localhost:8000/broker
```

On success the JSON contains `status: "success"`, `brokered: true`, `resource`, `token_type` and `expires_in`. A failed exchange returns `brokered: false` and a status of `partial_error`. The exchanged token stays on the server.

## Configuration

| Env var | Default | Purpose |
|---|---|---|
| `KEYCARD_URL` | Required | Zone OIDC issuer URL. |
| `KEYCARD_RESOURCE_ID` | `http://localhost:<PORT>/mcp` | Registered MCP Resource URL, token audience and exchange target. |
| `KEYCARD_CLIENT_ID` | Required | Server application's OAuth client ID. |
| `KEYCARD_CLIENT_SECRET` | Required | Server application's OAuth client secret. |
| `PORT` | `8000` | HTTP listen port. |
