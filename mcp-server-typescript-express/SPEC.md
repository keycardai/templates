# SPEC — mcp-server-typescript-express

> A Keycard-protected MCP server with a single `hello` tool — the simplest way to see the full OAuth handshake end-to-end and use it as a starting point for your own tools.

This template is a plain Node/Express MCP server. It runs as-is, but it has **no** authorization until Keycard is provisioned with the primitives below. An agent (e.g. the `keycard-template-app` skill) MUST perform the steps in this document before declaring the project ready.

## 0a. What this template is

A working MCP server built on Express and the official MCP TypeScript SDK, protected by Keycard's OAuth 2.1 flow. It ships one tool — `hello` — that takes a name and returns a greeting. The point isn't the tool itself; it's the full protocol plumbing around it: OAuth metadata endpoints (`.well-known/oauth-protected-resource`, `.well-known/oauth-authorization-server`), bearer-token middleware that validates Keycard-minted JWTs, and Streamable HTTP transport. Once scaffolded, you have a running example you can extend by dropping new tool files into `src/tools/`.

Pick this template when you want to build your own MCP server from scratch and need a working, minimal starting point that already handles authentication.

## 0b. One-line summary (for the template picker)

Minimal Keycard-protected MCP server (Express + TypeScript) with a `hello` tool — add your own tools and go.

## 0c. Concepts the agent should introduce

Introduce each concept **once**, the first time it appears during narration. Use the one-sentence framing below and include the docs link so the user can read more in a side tab.

| Order | Concept | First appears at | One-sentence framing | Docs |
|---|---|---|---|---|
| 1 | Zone | Step 3 (resolve context) | Your private Keycard environment that holds users, apps, and policies and issues credentials. | https://docs.keycard.ai/platform/concepts/zones/ |
| 2 | Organization | Step 3 (resolve context) | The account that owns one or more zones — usually your company or team. | https://docs.keycard.ai/platform/concepts/zones/ |
| 3 | STS provider | §1a (provider lookup) | The credential source built into every zone that mints OAuth access tokens for your resources. | https://docs.keycard.ai/platform/concepts/providers/ |
| 4 | Application | §1b (app creation) | The identity for the thing you're building, registered with Keycard so it can request credentials. | https://docs.keycard.ai/platform/concepts/applications/ |
| 5 | Resource | §1c (resource creation) | The protected endpoint the application serves — your server's `/mcp` URL, in this case. | https://docs.keycard.ai/platform/concepts/resources/ |
| 6 | OIDC issuer | §2 (KEYCARD_URL) | The URL apps use to discover Keycard's signing keys and token endpoints; for your zone it's `https://<zone-id>.<env-domain>`. | https://docs.keycard.ai/platform/architecture/standards-and-protocols/ |

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

## 6. What to say to the user (per-step narration)

The `keycard-template-app` skill prescribes the narration style; the lines below supply the template-specific *content*. The agent SHOULD paraphrase these — do not read them verbatim — but preserve the key information in each.

| Step | Tell the user before you start |
|---|---|
| Step 4 (copy) | "Copying the `mcp-server-typescript-express` blueprint into `./<name>` — this gives you a working Express MCP server with a `hello` tool already wired up. The cached copy stays untouched." |
| Step 6 (fill in) | "Filling in `.env` with your zone's OIDC issuer URL and a free local port so the server knows which Keycard zone to trust. I'll also set your project name in `package.json` and drop a `keycard.toml` next to it." |
| Step 7 (register) | "Registering this server with your Keycard zone — that means creating an Application (so Keycard recognizes your server) and a Resource (the `/mcp` endpoint itself, so Keycard knows what scope the tokens grant access to). Both are backed by your zone's built-in STS provider, which is what actually mints the OAuth tokens." |
| Step 8 (smoke-test) | "Booting the server for a few seconds to confirm the OAuth metadata endpoints respond with real JSON. If `.well-known/oauth-protected-resource` comes back happy, the OIDC wiring is correct. I'll shut it down again so the port stays free for you." |
| Step 9 (handoff) | "All the Keycard-side setup is done. The last bit has to happen in your terminal — start the server, restart Claude so it discovers the new MCP entry, and authenticate via `/mcp`." |

## 7. Handoff recap template

After printing the §5 handoff block, the agent MUST also print a human-readable summary using the IDs and values carried forward during the run. Fill in the `<placeholders>`:

