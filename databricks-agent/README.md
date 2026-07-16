# databricks-agent

A Keycard-protected MCP server exposing scope-gated tools across two Databricks branches — **SQL Warehouse** and **Genie** — plus `list_clusters`. No static Databricks API key: the user's Keycard bearer token is exchanged for a Databricks-scoped OAuth token via OAuth 2.0 Token Exchange on every tool call.

The server enforces authorization in one of two ways, toggled by the `ENFORCE_TOOL_SCOPES` env flag:

- **`ENFORCE_TOOL_SCOPES=true` — scope-at-issuance + server verification.** The client requests specific per-tool scopes. Keycard's PDP issues only the scopes the user's Cedar policy permits, and each tool verifies its required scope before running (returns `insufficient_scope` otherwise).
- **`ENFORCE_TOOL_SCOPES=false` — policy-at-exchange / delegation.** The client requests no scopes and the server-side check is bypassed. Authorization happens at token-exchange time: Keycard's delegation policy permits the on-behalf exchange only when the tool's Databricks scope-resource is wired as a dependency of this application.

## Tools and scopes

Authorization works in two layers:

- **MCP gating scope** (`databricks:*`) — a free-form string verified by `@require_scope` and gated by Cedar at issuance. It decides *which tool* a caller may invoke. Fine-grained distinctions (e.g. `sql:read` vs `sql:execute`) live only here.
- **Upstream Databricks scope** — selected by *which Keycard resource* the tool exchanges against. Each resource is mapped (at the Keycard backend) to the real Databricks OAuth scope it requests, so the brokered token is narrowed to that scope. Databricks itself only distinguishes per-service scopes (`sql`, `dashboards.genie`, `all-apis`).

| Tool | Databricks endpoint | MCP gating scope | Exchange resource | Databricks scope |
|---|---|---|---|---|
| `list_clusters` | `GET /api/2.0/clusters/list` | `databricks:clusters:read` | `{DATABRICKS_HOST}` | `all-apis` |
| `list_warehouses` | `GET /api/2.0/sql/warehouses` | `databricks:sql:warehouses:read` | `{DATABRICKS_HOST}/sql` | `sql` |
| `execute_statement` | `POST /api/2.0/sql/statements` | `databricks:sql:execute` | `{DATABRICKS_HOST}/sql` | `sql` |
| `get_statement` | `GET /api/2.0/sql/statements/{id}` | `databricks:sql:read` | `{DATABRICKS_HOST}/sql` | `sql` |
| `list_genie_spaces` | `GET /api/2.0/genie/spaces` | `databricks:genie:spaces:read` | `{DATABRICKS_HOST}/genie` | `dashboards.genie` |
| `start_genie_conversation` | `POST /api/2.0/genie/spaces/{id}/start-conversation` | `databricks:genie:converse` | `{DATABRICKS_HOST}/genie` | `dashboards.genie` |
| `get_genie_message` | `GET /api/2.0/genie/spaces/{id}/conversations/{cid}/messages/{mid}` | `databricks:genie:read` | `{DATABRICKS_HOST}/genie` | `dashboards.genie` |
| `get_genie_query_result` | `GET .../messages/{mid}/attachments/{aid}/query-result` | `databricks:genie:read` | `{DATABRICKS_HOST}/genie` | `dashboards.genie` |

All three exchange resources mint a workspace-audience token that works against `{DATABRICKS_HOST}/api/...`; the path suffix only selects the scope.

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
   # Fill in KEYCARD_URL, MCP_SERVER_URL, DATABRICKS_HOST, ENFORCE_TOOL_SCOPES
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
| `MCP_SERVER_URL` | `http://localhost:8000/` | Base URL the MCP client uses to reach this server, and the single source of truth for the bind port (parsed from this URL). Must end with a trailing slash. The advertised URL and bind port must agree, or MCP auth fails with an invalid audience. |
| `DATABRICKS_HOST` | `https://<your-workspace>.cloud.databricks.com` | Databricks workspace host **only** (no API path); each tool appends its own route |
| `ENFORCE_TOOL_SCOPES` | `true` | `true` = the server verifies per-tool scopes; `false` = the delegation policy authorizes the exchange instead |
| `ENABLE_AUTHORIZATION_FLOW` | `false` | `true` = a tool whose token exchange lacks a delegated grant returns `authorization_required` and exposes the `authorize` tool + `/oauth/callback` route (see below); `false` = the raw token-exchange error is returned |
| `DATABRICKS_WAREHOUSE_ID` | _(unset)_ | Optional default warehouse for `execute_statement` |
| `DATABRICKS_GENIE_SPACE_ID` | _(unset)_ | Optional default Genie space for the Genie tools |

