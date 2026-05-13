# mcp-server-typescript-express

A minimal MCP server, integrated with Keycard identity, authentication and authorization, using [`@keycardai/mcp`](https://www.npmjs.com/package/@keycardai/mcp), the official `@modelcontextprotocol/sdk`, and Express 5 over the Streamable HTTP transport.

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
| `KEYCARD_RESOURCE_ID` | `mcp-server-typescript-express` | Keycard Resource id used by the middleware. |
| `PORT` | `8000` | Local HTTP port. |

## Keycard provisioning

Before the server can accept requests, the Keycard needs a Resource and a policy that lets your principal call the `hello` tool. See [`SPEC.md`](./SPEC.md) for the exact resources and policy shape the agent should provision.

## Add a tool

Drop a new file in `src/tools/` and register it from `src/server.ts`. Tools added here are automatically gated by your Keycard policy — see the `keycard-upsert-policy` skill for editing rules.
