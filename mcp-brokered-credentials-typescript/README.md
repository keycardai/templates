# mcp-brokered-credentials-typescript

A small MCP **proxy** server that demonstrates Keycard as a credential broker. It exposes two tools — `search` and `execute` — that fan out to the official [Linear MCP server](https://linear.app/docs/mcp) at `https://mcp.linear.app/mcp`. The user's bearer token is exchanged (RFC 8693) for a Linear-scoped token on every call; no static Linear credentials live in the proxy.

It also demonstrates **vault-brokered application credentials**: the proxy's own Keycard `client_id` / `client_secret` are stored as zone-vault resources and injected into the process by `keycard run`, never written to disk.

Built on [`@keycardai/mcp`](https://www.npmjs.com/package/@keycardai/mcp), the official `@modelcontextprotocol/sdk`, and Express 5 over the Streamable HTTP transport.

## How it works

```
   Claude / Cursor
        │  user bearer token (mcp:tools)
        ▼
   ┌──────────────────────────────────────┐
   │  this proxy (Express + MCP SDK)      │
   │  tools: search, execute              │
   │                                      │
   │  AuthProvider.exchangeTokens(        │
   │    subjectToken,                     │
   │    "https://mcp.linear.app/mcp")     │
   └──────────────────────────────────────┘
        │  brokered Linear token
        ▼
   https://mcp.linear.app/mcp  (upstream)
```

The proxy authenticates to Keycard's STS using its own application `client_id` / `client_secret`. Those credentials are stored in **zone-vault resources** (`urn:<name>:client_id`, `urn:<name>:client_secret`) and brokered into the process at runtime by `keycard run`.

## Tools

| Tool | What it does |
|---|---|
| `search` | Lists upstream Linear tools whose name or description matches a JS regex (case-insensitive). Returns name, description, and inputSchema. |
| `execute` | Calls a named tool on the upstream Linear MCP server with the supplied arguments. Use `search` first to find the name + schema. |

## Run it

This template only runs through `keycard run`, which hydrates `KEYCARD_CLIENT_ID` and `KEYCARD_CLIENT_SECRET` from the zone vault.

```bash
cp -R mcp-brokered-credentials-typescript my-mcp-proxy
cd my-mcp-proxy
cp .env.example .env   # then edit KEYCARD_URL
npm install
npm run build
keycard run -- npm start
```

`keycard run` reads the project's `keycard.toml` to authenticate against your zone and to broker `KEYCARD_CLIENT_ID` / `KEYCARD_CLIENT_SECRET` from the zone vault into the process. The shipped file is minimal — `[org].id`, `[zone].id`, plus two `[[credentials.default]]` blocks the scaffold step appends after creating the vault resources. The MCP server itself reads runtime config (`KEYCARD_URL`, `PORT`) from `.env`.

The proxy listens on `http://localhost:8000/mcp`. Without `keycard run`, the process exits at startup with a message pointing at the missing env vars — that is by design.

## Configure

| Env var | Default | Where it comes from |
|---|---|---|
| `KEYCARD_URL` | _(required)_ | `.env` (or your shell). |
| `KEYCARD_CLIENT_ID` | _(required)_ | Brokered by `keycard run` from `urn:<name>:client_id`. |
| `KEYCARD_CLIENT_SECRET` | _(required)_ | Brokered by `keycard run` from `urn:<name>:client_secret`. |
| `KEYCARD_RESOURCE_ID` | `mcp-brokered-credentials-typescript` | Keycard Resource id used by the middleware. |
| `PORT` | `8000` | Local HTTP port. |

> Putting `KEYCARD_CLIENT_ID` or `KEYCARD_CLIENT_SECRET` in `.env` defeats the point of this template. Leave them out — let `keycard run` broker them.

## Keycard provisioning

Before the proxy can accept requests, Keycard needs:

1. A Linear provider, application, and resource (so the user can consent to Linear at OAuth time and so the STS knows what to exchange tokens for).
2. A proxy application + resource registered against the STS provider, with the Linear resource as a **dependency**.
3. Application credentials for the proxy, copied into two zone-vault resources (`urn:<name>:client_id`, `urn:<name>:client_secret`).

Step 3 is handled by [`scripts/provision-credentials.sh`](./scripts/provision-credentials.sh) — a bash script that issues credentials and pipes them into vault resources in a single shell process. The secret material never appears in agent chat memory or on disk.

[`SPEC.md`](./SPEC.md) lays out the exact API calls, identifiers, and ordering. The `keycard-template-app` skill follows it end-to-end.

## Add a tool

The `search` / `execute` pair is enough to expose any upstream MCP server. To add another upstream:

- Create a Keycard provider + application + resource for the new upstream.
- Add the new resource as a `dependency` of this proxy's resource.
- Add a new file in `src/tools/` that calls `withLinearClient`-style with a different resource URI, or generalise `src/upstream.ts` to take a target URL.
- Register the tool from `src/server.ts`.

Per-tool authorization (e.g. blocking `execute` for `delete_*` tool names) is out of scope for v1 of this template — the gate is OAuth scope (`mcp:tools`).
