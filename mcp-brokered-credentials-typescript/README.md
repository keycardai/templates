# mcp-brokered-credentials-typescript

A small MCP **proxy** server that demonstrates Keycard as a credential broker. It exposes two tools — `search` and `execute` — that fan out to the official [Linear MCP server](https://linear.app/docs/mcp) at `https://mcp.linear.app/mcp`. The user's bearer token is exchanged (RFC 8693) for a Linear-scoped token on every call; no static Linear credentials live in the proxy.

It also demonstrates **vault-brokered application credentials**: the proxy's own Keycard `client_id` / `client_secret` are stored as zone-vault resources and injected into the process by `keycard run`, never written to disk. When deployed to a cloud platform (Fly.io, EKS), the proxy automatically discovers workload-identity credentials from the environment instead — no static secrets needed.

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

The proxy authenticates to Keycard's STS using application credentials discovered at startup. Locally, those are `client_id` / `client_secret` stored in **zone-vault resources** (`urn:<name>:client_id`, `urn:<name>:client_secret`) and brokered into the process at runtime by `keycard run`. On cloud platforms (Fly.io, EKS), the proxy uses the platform's native workload-identity token instead.

## Tools

| Tool | What it does |
|---|---|
| `search` | Lists upstream Linear tools whose name or description matches a JS regex (case-insensitive). Returns name, description, and inputSchema. |
| `execute` | Calls a named tool on the upstream Linear MCP server with the supplied arguments. Use `search` first to find the name + schema. |

## Run it

### Locally (via `keycard run`)

```bash
cp -R mcp-brokered-credentials-typescript my-mcp-proxy
cd my-mcp-proxy
cp .env.example .env   # then edit KEYCARD_URL
npm install
npm run build
keycard run -- npm start
```

`keycard run` reads the project's `keycard.toml` to authenticate against your zone and to broker `KEYCARD_CLIENT_ID` / `KEYCARD_CLIENT_SECRET` from the zone vault into the process. The shipped file is minimal — `[org].id`, `[zone].id`, plus two `[[credentials.default]]` blocks the scaffold step appends after creating the vault resources. The MCP server itself reads runtime config (`KEYCARD_URL`, `PORT`) from `.env`.

The proxy listens on `http://localhost:8000/mcp`.

### On a cloud platform

Set `KEYCARD_URL` and `PORT` in the platform's env config. The proxy discovers workload-identity credentials from the environment automatically — no `keycard run` wrapper needed. See [Deploying](#deploying) for platform-specific details.

## Configure

| Env var | Default | Where it comes from |
|---|---|---|
| `KEYCARD_URL` | _(required)_ | `.env` (or your shell). |
| `KEYCARD_CLIENT_ID` | _(auto-discovered)_ | Brokered by `keycard run` from `urn:<name>:client_id`. |
| `KEYCARD_CLIENT_SECRET` | _(auto-discovered)_ | Brokered by `keycard run` from `urn:<name>:client_secret`. |
| `KEYCARD_APPLICATION_CREDENTIAL_TYPE` | _(auto-discovered)_ | Force a specific credential provider: `eks_workload_identity`, `fly_workload_identity`, or `web_identity`. |
| `KEYCARD_RESOURCE_ID` | `mcp-brokered-credentials-typescript` | Keycard Resource id used by the middleware. |
| `PORT` | `8000` | Local HTTP port. |

The proxy discovers credentials automatically at startup (see [`SPEC.md` §3](./SPEC.md#3-runtime-credential-discovery) for the full priority order). Locally, `keycard run` injects `KEYCARD_CLIENT_ID` / `KEYCARD_CLIENT_SECRET`. On Fly.io or EKS the proxy detects the platform and uses its workload-identity token — no static secrets needed.

## Deploying

### Fly.io

Use the `keycard-deploy-app` skill:

```bash
/keycard-deploy-app fly . <fly-org-slug>
```

The deploy procedure registers a Fly OIDC provider in Keycard and creates an application-credential binding (subject `<fly-org>:<project-name>:*`). At runtime the proxy detects `FLY_APP_NAME` in the environment, fetches a machine OIDC token from Fly's internal metadata endpoint, and uses it as a client assertion for token exchange. No `KEYCARD_CLIENT_ID` / `KEYCARD_CLIENT_SECRET` env vars or Fly secrets are required.

### EKS

Deploy normally with the pod's service account wired to provide a workload-identity token file. The proxy detects `AWS_WEB_IDENTITY_TOKEN_FILE` (or `AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE`) and uses `EKSWorkloadIdentity` automatically. An application-credential binding matching the EKS OIDC provider must exist in Keycard.

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
