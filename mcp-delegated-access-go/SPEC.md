# SPEC — mcp-delegated-access-go

> A Keycard-protected MCP server that also brokers delegated access: it exchanges the caller's verified token for a resource-scoped token using its own application credential (RFC 8693). The simplest way to see the full OAuth handshake plus delegated token exchange end-to-end in Go.

This template is a plain Go `net/http` MCP server built on `mcp-server-go`, adding an `AuthProvider` (wired with a `ClientSecret` credential) and a `/broker` endpoint. It runs as-is, but it has **no** authorization until Keycard is provisioned with the primitives below. An agent (e.g. the `keycard-template-app` skill) MUST perform the steps in this document before declaring the project ready.

## 0. How the agent uses this document

**This SPEC is input for the agent, not output for the user.** The `keycard-template-app` skill is the sole renderer of user-facing narration. Read this document, extract the structured data (primitives, edits, port, build command, smoke tests, handoff commands), and reason from it — but never quote or print it verbatim. Paraphrase jargon-heavy sentences before showing anything to the user.

## 0a. What this template is

A working MCP server built on Go's standard `net/http` and the official MCP Go SDK (`github.com/modelcontextprotocol/go-sdk`), protected by Keycard's OAuth 2.1 flow via `github.com/keycardai/credentials-go`. It ships the `hello` tool plus a `/broker` endpoint that demonstrates **delegated access**: after bearer auth verifies the caller, the server's `AuthProvider` exchanges that token for a token scoped to its own resource (RFC 8693 token exchange), authenticated with the server's `ClientSecret` application credential, and reports the brokered result. Beyond the base OAuth plumbing (metadata endpoints, bearer middleware, Streamable HTTP), this shows how a server acts on the user's behalf against a downstream resource.

Pick this template when your MCP server needs to call a downstream API or resource on the user's behalf, not just verify tokens.

## 0b. One-line summary (for the template picker)

Keycard-protected MCP server (Go + net/http) that brokers delegated access — exchanges the caller's token for a resource-scoped token via the server's application credential.

## 0c. Concepts the agent should introduce

Introduce each concept **once**, the first time it appears. Use the one-sentence framing below and include the docs link.

| Order | Concept | First appears at | One-sentence framing | Docs |
|---|---|---|---|---|
| 1 | Zone | Step 3 (resolve context) | Your private Keycard environment that holds users, apps, and policies and issues credentials. | https://docs.keycard.ai/platform/concepts/zones/ |
| 2 | Organization | Step 3 (resolve context) | The account that owns one or more zones — usually your company or team. | https://docs.keycard.ai/platform/concepts/zones/ |
| 3 | STS provider | §1a (provider lookup) | The credential source built into every zone that mints OAuth access tokens for your resources. | https://docs.keycard.ai/platform/concepts/providers/ |
| 4 | Application | §1b (app creation) | The identity for the thing you're building, registered with Keycard so it can request credentials. | https://docs.keycard.ai/platform/concepts/applications/ |
| 5 | Resource | §1c (resource creation) | The protected endpoint the application serves — your server's `/mcp` URL, in this case. | https://docs.keycard.ai/platform/concepts/resources/ |
| 6 | OIDC issuer | §2 (KEYCARD_URL) | The URL apps use to discover Keycard's signing keys and token endpoints; for your zone it's `https://<zone-id>.<env-domain>`. | https://docs.keycard.ai/platform/architecture/standards-and-protocols/ |

## 1. Required Keycard primitives

The agent MUST ensure all three primitives exist in the active Keycard environment. These steps are identical to the other MCP-server templates; the language is irrelevant to provisioning.

### 1a. Credential provider

Discover the `keycard-sts` provider:

```bash
keycard agent api /zones/<zone-id>/providers --org <org-id>
```

Pick the provider with `type = "keycard-sts"`. If multiple, ask which to use. If none exists, abort:

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
- Do NOT set `dependencies` — the provider/resource link lives on the Resource (`application_id`).

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
- `application_id` wires the "provided by" relationship and must be set at Resource-creation time.

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

Write `.env` in the project root so `go run .` works without manual exports. The template reads `KEYCARD_URL`, `KEYCARD_RESOURCE_ID`, and `PORT` from the environment; load `.env` via your shell, `keycard run`, or a tool like `direnv`:

```
KEYCARD_URL=https://<id>.keycard.cloud
KEYCARD_RESOURCE_ID=http://localhost:<port>/mcp
PORT=8000
```

`KEYCARD_RESOURCE_ID` is this server's registered resource (the `/mcp` URL from §1c). It is both the audience tokens are bound to and the resource the broker exchanges for.

