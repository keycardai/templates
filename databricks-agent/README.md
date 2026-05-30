# databricks-agent

A Keycard-protected MCP server that exposes a single `list_clusters` tool. No static Databricks API key — the user's Keycard bearer token is exchanged for a Databricks-scoped OAuth token via OAuth 2.0 Token Exchange on every tool call.

Exposes one tool:
- **`list_clusters`** — lists all clusters in the configured Databricks workspace (`GET /api/2.0/clusters/list`)

## Prerequisites

- Python 3.10+
- [uv](https://docs.astral.sh/uv/)
- [Keycard CLI](https://docs.keycard.ai/cli/)
- A Keycard zone with an STS provider, a vault provider, and a Databricks OAuth credential provider

## Setup

Follow `SPEC.md` to provision the required Keycard resources (Databricks provider, applications, resources, dependency wiring, vault credentials), or use the `keycard-template-app` skill to do it automatically.

1. **Install dependencies**

   ```bash
   uv sync
   ```

2. **Configure `.env`**

   ```bash
   cp .env.example .env
   # Fill in KEYCARD_URL, PORT, DATABRICKS_HOST (MCP_SERVER_URL defaults to localhost)
   ```

3. **Configure `keycard.toml`**

   Fill in your `[org].id` and `[zone].id`, then append the two `[[credentials.default]]` entries as described in `SPEC.md §2`.

## Run

```bash
keycard run -- uv run python main.py
```

`keycard run` brokers `KEYCARD_CLIENT_ID` and `KEYCARD_CLIENT_SECRET` from the zone vault into the process environment. Running `python main.py` directly (without `keycard run`) will fail token exchange because application credentials cannot be discovered.

## Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `KEYCARD_URL` | _(required)_ | Your zone's OIDC issuer URL (`https://<zone-id>.keycard.cloud`) |
| `MCP_SERVER_URL` | `http://localhost:8000/` | Base URL the MCP client uses to reach this server. Set to a public URL only if you host the server remotely. |
| `PORT` | `8000` | Local HTTP port the server listens on |
| `DATABRICKS_HOST` | `https://<your-workspace>.cloud.databricks.com` | Databricks workspace host the brokered token authenticates against |

`KEYCARD_CLIENT_ID` / `KEYCARD_CLIENT_SECRET` are brokered at runtime by `keycard run` — never put them in `.env`.

## How it works

```
Claude → [Keycard bearer token] → server → [token exchange] → [Databricks token] → Databricks REST API
```

1. Claude authenticates to the server with a Keycard bearer token.
2. When `list_clusters` is called, `@auth_provider.grant(DATABRICKS_HOST)` exchanges that token for a Databricks-scoped OAuth token via the zone's STS.
3. The tool reads the exchanged token from `ctx.get_state("keycardai")` and calls `GET {DATABRICKS_HOST}/api/2.0/clusters/list` with it as a Bearer token.
4. The brokered token is scoped to the call — no Databricks tokens are cached or stored.

## Extending

- **Add more Databricks endpoints** — add tools to `tools/` following the `list_clusters` pattern; reuse `@auth_provider.grant(DATABRICKS_HOST)` and call other `/api/2.x/...` routes.
- **Broker multiple services** — pass a list to `@auth_provider.grant([url1, url2])` and call `access_context.access(url)` per resource.
