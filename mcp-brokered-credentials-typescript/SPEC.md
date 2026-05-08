# SPEC — mcp-brokered-credentials-typescript

This template is an MCP **proxy** server: it exposes two tools (`search`, `execute`) that fan out to the official Linear MCP server at `https://mcp.linear.app/mcp`. The proxy authenticates to Linear using a token brokered by Keycard via RFC 8693 token exchange — the user's bearer token is exchanged for a Linear-scoped token at call time, no static API keys live in the server's config.

The agent (e.g. the `keycard-template-app` skill) MUST perform every step in this document before declaring the project ready. The `keycard run -- npm start` workflow at the end depends on every primitive being in place.

Throughout, treat `<name>` as the kebab-case project name (default: `mcp-brokered-credentials-typescript`) and `<port>` as the local HTTP port (default: `8000`).

## 1. Required Keycard primitives

The agent MUST ensure every primitive below exists in the active Keycard environment. Most calls are idempotent; on `409` ("already exists"), GET the list endpoint and reuse the existing record's ID.

### 1a. Linear credential provider

The Linear MCP server is the upstream resource. It needs a Keycard provider that can mint OAuth tokens accepted by `https://mcp.linear.app/mcp`. Linear MCP supports OAuth 2.1 with dynamic client registration, so Keycard's generic OAuth provider is appropriate.

```bash
keycard agent api -X POST /zones/<zone-id>/providers --org <org-id> -d '{
  "name": "linear",
  "identifier": "https://mcp.linear.app",
  "type": "oauth",
  "description": "Linear MCP OAuth provider"
}'
```

If the active Keycard build does not accept those fields verbatim, abort and ask the user to create the provider manually:

```
Could not auto-register the Linear provider. Create it at
https://console.keycard.ai → Providers with identifier
"https://mcp.linear.app" pointing at the Linear MCP authorization
server, then retry.
```

Carry the result forward as `<linear-provider-id>`.

### 1b. Linear application

```bash
keycard agent api -X POST /zones/<zone-id>/applications --org <org-id> -d '{
  "name": "linear",
  "identifier": "https://mcp.linear.app/mcp",
  "description": "Linear MCP application",
  "consent": "required"
}'
```

The `consent` enum is `required` | `implicit`. `"explicit"` is rejected with a validation error.

Carry the result forward as `<linear-application-id>`.

### 1c. Linear resource

The resource identifier MUST be `https://mcp.linear.app/mcp` exactly — that is the URL the proxy hits, and Keycard's STS rejects token requests whose `resource` does not match the registered identifier.

```bash
keycard agent api -X POST /zones/<zone-id>/resources --org <org-id> -d '{
  "name": "linear",
  "identifier": "https://mcp.linear.app/mcp",
  "description": "Linear MCP server (upstream)",
  "scopes": ["read", "write"],
  "application_id": "<linear-application-id>",
  "credential_provider_id": "<linear-provider-id>"
}'
```

Carry the result forward as `<linear-resource-id>`.

### 1d. STS provider for the proxy

Discover the `keycard-sts` provider — same step as the base template:

```bash
keycard agent api /zones/<zone-id>/providers --org <org-id>
```

Pick the entry with `type = "keycard-sts"`. Do NOT pick a `keycard-vault` provider for the proxy resource — vault providers cannot mint OAuth tokens for an MCP Resource.

Carry the result forward as `<sts-provider-id>`.

### 1e. Proxy application

This is the application that THIS server identifies as when it talks to Keycard's STS. Its client_id / client_secret are the credentials the proxy uses to authenticate the token-exchange call.

```bash
keycard agent api -X POST /zones/<zone-id>/applications --org <org-id> -d '{
  "name": "<name>",
  "identifier": "<name>",
  "description": "MCP proxy that brokers Linear credentials",
  "consent": "implicit"
}'
```

Carry the result forward as `<proxy-application-id>`.

### 1f. Proxy resource

```bash
keycard agent api -X POST /zones/<zone-id>/resources --org <org-id> -d '{
  "name": "<name>",
  "identifier": "http://localhost:<port>/mcp",
  "description": "MCP proxy scaffolded by keycard-template-app",
  "scopes": ["mcp:tools"],
  "application_id": "<proxy-application-id>",
  "credential_provider_id": "<sts-provider-id>"
}'
```

Carry the result forward as `<proxy-resource-id>`.

### 1f-bis. Wire Linear as a dependency of the proxy application

Dependencies live on the **application**, not the resource. The management API accepts only `PUT /applications/<app-id>/dependencies/<resource-id>` with an empty JSON body — `dependencies: [...]` on a resource POST/PATCH is silently dropped, and there is no `POST .../dependencies` collection route.

```bash
keycard agent api -X PUT \
  "/zones/<zone-id>/applications/<proxy-application-id>/dependencies/<linear-resource-id>" \
  --org <org-id> -d '{}'
```