Commit `.env.example` with placeholders. `.env` is already in `.gitignore`.

### keycard.toml

The template ships a minimal `keycard.toml` with only `[org]`, `[zone]`, and an empty `[credentials]` block:

```toml
[org]
id = "<org-id>"

[zone]
id = "<zone-id>"

[credentials]
```

The agent MUST replace both placeholder IDs with the values from the user's existing zone-bound `keycard.toml`. If no such file exists, abort and tell the user to run `keycard init` first.

Do not add `schema_version`, `[project]`, `[server]`, or `[zone].url` — runtime config (`KEYCARD_URL`, `PORT`) belongs in `.env`. TOML does not expand environment variables.

### Application credential (KEYCARD_CLIENT_ID / KEYCARD_CLIENT_SECRET)

The broker authenticates its token exchange with the server's own OAuth client credential. Supply `KEYCARD_CLIENT_ID` and `KEYCARD_CLIENT_SECRET` via the environment (`keycard run` or your deployment's secret store) — **never commit them to `.env`**. These are the application's client credentials from your zone (Console → Applications → your app → Credentials).

Leave the `keycard.toml` `[credentials]` table empty unless a tool calls a third-party API; then use `keycard-discover-entities` + `keycard-upsert-config` to add the entry — never hand-edit unknown URIs.

## 3. Agent verification

Run from the project directory after provisioning. Do not leave processes behind.

```bash
go build ./...
KEYCARD_URL="$KEYCARD_URL" PORT=<port> go run . &
SERVER_PID=$!
# wait for "MCP server running on http://localhost:<port>/mcp"
curl -fsS http://localhost:<port>/healthz | head -1
curl -fsS http://localhost:<port>/.well-known/oauth-protected-resource | head -1
curl -fsS http://localhost:<port>/.well-known/oauth-authorization-server | head -1
curl -fsS -o /dev/null -w '%{http_code}\n' http://localhost:<port>/broker  # expect 401 (bearer auth runs first)
kill $SERVER_PID 2>/dev/null || true
```

The local smoke test only confirms `/broker` rejects unauthenticated calls (`401`). The full delegated exchange (`brokered: true`) requires a real user token and is exercised by the Keycard template eval, not this smoke test.

`/healthz` and `/.well-known/oauth-protected-resource` are served locally and MUST return JSON immediately. `/.well-known/oauth-authorization-server` proxies the zone, so it requires a real `KEYCARD_URL`; if it returns a `502` or an upstream error, confirm `.env` has a real zone URL (not a placeholder like `https://your-zone.keycard.cloud`), then restart.

The agent MUST stop the smoke-test process before handing off.

## 4. What the agent MUST NOT do

- Do not commit `KEYCARD_URL` or `.env`. They belong in the user's environment.
- Do not invent Resource identifiers — derive from the project name (kebab-case, `^[a-z][a-z0-9-]*$`) and reuse on re-runs.
- Do not pick a `keycard-vault` provider for the Resource.
- Do not start the server for the user inside the agent session — Claude Code does not hot-reload MCP config, so the user's server must run in a separate terminal that survives the Claude restart.
- Do not write Cedar or per-tool policy — v1 auth is OAuth scope-based (`mcp:tools`).
- Do not add credentials the user did not ask for.

## 5. Handoff data (for the skill to render)

After provisioning and verification, register the server in Claude's local MCP config:

```bash
claude mcp remove <name> 2>/dev/null || true
claude mcp add --transport http <name> http://localhost:<port>/mcp
```

`--transport http` is required.

The skill renders the handoff from the following data:

| Key | Value | Run-where | Reason |
|---|---|---|---|
| `name` | `<name>` | — | Kebab-case project name |
| `port` | `<port>` | — | Local HTTP port the server listens on |
| `build_command` | `go build ./...` | this session | Compiles the project |
| `start_command` | `cd <name> && go run .` | their terminal (separate, keep open) | The server must be reachable at `http://localhost:<port>/mcp` for the remaining steps |
| `claude_register_command` | `claude mcp add --transport http <name> http://localhost:<port>/mcp` | this session | Adds the server to Claude's MCP config |
| `restart_command` | `keycard run -- claude` | their terminal | Claude only discovers MCP servers at startup |
| `auth_command` | `/mcp` → pick `<name>` | new agent session | Completes the OAuth flow so Keycard issues a credential for the resource |

### Carried IDs for the recap

After §1 and §3 the agent has `<zone-id>`, `<application-id>`, `<resource-id>`, `<provider-id>` (STS), and the verified endpoints. Point the user at `https://console.keycard.ai` for looking up any registered IDs.

