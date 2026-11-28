# mcp-delegated-access-typescript

An Express MCP server whose `get_profile` tool uses Keycard to read a protected HTTP API on behalf of the signed-in user.

`@keycardai/express` verifies the bearer token for `/mcp`. Inside the tool, `@keycardai/mcp` reads that request's verified token and checks its `mcp:tools` scope. The OAuth SDK uses the server's application credential to exchange the user token for a token scoped to the downstream Resource. The tool sends that token to the downstream API, which verifies it and returns the user's subject.

## Run locally

You need Node.js 20.19 or later, npm, a Keycard zone, and an MCP client that supports OAuth and Streamable HTTP.

1. Follow [SPEC.md](./SPEC.md) to provision the Application, credential, and two Resources.
2. Copy `.env.example` to `.env` and fill in the issuer and registered URLs. Supply `KEYCARD_CLIENT_ID` and `KEYCARD_CLIENT_SECRET` through your process environment, for example with `keycard run` or a deployment secret store.
3. Install, build, and start the server.

   ```sh
   npm ci
   npm run build
   npm start
   ```

4. Connect your MCP client to `http://localhost:8000/mcp`, sign in through Keycard, and call `get_profile` with `{}`. The tool returns `{"subject":"<signed-in-user-subject>"}` from the included `GET /profile` API.

`GET /broker` provides an HTTP check for the exchange. Send the same MCP bearer token. A successful response contains `brokered: true`, the downstream resource identifier, and token metadata. The exchanged token stays on the server.

```sh
curl --fail-with-body http://localhost:8000/broker \
  -H "Authorization: Bearer $MCP_ACCESS_TOKEN"
```

With `curl` and `jq` installed, run `npm run ci:verify` after building to check startup, OAuth discovery, and unauthenticated requests. Stop the running server before starting the smoke test.

## Configuration

| Environment variable | Default | Purpose |
| --- | --- | --- |
| `KEYCARD_URL` | Required | Zone issuer URL. |
| `KEYCARD_CLIENT_ID` | Required | Application credential identifier used for token exchange. |
| `KEYCARD_CLIENT_SECRET` | Required | Application credential secret used for token exchange. |
| `PORT` | `8000` | HTTP listener port. |
| `KEYCARD_RESOURCE_ID` | `http://localhost:<PORT>/mcp` | Registered MCP Resource identifier. It binds the verified audience, discovery metadata, and OAuth challenge to the same public `/mcp` URL. |
| `KEYCARD_DOWNSTREAM_URL` | `http://localhost:<PORT>/profile` | HTTP URL called by the tool. The API must return a JSON object with a string `subject`. |
| `KEYCARD_DOWNSTREAM_RESOURCE_ID` | `KEYCARD_DOWNSTREAM_URL` | Registered downstream Resource identifier. Set it when the registered audience differs from the reachable URL. |

When deploying, use the public HTTPS `/mcp` URL for `KEYCARD_RESOURCE_ID`. To use an existing HTTPS API, set its reachable URL and registered identifier as the downstream values. The tool reads both from server configuration and rejects redirects.