Verify the wiring landed:

```bash
keycard agent api \
  "/zones/<zone-id>/applications/<proxy-application-id>/dependencies" \
  --org <org-id>
```

The Linear resource MUST appear in the returned `items`. If it does not, abort:

```
Could not wire Linear as a dependency of the proxy application. Open
https://console.keycard.ai → Applications → <name> → Dependencies and
connect the Linear resource manually, then retry.
```

### 1g. Proxy application credentials + vault resources

This step issues application credentials for the proxy and copies them into zone-vault resources in a single local operation. The bundled script `scripts/provision-credentials.sh` keeps the credential material (`client_id`, `client_secret`) inside one shell process — the agent never reads or echoes those values, only the non-sensitive URNs that resolve them at runtime.

Before running the script, confirm a `keycard-vault` provider exists in the zone (`type = "keycard-vault"`). If there are several, ask the user which to use. Carry it forward as `<vault-provider-id>`. If the zone has no vault provider, abort:

```
This template requires a keycard-vault provider in the zone to broker
the proxy application credentials. Create one in
https://console.keycard.ai → Providers (type "Vault"), then retry.
```

Then invoke the script:

```bash
bash scripts/provision-credentials.sh \
  --zone "<zone-id>" \
  --org "<org-id>" \
  --app-id "<proxy-application-id>" \
  --vault-provider "<vault-provider-id>" \
  --name "<name>"
```

The script:
1. Issues credentials via `POST /zones/<zone-id>/application-credentials` with body `{"application_id":"<proxy-application-id>","type":"password"}`. The `password` credential type is what mints an OAuth `client_id` (`identifier`) + `client_secret` (`password`) pair. This route is on the zone, NOT nested under `/applications/<id>/`.
2. Validates the response contains `identifier` and `password` (without printing them).
3. Pipes each value through `jq` directly into a `POST /zones/<zone-id>/resources` call to create vault resources at `urn:<name>:client_id` (from `identifier`) and `urn:<name>:client_secret` (from `password`).
4. Wipes the in-memory credential variable and exits.

On failure, the script prints a remediation message pointing at the Keycard console. The agent MUST NOT attempt to recover by running the underlying `POST .../credentials` call itself — that would expose the credential payload in the tool-call transcript. The correct fallback is:

1. Tell the user to issue credentials in https://console.keycard.ai → Applications → `<name>` → Credentials.
2. Wait for them to confirm. The agent must NOT ask the user to paste the `client_id` / `client_secret` into chat.
3. Have the user export them in their own shell and run a tiny inline pipe so the secrets never enter the agent transcript:

   ```bash
   export PROXY_CLIENT_ID='...'      # user pastes in their terminal
   export PROXY_CLIENT_SECRET='...'  # user pastes in their terminal

   jq -n --arg n "<name>" --arg pid "<vault-provider-id>" --arg s "$PROXY_CLIENT_ID" '{
     name: ($n + "-client-id"),
     identifier: ("urn:" + $n + ":client_id"),
     description: ("Brokered client_id for the " + $n + " proxy application"),
     credential_provider_id: $pid,
     secret: $s
   }' | keycard agent api -X POST "/zones/<zone-id>/resources" --org "<org-id>" -d @-

   jq -n --arg n "<name>" --arg pid "<vault-provider-id>" --arg s "$PROXY_CLIENT_SECRET" '{
     name: ($n + "-client-secret"),
     identifier: ("urn:" + $n + ":client_secret"),
     description: ("Brokered client_secret for the " + $n + " proxy application"),
     credential_provider_id: $pid,
     secret: $s
   }' | keycard agent api -X POST "/zones/<zone-id>/resources" --org "<org-id>" -d @-

   unset PROXY_CLIENT_ID PROXY_CLIENT_SECRET
   ```

4. Resume at §3.

If the vault resources already exist, the script exits non-zero. To rotate, delete the existing vault resources first and re-run.

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

Write `.env` in the project root from `.env.example`:

```
KEYCARD_URL=https://<id>.keycard.cloud
PORT=<port>
```