## 6. What to say to the user (per-step narration)

Paraphrase these into the skill's voice; never read them verbatim and never pass through protocol jargon ("STS provider", "bearer token scoped to mcp:tools", "OIDC issuer", "RFC 8693", "client_assertion").

| Step | Tell the user before you start |
|---|---|
| Step 4 (copy) | "Copying the `mcp-delegated-access-go` blueprint into `./<name>` — a net/http MCP server with a `hello` tool plus a `/broker` endpoint that brokers delegated access on the user's behalf." |
| Step 6 (fill in) | "Filling in `.env` with your zone's OIDC issuer URL and a free local port, setting the module name, and dropping a `keycard.toml` next to it." |
| Step 7 (register) | "Registering this server with your Keycard zone — creating an Application (so Keycard recognizes your server) and a Resource (the `/mcp` endpoint, so Keycard knows what scope the tokens grant). Both are backed by your zone's built-in STS provider, which mints the OAuth tokens." |
| Step 8 (smoke-test) | "Booting the server for a few seconds to confirm the health and OAuth metadata endpoints respond with real JSON, then shutting it down so the port stays free." |
| Step 9 (handoff) | "All the Keycard-side setup is done. The last bit happens in your terminal — start the server, restart Claude so it discovers the new MCP entry, and authenticate via `/mcp`." |

## 7. Things to try once it's running

1. **Call the hello tool.** Ask Claude: *"Use `hello` to greet me as `<your name>`."* You should get back `Hello, <your name>!` — that confirms the full OAuth flow (token mint → bearer validation → tool execution) works end-to-end.
2. **List the server's tools.** Ask Claude: *"What tools does the `<name>` server expose?"*
3. **Inspect the OAuth metadata.** Open `http://localhost:<port>/.well-known/oauth-protected-resource` — you'll see the JSON the MCP SDK uses to discover the authorization server, including `resource` and `scopes_supported`.

## 8. Where to extend

- **Add a tool.** Define an input struct and a handler `func(ctx, *mcp.ServerSession, *mcp.CallToolParamsFor[In]) (*mcp.CallToolResultFor[any], error)`, then register it with `mcp.AddTool(server, &mcp.Tool{Name, Description}, handler)` in `main.go` — alongside `hello`. Tools are gated by the `mcp:tools` scope the bearer middleware enforces.
- **Change the server.** `main.go` is the whole net/http app. The OAuth metadata handler (`keycardmcp.AuthMetadataHandler`) and bearer middleware (`keycardmcp.RequireBearerAuth`) come from `github.com/keycardai/credentials-go/mcp` — you only touch those to change scopes or add a second resource.
- **Add downstream credentials.** If a tool needs to call a third-party API, use `keycard-discover-entities` to find the Keycard entity URI and `keycard-upsert-config` to add a credential entry, brokered into the process by `keycard run`.

## 9. Common gotchas the agent should pre-empt

1. **`KEYCARD_URL` not set / placeholder.** The server exits with `KEYCARD_URL environment variable is required`, or `/.well-known/oauth-authorization-server` returns a `502`. Cause: `.env` is missing, empty, or still a placeholder like `https://your-zone.keycard.cloud`. Fix: set a real zone URL and restart.

2. **`invalid_target` / `Requested authorization for unknown resource ...` during the OAuth flow.** The Resource `identifier` in Keycard does not match the URL the MCP client requests a token for. It MUST be `http://localhost:<port>/mcp` (with the `/mcp` suffix and correct port). Fix in `https://console.keycard.ai → Resources`.

3. **Port already in use at smoke-test time.** Re-probe the port, pick a new one, rewrite `.env`, retry.

4. **`keycard-vault` provider selected instead of `keycard-sts`.** Vault providers cannot mint OAuth tokens for an MCP Resource; token requests fail with `invalid_target`. Point the Resource's `credential_provider_id` at the zone's `keycard-sts` provider.

5. **Claude does not see the new MCP server.** Claude discovers MCP servers at startup and does not hot-reload. The user MUST restart Claude (`keycard run -- claude`) after `claude mcp add`.

6. **`/broker` returns `brokered: false`.** The token exchange failed; the AccessContext carries the reason in the `error` field. Common causes: the application credential (`KEYCARD_CLIENT_ID` / `KEYCARD_CLIENT_SECRET`) is missing or wrong, or the application is not authorized to exchange for `KEYCARD_RESOURCE_ID`. Unauthenticated calls to `/broker` return `401` because bearer auth runs before the exchange.
