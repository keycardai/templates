# mcp-server-typescript-express

A minimal MCP server, integrated with Keycard identity, authentication and authorization, using [`@keycardai/mcp`](https://www.npmjs.com/package/@keycardai/mcp), the official MCP v2 SDK (`@modelcontextprotocol/server`), and Express 5 over the Streamable HTTP transport.

This template is a plain Node project. There is no scaffolding step — copy the directory, install, and run.

## Run it

```bash
cp -R mcp-server-typescript-express my-mcp-server
cd my-mcp-server
npm install
export KEYCARD_URL=https://your-url.keycard.cloud
npm run build
npm run start
```

The server listens on `http://localhost:8000/mcp` and registers itself against keycard at `KEYCARD_URL`.

## Develop

```bash
npm run dev
```

## Configure

| Env var | Default | Purpose |
|---|---|---|
| `KEYCARD_URL` | _(required)_ | URL the server registers against. |
| `KEYCARD_RESOURCE_ID` | `http://localhost:$PORT/mcp` | The exact registered HTTP(S) Resource URL. Its path is the MCP route, and only tokens with this audience are accepted. |

The server uses `@keycardai/express` to publish protected-resource metadata and issue bearer challenges for the same Resource. With the default URL, `GET /.well-known/oauth-protected-resource/mcp` returns the metadata, and an unauthenticated `POST /mcp` returns HTTP 401 with `WWW-Authenticate: Bearer resource_metadata="http://localhost:8000/.well-known/oauth-protected-resource/mcp"`. If you set a different public Resource URL, connect to that exact path and query. `GET /.well-known/oauth-authorization-server` still serves zone discovery.

To verify discovery and the challenge without an MCP token, export `KEYCARD_URL` and any port or Resource overrides, then run `npm run build && npm run ci:verify`.
| `PORT` | `8000` | Local HTTP port. |

## Keycard provisioning

Before the server can accept requests, the Keycard needs a Resource and a policy that lets your principal call the `hello` tool. See [`SPEC.md`](./SPEC.md) for the exact resources and policy shape the agent should provision.

## Add a tool

Drop a new file in `src/tools/` and register it from `src/server.ts`. Tools added here are automatically gated by your Keycard policy — see the `keycard-upsert-policy` skill for editing rules.
