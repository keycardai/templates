# mcp-server-go

A minimal MCP server, integrated with Keycard identity, authentication and authorization, using [`github.com/keycardai/credentials-go`](https://pkg.go.dev/github.com/keycardai/credentials-go), the official [`modelcontextprotocol/go-sdk`](https://github.com/modelcontextprotocol/go-sdk), and Go's standard `net/http` over the Streamable HTTP transport.

This template is a plain Go module. There is no scaffolding step — copy the directory, set `KEYCARD_URL`, and run.

## Run it

```bash
cp -R mcp-server-go my-mcp-server
cd my-mcp-server
export KEYCARD_URL=https://your-zone.keycard.cloud
go run .
```

The server listens on `http://localhost:8000/mcp` and validates Keycard-minted JWTs against `KEYCARD_URL`.

## Configure

| Env var | Default | Purpose |
|---|---|---|
| `KEYCARD_URL` | _(required)_ | The zone's OIDC issuer URL. The verifier trusts tokens from it and resolves its JWKS. |
| `PORT` | `8000` | Local HTTP port. |

## Keycard provisioning

Before the server can accept requests, the zone needs an Application and a Resource for the `/mcp` endpoint, backed by the zone's `keycard-sts` provider. See [`SPEC.md`](./SPEC.md) for the exact primitives an agent should provision.

## Add a tool

Register another tool with `mcp.AddTool(server, &mcp.Tool{...}, handler)` in `main.go`, following the `hello` pattern. Tools are gated by the `mcp:tools` scope the bearer middleware enforces.
