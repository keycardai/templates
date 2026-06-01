# databricks-agent

A Keycard-protected MCP server exposing scope-gated tools across two Databricks branches — **SQL Warehouse** and **Genie** — plus `list_clusters`. No static Databricks API key: the user's Keycard bearer token is exchanged for a Databricks-scoped OAuth token via OAuth 2.0 Token Exchange on every tool call.

The server enforces authorization in one of two ways, toggled by the `ENFORCE_TOOL_SCOPES` env flag:

- **`ENFORCE_TOOL_SCOPES=true` — scope-at-issuance + server verification.** The client requests specific per-tool scopes. Keycard's PDP issues only the scopes the user's Cedar policy permits, and each tool verifies its required scope before running (returns `insufficient_scope` otherwise).
- **`ENFORCE_TOOL_SCOPES=false` — policy-at-exchange / delegation.** The client requests no scopes and the server-side check is bypassed. Authorization happens at token-exchange time: Keycard's delegation policy permits the on-behalf exchange only when the Databricks resource is wired as a dependency of this application.

## Tools and scopes

Each tool requires exactly one scope.

| Tool | Databricks endpoint | Scope |
|---|---|---|
| `list_clusters` | `GET /api/2.0/clusters/list` | `databricks:clusters:read` |
| `list_warehouses` | `GET /api/2.0/sql/warehouses` | `databricks:sql:warehouses:read` |
| `execute_statement` | `POST /api/2.0/sql/statements` | `databricks:sql:execute` |
| `get_statement` | `GET /api/2.0/sql/statements/{id}` | `databricks:sql:read` |
| `list_genie_spaces` | `GET /api/2.0/genie/spaces` | `databricks:genie:spaces:read` |
| `start_genie_conversation` | `POST /api/2.0/genie/spaces/{id}/start-conversation` | `databricks:genie:converse` |
| `get_genie_message` | `GET /api/2.0/genie/spaces/{id}/conversations/{cid}/messages/{mid}` | `databricks:genie:read` |
| `get_genie_query_result` | `GET .../messages/{mid}/attachments/{aid}/query-result` | `databricks:genie:read` |

The SQL and Genie APIs are asynchronous: `execute_statement` returns inline for small queries (within `wait_timeout`, default 30s) or a `statement_id` to poll with `get_statement`; `start_genie_conversation` returns `conversation_id` + `message_id` to poll with `get_genie_message`, then `get_genie_query_result` fetches the SQL behind an answer.

## Prerequisites

- Python 3.10+
- [uv](https://docs.astral.sh/uv/)
- [Keycard CLI](https://docs.keycard.ai/cli/)
- A Keycard zone with an STS provider, a vault provider, and a Databricks OAuth credential provider

## Setup

Follow `SPEC.md` to provision the required Keycard resources (Databricks provider, applications, resources, dependency wiring, vault credentials, and the Cedar policy set for both authorization modes), or use the `keycard-template-app` skill to do it automatically.

1. **Install dependencies**

   ```bash
   uv sync
   ```

2. **Configure `.env`**

   ```bash
   cp .env.example .env
   # Fill in KEYCARD_URL, MCP_SERVER_URL, PORT, DATABRICKS_HOST, ENFORCE_TOOL_SCOPES
   # and optionally DATABRICKS_WAREHOUSE_ID / DATABRICKS_GENIE_SPACE_ID
   ```

3. **Configure `keycard.toml`**

   Fill in your `[org].id` and `[zone].id`, then append the two `[[credentials.default]]` entries as described in `SPEC.md §2`.

## Run

```bash
keycard run -- uv run python main.py
```

`keycard run` brokers `KEYCARD_CLIENT_ID` and `KEYCARD_CLIENT_SECRET` from the zone vault into the process environment. Running `python main.py` directly will fail token exchange because application credentials cannot be discovered.

## Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `KEYCARD_URL` | _(required)_ | Your zone's OIDC issuer URL (`https://<zone-id>.keycard.cloud`) |
| `MCP_SERVER_URL` | `http://localhost:8000/` | Base URL the MCP client uses to reach this server. Must end with a trailing slash. |
| `PORT` | `8000` | Local HTTP port the server listens on |
| `DATABRICKS_HOST` | `https://<your-workspace>.cloud.databricks.com` | Databricks workspace host **only** (no API path); each tool appends its own route |
| `ENFORCE_TOOL_SCOPES` | `true` | `true` = the server verifies per-tool scopes; `false` = the delegation policy authorizes the exchange instead |
| `DATABRICKS_WAREHOUSE_ID` | _(unset)_ | Optional default warehouse for `execute_statement` |
| `DATABRICKS_GENIE_SPACE_ID` | _(unset)_ | Optional default Genie space for the Genie tools |

`KEYCARD_CLIENT_ID` / `KEYCARD_CLIENT_SECRET` are brokered at runtime by `keycard run` — never put them in `.env`.

## How it works

```
Client → [Keycard bearer token] → server → [token exchange] → [Databricks token] → Databricks REST API
```

1. The client authenticates to the server with a Keycard bearer token.
2. When `ENFORCE_TOOL_SCOPES=true`, `@require_scope` checks the token carries the tool's scope before anything else.
3. `@auth_provider.grant(DATABRICKS_HOST)` exchanges the caller token for a Databricks-scoped OAuth token via the zone's STS. When `ENFORCE_TOOL_SCOPES=false`, Keycard's delegation policy authorizes (or denies) this exchange based on the app's dependency on the Databricks resource.
4. The tool reads the exchanged token from `ctx.get_state("keycardai")` and calls the Databricks REST endpoint with it as a Bearer token.
5. The brokered token is scoped to the call — no Databricks tokens are cached or stored.

## Demo

Use the [`mcp-client-python`](../mcp-client-python/) client, which can request specific scopes during the OAuth authorize.

**With scope enforcement on** (`ENFORCE_TOOL_SCOPES=true`):

```bash
# Permitted SQL scopes → tool runs
mcp-client --server-url http://localhost:8000/mcp \
           --scopes databricks:sql:execute \
           --tool execute_statement --tool-args '{"statement": "SELECT 1"}'

# Genie scope not permitted by the demo policy → stripped at issuance → insufficient_scope
mcp-client --server-url http://localhost:8000/mcp \
           --scopes databricks:genie:converse \
           --tool start_genie_conversation --tool-args '{"content": "top sales"}'

# Request only read → execute_statement blocked at the tool (needs databricks:sql:execute)
mcp-client --server-url http://localhost:8000/mcp \
           --scopes databricks:sql:read \
           --tool execute_statement --tool-args '{"statement": "SELECT 1"}'
```

**With scope enforcement off** (`ENFORCE_TOOL_SCOPES=false`, restart the server):

```bash
# No scopes requested. Exchange is authorized while the Databricks dependency exists.
mcp-client --server-url http://localhost:8000/mcp \
           --tool list_warehouses
# Remove the Databricks dependency from the app → the same call returns a token-exchange error.
```

## Extending

- **Add more Databricks endpoints** — add tools to `tools/` modeled on the SQL/Genie tools; reuse `@require_scope(...)` + `@auth_provider.grant(DATABRICKS_HOST)` and call other `/api/2.x/...` routes.
- **Add a scope** — define it in `tools/scope.py` (`SUPPORTED_SCOPES`), tag the tool with `@require_scope(...)`, and grant it to users via a Cedar permit (see `SPEC.md §1h`).
