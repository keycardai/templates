# SPEC — mcp-server-typescript-express

This template is a plain Node/Express MCP server. It runs as-is, but it has **no** authorization until Keycard is provisioned with the primitives below. An agent (e.g. the `keycard-template-app` skill) MUST perform the steps in this document before declaring the project ready.

## 1. Required Keycard primitives

The agent MUST ensure all three primitives exist in the active Keycard environment.

### 1a. Credential provider

Discover the `keycard-sts` provider:

```bash
keycard agent api /zones/<zone-id>/providers --org <org-id>
```

Pick the provider with `type = "keycard-sts"`. If there are multiple, ask the user which to use. If none exists, abort:

```
Error: no keycard-sts provider found — create one in https://console.keycard.ai → Providers, then retry.
```

MUST NOT pick a `keycard-vault` provider — vault providers issue stored credentials for downstream services and cannot mint OAuth tokens for an MCP Resource. Using one causes `invalid_target` errors during the `/mcp` OAuth flow.

Carry the result forward as `<provider-id>`.

### 1b. Application

```bash
keycard agent api -X POST /zones/<zone-id>/applications --org <org-id> -d '{
  "name": "<name>",
  "identifier": "<name>",
  "description": "Local MCP server scaffolded by keycard-template-app",
  "consent": "implicit"
}'
```

- `identifier` is the kebab-case project name — keep it stable across re-runs so the application is updated rather than duplicated.
- `consent: "implicit"` is appropriate for a locally-scaffolded developer server.
- Do NOT set `dependencies` — the provider/resource link lives on the Resource (`application_id`), not on the Application's dependency graph.

On 409 ("already exists"), look up the existing application via `keycard agent api /zones/<zone-id>/applications --org <org-id>` and reuse its ID. On other errors, abort:

```
Could not auto-register application. Register manually at https://console.keycard.ai → Applications, then retry.
```

Carry the result forward as `<application-id>`.

### 1c. Resource

```bash
keycard agent api -X POST /zones/<zone-id>/resources --org <org-id> -d '{
  "name": "<name>",
  "identifier": "http://localhost:<port>/mcp",
  "description": "Local MCP server scaffolded by keycard-template-app",
  "scopes": ["mcp:tools"],
  "application_id": "<application-id>",
  "credential_provider_id": "<provider-id>"
}'
```

- The resource `identifier` MUST include the `/mcp` suffix — that is the path MCP clients hit, and the authorization server rejects token requests for resources whose identifier does not match the protected URL exactly (`invalid_target` / `Requested authorization for unknown resource ...`).
- `application_id` wires the "provided by" relationship between the Resource and its Application. It must be set at Resource-creation time.

On 403, network error, or missing session:

```
Could not auto-register. Register manually at https://console.keycard.ai → Resources.
```

## 2. Configuration the agent MUST write

### KEYCARD_URL

Resolve `KEYCARD_URL` from the Keycard ID + `KEYCARD_ENV` domain mapping:

| `KEYCARD_ENV` | Domain | Scheme |
|---|---|---|
| `production` (default if unset) | `keycard.cloud` | `https` |
| `staging` | `keycard-stage.cloud` | `https` |
| `dev` | `keycard-dev.cloud` | `https` |
| `localdev` | `localdev.keycard.sh` | `http` |

Example: ID `<id>` in production → `https://<id>.keycard.cloud`.

### .env

Write `.env` in the project root with the resolved values so `npm start` works without manual exports:

```
KEYCARD_URL=https://<id>.keycard.cloud
PORT=8000
```

Commit `.env.example` with placeholder values for other developers. `.env` is already in `.gitignore`.

### keycard.toml

`[zone].url` in `keycard.toml` interpolates `${KEYCARD_URL}` — already correct in the template, no changes needed.

### Credentials

The `[credentials]` table in `keycard.toml` is intentionally empty. Leave it empty unless the user adds a tool that calls a third-party API. When that happens, use the `keycard-discover-entities` skill to find the right entity URI and `keycard-upsert-config` to write the credential entry — never hand-edit unknown URIs.

## 3. Agent verification

Run from the project directory after provisioning. Do not leave processes behind.

```bash
npm install && npm run build
npm start &
SERVER_PID=$!
# wait for "running on http://localhost:<port>" log line
curl -fsS http://localhost:<port>/.well-known/oauth-protected-resource | head -1
curl -fsS http://localhost:<port>/.well-known/oauth-authorization-server | head -1
kill $SERVER_PID 2>/dev/null || true
```

Both endpoints MUST return JSON. If `oauth-authorization-server` returns an HTML page mentioning `TypeError: Invalid URL`, `KEYCARD_URL` was not loaded — confirm `.env` exists with a real URL (not a placeholder like `https://your-zone.keycard.cloud`), then restart.

The agent MUST stop the smoke-test process before handing off. A stray process holds the port, and Claude Code cannot pick up MCP servers added mid-session anyway.

## 4. What the agent MUST NOT do

- Do not commit `KEYCARD_URL` or `.env` to the repo. They belong in the user's environment.
- Do not invent Resource identifiers — derive from the project name (kebab-case, `^[a-z][a-z0-9-]*$`) and reuse on re-runs.
- Do not pick a `keycard-vault` provider for the Resource.
- Do not start the server for the user inside the agent session — Claude Code does not hot-reload MCP config, so the user's server must be started in a separate terminal that survives the Claude restart.
- Do not write Cedar or per-tool policy — v1 auth is OAuth scope-based (`mcp:tools`); per-tool authorization is out of scope for this template.
- Do not add credentials the user did not ask for.

## 5. Instructions for the user

After provisioning and verification, the agent MUST register the server in Claude's local MCP config:

```bash
claude mcp remove <name> 2>/dev/null || true
claude mcp add --transport http <name> http://localhost:<port>/mcp
```

`--transport http` is required — without it, `claude` treats the URL as a stdio command and the add fails.

If `claude` is not on PATH, tell the user to add this to `~/.claude.json`:

```json
{
  "mcpServers": {
    "<name>": {
      "url": "http://localhost:<port>/mcp"
    }
  }
}
```

Then the agent MUST print this handoff block verbatim (with `<name>` / `<port>` substituted) and stop:

```
Next steps (run these yourself — the agent cannot do them from this session):

1. Start the MCP server in a SEPARATE terminal and leave it running:

     cd <name>
     npm start

   Keep that terminal open. The server must be reachable on
   http://localhost:<port>/mcp for the rest of these steps to work.

2. Exit this Claude Code session and start a new one with Keycard:

     keycard run -- claude

   Claude only discovers MCP servers at startup, so a restart is required.

3. In the new Claude session, authenticate to the MCP server:

     /mcp

   Pick "<name>" from the list and follow the OAuth flow. Keycard will mint
   a bearer token scoped to mcp:tools and Claude will start calling the
   `hello` tool through it.
```
