# mcp-client-python

MCP client with controllable OAuth scopes for testing scope-gated MCP servers.

Generic MCP clients request all scopes advertised by the server. This client lets you specify exactly which scopes to request, so you can verify that Cedar policies grant or deny the right scopes for each user.

## Install

```bash
uv sync
```

## Usage

```bash
# List tools — request only the SQL read scope
mcp-client --server-url http://localhost:8000/mcp \
           --scopes databricks:sql:read

# Call a tool with specific scopes
mcp-client --server-url http://localhost:8000/mcp \
           --scopes databricks:sql:execute \
           --tool execute_statement \
           --tool-args '{"statement": "SELECT 1"}'

# Request multiple per-tool scopes
mcp-client --server-url http://localhost:8000/mcp \
           --scopes databricks:sql:read databricks:sql:execute

# Request a scope the user's policy does not permit (expect it stripped at issuance)
mcp-client --server-url http://localhost:8000/mcp \
           --scopes databricks:genie:converse
```

## What it does

1. **Protected resource discovery** — `GET /.well-known/oauth-protected-resource/<path>`
2. **Authorization server discovery** — `GET /.well-known/oauth-authorization-server`
3. **Dynamic client registration** (RFC 7591) — registers a public PKCE client
4. **Authorization with scopes** — opens browser with only the scopes you specify
5. **Token exchange** — PKCE code exchange, reports granted scopes
6. **MCP session** — connects with bearer token, lists tools, optionally calls one

## Testing scope-gated policies

With the `databricks-agent` server running in Pattern A (`ENFORCE_TOOL_SCOPES=true`), use this client to verify which per-tool scopes a user's Cedar policy grants at issuance:

```bash
# User permitted databricks:sql:read + databricks:sql:execute
mcp-client --server-url http://localhost:8000/mcp \
           --scopes databricks:sql:read databricks:sql:execute \
           --tool execute_statement --tool-args '{"statement": "SELECT 1"}'
# → both scopes issued, execute_statement runs

mcp-client --server-url http://localhost:8000/mcp \
           --scopes databricks:genie:converse \
           --tool start_genie_conversation --tool-args '{"content": "top sales"}'
# → scope not permitted by policy, stripped at issuance, tool returns insufficient_scope

# Request only read — execute is then blocked at the tool
mcp-client --server-url http://localhost:8000/mcp \
           --scopes databricks:sql:read \
           --tool execute_statement --tool-args '{"statement": "SELECT 1"}'
# → execute_statement returns insufficient_scope (needs databricks:sql:execute)
```
