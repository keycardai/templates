# mcp-server-go

A minimal MCP server, integrated with Keycard identity, authentication and authorization, using [`github.com/keycardai/go-sdk`](https://pkg.go.dev/github.com/keycardai/go-sdk), the official [`modelcontextprotocol/go-sdk`](https://github.com/modelcontextprotocol/go-sdk), and Go's standard `net/http` over the Streamable HTTP transport.

This template is a plain Go module. There is no scaffolding step — copy the directory, set `KEYCARD_URL`, and run.

## Run it

```bash
cp -R mcp-server-go my-mcp-server
cd my-mcp-server
export KEYCARD_URL=https://your-zone.keycard.cloud
# Optional: defaults to http://localhost:<PORT>/mcp, with PORT defaulting to 8000.
# export KEYCARD_RESOURCE_ID=https://mcp.example.com/mcp
go run .
```

The server listens on `http://localhost:8000/mcp` and validates Keycard-minted JWTs against `KEYCARD_URL` and `KEYCARD_RESOURCE_ID`.

## Configure

| Env var | Default | Purpose |
|---|---|---|
| `KEYCARD_URL` | _(required)_ | The zone's OIDC issuer URL. The verifier trusts tokens from it and resolves its JWKS. |
| `KEYCARD_RESOURCE_ID` | `http://localhost:<PORT>/mcp` | This server's registered public `/mcp` URL. It sets the token audience and discovery metadata. |
| `PORT` | `8000` | Local HTTP port. |

## Endpoints


- `GET /healthz`: unauthenticated liveness.
- `GET /.well-known/oauth-protected-resource/mcp`: protected-resource metadata from the configured binding. The unscoped `/.well-known/oauth-protected-resource` is not served.
- `GET /.well-known/oauth-authorization-server`: proxies the zone's authorization server metadata.
- `POST /mcp`: the MCP endpoint. Tools require bearer auth with the `mcp:tools` scope. A request to `/mcp` without a token returns `401` with the public metadata URL in its `WWW-Authenticate` challenge.

With the environment configured and `jq` installed, run `bash scripts/ci-verify.sh` to build, start, and check the server. See [`SPEC.md`](./SPEC.md) for the verification checklist.
## Keycard provisioning

Before the server can accept requests, the zone needs an Application and a Resource for the `/mcp` endpoint, backed by the zone's `keycard-sts` provider. See [`SPEC.md`](./SPEC.md) for the exact primitives an agent should provision.

## Add a tool

Register another tool with `mcp.AddTool(server, &mcp.Tool{...}, handler)` in `main.go`, following the `hello` pattern. Tools are gated by the `mcp:tools` scope the bearer middleware enforces.
