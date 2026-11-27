# mcp-delegated-access-go

A Keycard-protected MCP server that also brokers **delegated access**: it exchanges the caller's verified token for a resource-scoped token using its own application credential (RFC 8693 token exchange), so the server can act on the user's behalf against a downstream resource.

Built on [`github.com/keycardai/go-sdk`](https://pkg.go.dev/github.com/keycardai/go-sdk), the official [`modelcontextprotocol/go-sdk`](https://github.com/modelcontextprotocol/go-sdk), and Go's standard `net/http` over the Streamable HTTP transport. It extends `mcp-server-go` with a token exchange client and a `/broker` endpoint.

## Run it

```bash
cp -R mcp-delegated-access-go my-mcp-server
cd my-mcp-server
export KEYCARD_URL=https://your-zone.keycard.cloud
# Optional: defaults to http://localhost:<PORT>/mcp, with PORT defaulting to 8000.
# export KEYCARD_RESOURCE_ID=https://mcp.example.com/mcp
# supply the app credential via the environment (do not commit it)
export KEYCARD_CLIENT_ID=... KEYCARD_CLIENT_SECRET=...
go run .
```

The server listens on `http://localhost:8000/mcp`. It validates Keycard-minted JWTs (audience-bound to `KEYCARD_RESOURCE_ID`), and `/broker` performs the delegated token exchange.

## Configure

| Env var | Default | Purpose |
|---|---|---|
| `KEYCARD_URL` | _(required)_ | The zone's OIDC issuer URL. The verifier trusts tokens from it and resolves its JWKS. |
| `KEYCARD_RESOURCE_ID` | `http://localhost:<PORT>/mcp` | This server's registered public `/mcp` URL. It sets the token audience, discovery metadata, and the resource `/broker` exchanges for. |
| `KEYCARD_CLIENT_ID` / `KEYCARD_CLIENT_SECRET` | _(required)_ | The server's application credential, used to authenticate the token exchange. Supply via the environment (`keycard run`), never `.env`. |
| `PORT` | `8000` | Local HTTP port. |

## Endpoints



- `GET /healthz`: unauthenticated liveness.
- `GET /.well-known/oauth-protected-resource/mcp`: protected-resource metadata from the configured binding. The unscoped `/.well-known/oauth-protected-resource` is not served.
- `GET /.well-known/oauth-authorization-server`: proxies the zone's authorization server metadata.
- `POST /mcp`: the MCP endpoint. Tools require bearer auth with the `mcp:tools` scope. A request to `/mcp` without a token returns `401` with the public metadata URL in its `WWW-Authenticate` challenge.
- `GET /broker`: bearer auth, then token exchange scoped to `KEYCARD_RESOURCE_ID`. It reports `brokered: true` on success without returning the token, or `status: "partial_error"` and `brokered: false` if the exchange fails.

With the environment configured and `jq` installed, run `bash scripts/ci-verify.sh` to build, start, and check the server. See [`SPEC.md`](./SPEC.md) for the verification checklist.
## Keycard provisioning

The zone needs an Application (with a client credential) and a Resource for the `/mcp` endpoint, backed by the zone's `keycard-sts` provider. See [`SPEC.md`](./SPEC.md) for the exact primitives an agent should provision.

## Add a tool

Register another tool with `mcp.AddTool(server, &mcp.Tool{...}, handler)` in `main.go`, following the `hello` pattern. To broker a token in a protected HTTP handler, pass the verified caller token and resource to `exchangeClient.ExchangeToken`, as `/broker` does. The server attaches its application credential once using `oauth.WithTokenExchangeCredential` when it constructs the client.