`KEYCARD_URL` is read by the MCP server itself (the proxy needs it to call Keycard's STS). `package.json` loads `.env` via `node --env-file-if-exists=.env`, so no dotenv dependency is required.

`.env` MUST NOT contain `KEYCARD_CLIENT_ID` or `KEYCARD_CLIENT_SECRET` — those are brokered into the process by `keycard run` from the vault resources created in step 1g. Putting them here defeats the entire point of the template.

### keycard.toml

This template does NOT ship its own `keycard.toml`. Doing so would clobber the user's existing `keycard.toml` (which `keycard run` reads to discover the zone URL for authentication) — and `keycard.toml` does not perform `${ENV_VAR}` substitution, so a templated `[zone] url = "${KEYCARD_URL}"` line produces `failed to discover OIDC configuration: unsupported protocol scheme ""` at runtime.

Instead, the agent MUST **append** two `[[credentials.default]]` entries to the user's existing `keycard.toml` in the project working directory, using the `keycard-upsert-config` skill. Do not modify `[project]`, `[zone]`, or any other existing section. The two entries to append are:

```toml
[[credentials.default]]
env_var = "KEYCARD_CLIENT_ID"
resource = "urn:<name>:client_id"

[[credentials.default]]
env_var = "KEYCARD_CLIENT_SECRET"
resource = "urn:<name>:client_secret"
```

The URNs MUST match the vault resources created in step 1g exactly — substitute `<name>` for the kebab-case project name. If `keycard.toml` does not yet exist in the working directory, abort and tell the user to run `keycard init` (or otherwise establish a zone-bound `keycard.toml`) before retrying — without it, `keycard run` cannot authenticate.

If the user already has `[[credentials.default]]` entries with the same `env_var` names but different `resource` URNs, do not overwrite — surface the conflict to the user and stop.

## 3. Agent verification

The build step does not need brokered credentials, only the runtime does. Verify the build first, then verify `keycard run` can hydrate the env.

```bash
npm install && npm run build
```

Then a brokered smoke test:

```bash
keycard run -- node -e 'console.log("client_id len:", (process.env.KEYCARD_CLIENT_ID ?? "").length, "client_secret set:", Boolean(process.env.KEYCARD_CLIENT_SECRET))'
```

Both values MUST be non-empty. If either is empty, the most likely causes are:

- a `[[credentials.default]]` entry pointing at the wrong URN — re-check the `<name>` substitution in the appended block in the user's `keycard.toml`
- the matching vault resource does not exist, has the wrong identifier, or stores its secret under a field the vault provider does not surface as the token
- `keycard.toml` is missing or has no `[zone]` section — `keycard run` failed to authenticate, surfacing as `unsupported protocol scheme ""` from the OIDC discovery step

Do NOT start the proxy server inside the agent session — Claude Code does not hot-reload MCP config, and the proxy must be running in a long-lived terminal anyway. The user starts it themselves in step 5.

## 4. What the agent MUST NOT do

- Do not write `KEYCARD_CLIENT_ID` or `KEYCARD_CLIENT_SECRET` to `.env`, `keycard.toml`, source code, or any file. Their entire role in this template is to demonstrate broker-only secret delivery.
- Do not create a fresh `keycard.toml` or overwrite the user's existing one. The user's `keycard.toml` is the auth context for `keycard run`; the agent only **appends** the two `[[credentials.default]]` entries.
- Do not put `${KEYCARD_URL}` (or any `${...}` interpolation) inside `keycard.toml` — TOML does not expand env vars and the resulting empty string breaks `keycard run`'s OIDC discovery.
- Do not run the underlying `keycard agent api .../credentials` call yourself — always invoke `scripts/provision-credentials.sh`. The credential payload must not appear in any tool-call transcript.
- Do not commit `.env`, `KEYCARD_URL`, or anything containing the Keycard ID.
- Do not pick a `keycard-vault` provider for the **proxy** resource (1f) — vault providers cannot mint OAuth tokens for an MCP Resource.
- Do not pick a `keycard-sts` provider for the **vault** resources in 1g — STS providers do not store secret material.
- Do not start the proxy server in the agent session.
- Do not write Cedar or per-tool policy — v1 auth is OAuth scope-based (`mcp:tools`); per-tool authorization is out of scope.

## 5. Instructions for the user

After provisioning and verification, register the proxy in Claude's local MCP config so the user can call it after restarting Claude:

```bash
claude mcp remove <name> 2>/dev/null || true
claude mcp add --transport http <name> http://localhost:<port>/mcp
```

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

1. Start the MCP proxy in a SEPARATE terminal and leave it running:

     cd <name>
     keycard run -- npm start

   `keycard run` brokers KEYCARD_CLIENT_ID and KEYCARD_CLIENT_SECRET from
   the zone vault into the process environment. The proxy refuses to start
   without them — you should see the line:

     mcp-brokered-credentials-typescript listening on http://localhost:<port>
     Upstream: https://mcp.linear.app/mcp (brokered)

   Keep that terminal open.

2. Exit this Claude Code session and start a new one with Keycard:

     keycard run -- claude

   Claude only discovers MCP servers at startup, so a restart is required.

3. In the new Claude session, authenticate to the proxy:

     /mcp

   Pick "<name>" from the list and follow the OAuth flow. Keycard will
   prompt for Linear consent (because Linear is wired as a dependency of
   this resource) and then mint a bearer token scoped to mcp:tools.

4. Try it:

     - Ask Claude to call the proxy's `search` tool with a regex like
       "issue" — you should get back the matching subset of Linear's tool
       catalogue.
     - Ask Claude to call `execute` with a tool name from the search
       results and the appropriate arguments — the proxy will call Linear
       on your behalf using a brokered Linear token.
```