```
You're set up. I started from the `mcp-server-typescript-express` blueprint,
dropped it into `./<name>`, and got it building cleanly with `npm install &&
npm run build`. On the Keycard side, your zone (`<zone-id>`) now has:

  - Application `<application-id>` (identifier: `<name>`)
  - Resource `<resource-id>` (identifier: `http://localhost:<port>/mcp`)
  - Backed by STS provider `<sts-provider-id>`

The smoke-test confirmed both OAuth metadata endpoints
(`/.well-known/oauth-protected-resource` and
`/.well-known/oauth-authorization-server`) return valid JSON.

What's left for you:

  1. Start the server in a separate terminal (`cd <name> && npm start`)
  2. Restart Claude with `keycard run -- claude`
  3. Run `/mcp` in the new session, pick `<name>`, and complete the OAuth flow

Once those are done you can call the `hello` tool — and any others you
add — from Claude like any other MCP tool. If anything looks off, check the
registered IDs above in https://console.keycard.ai.
```

## 8. Things to try once it's running

The agent SHOULD print these as concrete suggestions after the handoff recap, so the user knows what to do first:

1. **Call the hello tool.** Ask Claude: *"Use `hello` to greet me as `<your name>`."* You should get back `Hello, <your name>!` — that confirms the full OAuth flow (token mint → bearer validation → tool execution) works end-to-end.
2. **List the server's tools.** Ask Claude: *"What tools does the `<name>` server expose?"* Claude will call `tools/list` on the MCP transport and show you the `hello` tool's name, description, and input schema.
3. **Inspect the OAuth metadata.** Open `http://localhost:<port>/.well-known/oauth-protected-resource` in a browser — you'll see the JSON document the MCP SDK uses to discover your Keycard zone's authorization server, including the `resource` identifier and `scopes_supported`.

## 9. Where to extend

- **Add a new tool.** Create a file in `src/tools/` following the pattern in `src/tools/hello.ts`: export a `register<ToolName>Tool(server: McpServer)` function that calls `server.tool(...)` with a name, description, Zod input schema, and handler. Then import and call it in `src/server.ts` inside `createMcpServer()` — that's the only wiring needed.
- **Change the server itself.** `src/server.ts` is the Express app. The OAuth metadata router (`mcpAuthMetadataRouter`) and bearer-auth middleware (`requireBearerAuth`) are imported from `@keycardai/mcp` — you shouldn't need to touch those unless you're changing scopes or adding a second resource.
- **Add downstream credentials.** If a new tool needs to call a third-party API (e.g. GitHub, Slack), use the `keycard-discover-entities` skill to find the right Keycard entity URI and `keycard-upsert-config` to add a `[[credentials.default]]` entry in `keycard.toml`. The credential will be brokered into the process by `keycard run`.

## 10. Common gotchas the agent should pre-empt

When one of these fails, the agent SHOULD surface the matching diagnostic verbatim rather than printing a generic error.

1. **`TypeError: Invalid URL` from the OAuth metadata endpoint.** The `/.well-known/oauth-authorization-server` endpoint returns an HTML page instead of JSON, and the page mentions `TypeError: Invalid URL`. Cause: `KEYCARD_URL` in `.env` is either missing, empty, or still set to a placeholder like `https://your-zone.keycard.cloud`. Fix: confirm `.env` contains a real zone URL (e.g. `https://o36mbsre94s2vlt8x5jq6nbxs0.keycard.cloud`) and restart the server.

2. **`invalid_target` or `Requested authorization for unknown resource ...` during the OAuth flow.** The Resource `identifier` registered in Keycard does not match the URL the MCP client is requesting a token for. The identifier MUST be `http://localhost:<port>/mcp` (with the `/mcp` suffix and the correct port). Fix: check the registered Resource in `https://console.keycard.ai → Resources` and correct the identifier.

3. **Port already in use at smoke-test time.** Something else grabbed the port between Step 6 and Step 8, or a previous smoke-test process was not killed cleanly. Re-probe the port, pick a new one if needed, rewrite `.env`, and retry.

4. **`keycard-vault` provider selected instead of `keycard-sts`.** Vault providers store static secrets for downstream services — they cannot mint OAuth tokens for an MCP Resource. If the Resource's `credential_provider_id` points at a vault provider, token requests will fail with `invalid_target`. Fix: update the Resource to use the zone's `keycard-sts` provider.

5. **Claude does not see the new MCP server.** Claude Code discovers MCP servers at startup and does not hot-reload. The user MUST restart Claude (`keycard run -- claude`) after running `claude mcp add`. If the server still doesn't appear, check `~/.claude.json` for the entry.