`KEYCARD_CLIENT_ID` / `KEYCARD_CLIENT_SECRET` are brokered at runtime by `keycard run` — never put them in `.env`.

## How it works

```
Client → [Keycard bearer token] → server → [token exchange] → [Databricks token] → Databricks REST API
```

1. The client authenticates to the server with a Keycard bearer token.
2. When `ENFORCE_TOOL_SCOPES=true`, `@require_scope` checks the token carries the tool's gating scope before anything else.
3. `@auth_provider.grant(<resource>)` exchanges the caller token for a Databricks OAuth token via the zone's STS, where `<resource>` is the tool's scope-resource (`{DATABRICKS_HOST}/sql`, `{DATABRICKS_HOST}/genie`, or `{DATABRICKS_HOST}` for `all-apis`). The resource determines which Databricks scope the brokered token carries. When `ENFORCE_TOOL_SCOPES=false`, Keycard's delegation policy authorizes (or denies) this exchange based on the app's dependency on that resource.
4. The tool reads the exchanged token for the same resource from `ctx.get_state("keycardai")` and calls the Databricks REST endpoint with it as a Bearer token.
5. The brokered token is scoped to the call — no Databricks tokens are cached or stored.

## On-demand authorization (`ENABLE_AUTHORIZATION_FLOW`)

By default a tool whose token exchange fails because the user has no delegated grant for the resource just returns the raw token-exchange error. Set `ENABLE_AUTHORIZATION_FLOW=true` to instead drive the user through a server-side OAuth authorization-code flow, so they can grant access to one resource at a time without leaving the conversation:

1. The tool returns a structured `authorization_required` error naming the missing resource and telling the caller to run the `authorize` tool.
2. `authorize(resource=...)` mints a Keycard `/authorize` link (authorization code + PKCE, RFC 8707 `resource` indicator) for that single resource and returns the `authorization_url`. It uses the server's own confidential client (`KEYCARD_CLIENT_ID`/`KEYCARD_CLIENT_SECRET`, brokered by `keycard run`) — no new client is registered.
3. The user opens the link, signs in, and approves. Keycard stores the delegated `(user, resource)` grant and redirects to this server's `/oauth/callback`, which completes the code exchange and shows a confirmation page.
4. The user retries the original tool; the `@grant` token exchange now succeeds.

```
tool → authorization_required → authorize(resource) → /authorize link → consent → /oauth/callback → retry tool ✓
```

The redirect URI is the fixed `<MCP_SERVER_URL>oauth/callback` (e.g. `http://localhost:8000/oauth/callback`), hosted on the running MCP server. For local use the browser and server share the host, so `localhost` is reachable. Before enabling the flag, register that exact URL as an allowed `redirect_uri` on the server's application in Keycard and permit the `authorization_code` grant; the zone must also allow on-demand user authorization of the Databricks resources (already wired as the app's dependencies). Pending flows are tracked in-process and keyed by an OAuth `state` value, so this assumes a single server process.

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

- **Add more Databricks endpoints** — add tools to `tools/` modeled on the SQL/Genie tools; reuse `@require_scope(...)` + `@auth_provider.grant(<scope-resource>)` (one of `DATABRICKS_HOST`, `DATABRICKS_SQL_RESOURCE`, `DATABRICKS_GENIE_RESOURCE`) and call other `/api/2.x/...` routes.
- **Add a scope** — to gate a tool, define the MCP scope in `tools/scope.py` (`SUPPORTED_SCOPES`), tag the tool with `@require_scope(...)`, and grant it to users via a Cedar permit (see `SPEC.md §1h`). To request a *new upstream Databricks scope*, add a scope-resource constant in `tools/scope.py`, register the matching resource at the Keycard backend mapped to that Databricks scope, and exchange against it.
