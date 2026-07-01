# mcp-delegated-access-go

A Keycard-protected MCP server that also brokers **delegated access**: it exchanges the caller's verified token for a resource-scoped token using its own application credential (RFC 8693 token exchange), so the server can act on the user's behalf against a downstream resource.

Built on [`github.com/keycardai/credentials-go`](https://pkg.go.dev/github.com/keycardai/credentials-go), the official [`modelcontextprotocol/go-sdk`](https://github.com/modelcontextprotocol/go-sdk), and Go's standard `net/http` over the Streamable HTTP transport. It extends `mcp-server-go` with an `AuthProvider` and a `/broker` endpoint.

## Run it

```bash
cp -R mcp-delegated-access-go my-mcp-server
cd my-mcp-server
export KEYCARD_URL=https://your-zone.keycard.cloud
export KEYCARD_RESOURCE_ID=http://localhost:8000/mcp
# supply the app credential via the environment (do not commit it)
export KEYCARD_CLIENT_ID=... KEYCARD_CLIENT_SECRET=...
go run .
```

The server listens on `http://localhost:8000/mcp`. It validates Keycard-minted JWTs (audience-bound to `KEYCARD_RESOURCE_ID`), and `/broker` performs the delegated token exchange.

## Configure

| Env var | Default | Purpose |
|---|---|---|
| `KEYCARD_URL` | _(required)_ | The zone's OIDC issuer URL. The verifier trusts tokens from it and resolves its JWKS. |
| `KEYCARD_RESOURCE_ID` | _(required)_ | This server's registered resource (the `/mcp` URL). The token audience, and the resource `/broker` exchanges for. |
| `KEYCARD_CLIENT_ID` / `KEYCARD_CLIENT_SECRET` | _(required)_ | The server's application credential, used to authenticate the token exchange. Supply via the environment (`keycard run`), never `.env`. |
| `PORT` | `8000` | Local HTTP port. |

## Endpoints

- `GET /healthz` — unauthenticated liveness.
- `/.well-known/oauth-protected-resource`, `/.well-known/oauth-authorization-server` — OAuth metadata for client discovery.
- `POST /mcp` — the MCP endpoint (bearer auth, scope `mcp:tools`); exposes the `hello` tool.
- `GET /broker` — bearer auth, then exchanges the caller's token for a token scoped to `KEYCARD_RESOURCE_ID` and returns the brokered result (`brokered: true` on success).

## Keycard provisioning

The zone needs an Application (with a client credential) and a Resource for the `/mcp` endpoint, backed by the zone's `keycard-sts` provider. See [`SPEC.md`](./SPEC.md) for the exact primitives an agent should provision.

## Add a tool

Register another tool with `mcp.AddTool(server, &mcp.Tool{...}, handler)` in `main.go`, following the `hello` pattern. To broker a token inside a plain HTTP handler, wrap it with `authProvider.Grant([]string{resource})` and read the result with `keycardmcp.AccessContextFromRequest(r)`, as `/broker` does.
