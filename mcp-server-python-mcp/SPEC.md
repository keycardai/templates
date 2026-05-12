# SPEC — mcp-server-python-mcp

> A Keycard-protected MCP server with a single `hello_world` tool — the simplest Python starting point for the full OAuth handshake.

This template is a FastMCP server wrapped in a Starlette ASGI app and protected by Keycard. It runs as-is but has **no** authorization until Keycard is provisioned with the primitives below. An agent MUST perform the steps in this document before declaring the project ready.

## 0. How the agent uses this document

**This SPEC is input for the agent, not output for the user.** Read this document, extract the structured data (primitives, edits, port, build command, smoke tests, handoff commands), and reason from it — but never quote or print any of it verbatim. Paraphrase jargon before showing anything to the user.

## 0a. What this template is

A working MCP server built on FastMCP (the MCP Python SDK's built-in FastMCP class) and protected by Keycard's OAuth 2.1 flow. It ships one tool — `hello_world` — that takes a name and returns a greeting. The server is wrapped in a Starlette ASGI app served by uvicorn, which adds a `/healthz` endpoint and exposes the full MCP protocol at `/mcp`. Add tools by decorating functions with `@mcp.tool()`.

## 0b. One-line summary

Minimal Keycard-protected MCP server (Python + FastMCP) with a `hello_world` tool — add your own tools and go.

## 0c. Concepts the agent should introduce

| Order | Concept | First appears at | One-sentence framing | Docs |
|---|---|---|---|---|
| 1 | Zone | Step 3 | Your private Keycard environment that holds users, apps, and policies and issues credentials. | https://docs.keycard.ai/platform/concepts/zones/ |
| 2 | Organization | Step 3 | The account that owns one or more zones. | https://docs.keycard.ai/platform/concepts/zones/ |
| 3 | STS provider | §1a | The credential source built into every zone that mints OAuth access tokens for your resources. | https://docs.keycard.ai/platform/concepts/providers/ |
| 4 | Application | §1b | The identity for the thing you're building, registered with Keycard so it can request credentials. | https://docs.keycard.ai/platform/concepts/applications/ |
| 5 | Resource | §1c | The protected endpoint the application serves — your server's `/mcp` URL. | https://docs.keycard.ai/platform/concepts/resources/ |
| 6 | Zone URL | §2 | The base URL for your zone, used to discover signing keys and token endpoints. | https://docs.keycard.ai/platform/architecture/standards-and-protocols/ |

## 1. Required Keycard primitives

### 1a. Credential provider

```bash
keycard agent api /zones/<zone-id>/providers --org <org-id>
```

Pick the provider with `type = "keycard-sts"`. If none, abort with a message pointing to Console. Carry as `<provider-id>`.

MUST NOT pick a `keycard-vault` provider.

### 1b. Application

```bash
keycard agent api -X POST /zones/<zone-id>/applications --org <org-id> -d '{
  "name": "<name>",
  "identifier": "<name>",
  "description": "Local MCP server scaffolded by keycard-template-app",
  "consent": "implicit"
}'
```

On 409, look up and reuse the existing ID. Carry as `<application-id>`.

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

The identifier MUST include the `/mcp` suffix. Carry as `<resource-id>`.

## 2. Configuration the agent MUST write

### Zone URL

Resolve `KEYCARD_ZONE_URL` from the zone ID and the `KEYCARD_ENV` domain:

| `KEYCARD_ENV` | Domain | Scheme |
|---|---|---|
| `production` (default) | `keycard.cloud` | `https` |
| `staging` | `keycard-stage.cloud` | `https` |
| `dev` | `keycard-dev.cloud` | `https` |
| `localdev` | `localdev.keycard.sh` | `http` |

Example: ID `<id>` in production → `https://<id>.keycard.cloud`.

### .env

```
KEYCARD_ZONE_URL=https://<id>.keycard.cloud
MCP_SERVER_URL=http://localhost:<port>/
PORT=<port>
```

`.env` is already in `.gitignore`. Commit `.env.example` with placeholders for other developers.

### keycard.toml

`[zone].url` in `keycard.toml` interpolates `${KEYCARD_ZONE_URL}` — already correct, no changes needed.

### Credentials

Leave the `[credentials]` table empty unless the user adds a tool that calls a third-party API.

## 3. Agent verification

```bash
uv sync
uv run uvicorn main:app --port <port> &
SERVER_PID=$!
# wait for "Application startup complete" log line
curl -fsS http://localhost:<port>/.well-known/oauth-protected-resource | head -1
curl -fsS http://localhost:<port>/.well-known/oauth-authorization-server | head -1
curl -fsS http://localhost:<port>/healthz | head -1
kill $SERVER_PID 2>/dev/null || true
```

All three endpoints MUST return JSON. If `oauth-authorization-server` returns HTML mentioning `TypeError: Invalid URL`, `KEYCARD_ZONE_URL` was not loaded — confirm `.env` contains a real URL, then restart.

The agent MUST stop the smoke-test process before handing off.

## 4. What the agent MUST NOT do

- Do not commit `KEYCARD_ZONE_URL` or `.env` to the repo.
- Do not invent Resource identifiers — derive from the project name and reuse on re-runs.
- Do not pick a `keycard-vault` provider.
- Do not start the server inside the agent session.
- Do not write Cedar or per-tool policy.
- Do not add credentials the user did not ask for.

## 5. Handoff data

After provisioning and verification, register the server:

```bash
claude mcp remove <name> 2>/dev/null || true
claude mcp add --transport http <name> http://localhost:<port>/mcp
```

If `claude` is not on PATH, add to `~/.claude.json`:
```json
{ "mcpServers": { "<name>": { "url": "http://localhost:<port>/mcp" } } }
```

| Key | Value | Run-where | Reason |
|---|---|---|---|
| `name` | `<name>` | — | Kebab-case project name |
| `port` | `<port>` | — | Local HTTP port |
| `build_command` | `uv sync` | this session | Installs dependencies |
| `start_command` | `cd <name> && uv run uvicorn main:app --port <port>` | their terminal (keep open) | Server must be reachable at `/mcp` |
| `claude_register_command` | `claude mcp add --transport http <name> http://localhost:<port>/mcp` | this session | Adds to Claude's MCP config |
| `restart_command` | `keycard run -- claude` | their terminal | Claude discovers MCP servers at startup |
| `auth_command` | `/mcp` → pick `<name>` | new agent session | Completes OAuth flow |

## 6. Common gotchas

1. **`RuntimeError: Either KEYCARD_ZONE_ID or KEYCARD_ZONE_URL is required`** — `.env` is missing or was not loaded. Confirm the file exists with a real zone URL and restart.

2. **`invalid_target` during OAuth flow** — The Resource `identifier` does not match `http://localhost:<port>/mcp`. Check Console → Resources and correct the identifier.

3. **Port already in use** — A previous smoke-test process was not killed. Find and kill it with `lsof -ti :<port> | xargs kill` then retry.

4. **`keycard-vault` provider selected** — Vault providers cannot mint OAuth tokens. Update the Resource to use the zone's `keycard-sts` provider.

5. **Claude does not see the server** — Restart Claude (`keycard run -- claude`) after `claude mcp add`.
