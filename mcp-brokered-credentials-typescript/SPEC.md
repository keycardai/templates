# SPEC — mcp-brokered-credentials-typescript

> An MCP proxy that calls Linear's MCP server on your behalf — Keycard brokers a Linear-scoped OAuth token at call time via RFC 8693, so no Linear API key ever touches your config.

This template is an MCP **proxy** server: it exposes two tools (`search`, `execute`) that fan out to the official Linear MCP server at `https://mcp.linear.app/mcp`. The proxy authenticates to Linear using a token brokered by Keycard via RFC 8693 token exchange — the user's bearer token is exchanged for a Linear-scoped token at call time, no static API keys live in the server's config.

The agent (e.g. the `keycard-template-app` skill) MUST perform every step in this document before declaring the project ready. The `keycard run -- npm start` workflow at the end depends on every primitive being in place.

Throughout, treat `<name>` as the kebab-case project name (default: `mcp-brokered-credentials-typescript`) and `<port>` as the local HTTP port (default: `8000`).

## 0. How the agent uses this document

**This SPEC is input for the agent, not output for the user.** The `keycard-template-app` skill is the sole renderer of user-facing narration. Read this document, extract the structured data below (primitives, edits, port, build command, smoke tests, handoff commands), and reason from it — but never quote or print any of it verbatim. If a sentence here is jargon-heavy, terse, or implementation-focused, the skill paraphrases it before showing anything to the user. The user should never be able to tell which sentence came from this SPEC.

## 0a. What this template is

A proxy MCP server that sits between Claude and Linear's official MCP server. It exposes two tools — `search` (regex-search Linear's tool catalog) and `execute` (call any Linear tool by name) — and handles all the credential brokering automatically. When Claude calls one of these tools, the proxy exchanges the user's Keycard bearer token for a Linear-scoped OAuth token via RFC 8693 token exchange, then forwards the call to `https://mcp.linear.app/mcp` with that brokered token. No Linear API key is ever stored in config, `.env`, or source code — credentials are minted on the fly and scoped to the individual call.

This is the template to pick when you want to see Keycard's brokered-credential flow in action, or when you want a pattern for building proxies that fan out to other OAuth-protected MCP servers (swap out Linear's URL and the same plumbing works for any upstream that supports OAuth 2.1 + dynamic client registration).

## 0b. One-line summary (for the template picker)

MCP proxy to Linear with Keycard-brokered credentials — no API keys, just OAuth token exchange at call time.

## 0c. Concepts the agent should introduce

Introduce each concept **once**, the first time it appears during narration. Use the one-sentence framing below and include the docs link so the user can read more in a side tab.

| Order | Concept | First appears at | One-sentence framing | Docs |
|---|---|---|---|---|
| 1 | Zone | Step 3 (resolve context) | Your private Keycard environment that holds users, apps, and policies and issues credentials. | https://docs.keycard.ai/platform/concepts/zones/ |
| 2 | Organization | Step 3 (resolve context) | The account that owns one or more zones — usually your company or team. | https://docs.keycard.ai/platform/concepts/zones/ |
| 3 | OAuth provider | §1a (Linear provider) | A credential provider that can mint or broker OAuth tokens for a third-party service — here it handles the OAuth 2.1 + dynamic client registration flow that Linear's MCP server expects. | https://docs.keycard.ai/platform/concepts/providers/ |
| 4 | Application | §1b (Linear app) | A software actor registered with Keycard — the proxy and Linear each get one, so Keycard knows who is asking for credentials and who is granting them. | https://docs.keycard.ai/platform/concepts/applications/ |
| 5 | Resource | §1c (Linear resource) | The protected API your application calls — the resource identifier must match the URL exactly so Keycard's STS knows which tokens to issue. | https://docs.keycard.ai/platform/concepts/resources/ |
| 6 | Dependency / transitive consent | §1f-bis (wiring) | A declared relationship between applications that tells Keycard "when the user consents to my proxy, also surface consent for Linear" — so the user sees one consent screen instead of two. | https://docs.keycard.ai/platform/concepts/applications/#dependencies |
| 7 | STS provider | §1d (proxy provider) | The credential source built into every zone that mints OAuth access tokens for resources within the zone — it's what authenticates users to your proxy. | https://docs.keycard.ai/platform/concepts/providers/ |
| 8 | Vault provider | §1g (credentials) | A provider that stores static secrets (like the proxy's `client_id`/`client_secret`) and delivers them at runtime via `keycard run` — no secrets in files. | https://docs.keycard.ai/platform/concepts/providers/ |
| 9 | Application credentials | §1g (credentials) | The `client_id`/`client_secret` pair the proxy uses to authenticate its own token-exchange calls to Keycard's STS — stored in the vault, brokered into the process by `keycard run`. | https://docs.keycard.ai/platform/concepts/applications/ |
| 10 | OIDC issuer | §2 (KEYCARD_URL) | The URL apps use to discover Keycard's signing keys and token endpoints; for your zone it's `https://<zone-id>.<env-domain>`. | https://docs.keycard.ai/platform/architecture/standards-and-protocols/ |

## 1. Required Keycard primitives

The agent MUST ensure every primitive below exists in the active Keycard environment. Most calls are idempotent; on `409` ("already exists"), GET the list endpoint and reuse the existing record's ID.

Background reading on the domain model the steps below build:

- [Platform Concepts](https://docs.keycard.ai/platform/) — top-level overview
- [Zones](https://docs.keycard.ai/platform/concepts/zones/) — security domain that owns the STS, providers, applications, and resources used here
- [Providers](https://docs.keycard.ai/platform/concepts/providers/) — issue authentication and access credentials (used in 1a, 1d)
- [Applications](https://docs.keycard.ai/platform/concepts/applications/) — software actors that access resources (used in 1b, 1e)
- [Resources](https://docs.keycard.ai/platform/concepts/resources/) — protected APIs / MCP servers / databases (used in 1c, 1f)

### 1a. Linear credential provider

See [Providers](https://docs.keycard.ai/platform/concepts/providers/) for the concept; specifically the *access credential provider* role — these issue access tokens for resources hosted by third parties so credentials can be brokered between domains.

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

See [Applications](https://docs.keycard.ai/platform/concepts/applications/). The Linear application represents the upstream Linear MCP service as a Keycard application — it's what the user grants consent to during the dependency-driven OAuth flow.

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

See [Resources](https://docs.keycard.ai/platform/concepts/resources/). A resource is a protected API/MCP server/database that an application accesses; the proxy will request brokered tokens against this resource's identifier.

The resource identifier MUST be `https://mcp.linear.app/mcp` exactly — that is the URL the proxy hits, and Keycard's STS rejects token requests whose `resource` does not match the registered identifier.

```bash
keycard agent api -X POST /zones/<zone-id>/resources --org <org-id> -d '{
  "name": "linear",
  "identifier": "https://mcp.linear.app/mcp",
  "description": "Linear MCP server (upstream)",
  "application_id": "<linear-application-id>",
  "credential_provider_id": "<linear-provider-id>"
}'
```

Carry the result forward as `<linear-resource-id>`.

### 1d. STS provider for the proxy

See [Zones → Security Token Service](https://docs.keycard.ai/platform/concepts/zones/#security-token-service). Every zone has a built-in STS that mints access tokens for resources within the zone; the proxy resource (1f) uses it as its credential provider.

Discover the `keycard-sts` provider — same step as the base template:

```bash
keycard agent api /zones/<zone-id>/providers --org <org-id>
```

Pick the entry with `type = "keycard-sts"`. Do NOT pick a `keycard-vault` provider for the proxy resource — vault providers cannot mint OAuth tokens for an MCP Resource.

Carry the result forward as `<sts-provider-id>`.

### 1e. Proxy application

See [Applications](https://docs.keycard.ai/platform/concepts/applications/). This is the application that THIS server identifies as when it talks to Keycard's STS. Its client_id / client_secret are the credentials the proxy uses to authenticate the token-exchange call.

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

See [Resources](https://docs.keycard.ai/platform/concepts/resources/). The proxy registers itself as a resource at `http://localhost:<port>/mcp` so Keycard's STS will mint mcp-scoped tokens that authenticate users to the proxy.

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

See [Applications → Dependencies](https://docs.keycard.ai/platform/concepts/applications/#dependencies). Dependencies declare service-to-service relationships and drive the [transitive consent](https://docs.keycard.ai/platform/concepts/applications/#transitive-consent) flow — when the user authenticates to the proxy, Keycard surfaces Linear consent in the same screen because Linear is wired as a dependency here.

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

The template ships a minimal `keycard.toml` at the project root with only `[org]` and `[zone]` placeholder blocks:

```toml
[org]
id = "<org-id>"

[zone]
id = "<zone-id>"
```

The agent MUST replace both placeholder IDs with the values from the user's existing zone-bound `keycard.toml` (the one already present in the parent / cwd before scaffolding). If no such file exists, abort and tell the user to run `keycard init` first — without it, `keycard run` cannot authenticate.

Then the agent MUST append two `[[credentials.default]]` entries that match the vault resources created in step 1g:

```toml
[[credentials.default]]
env_var = "KEYCARD_CLIENT_ID"
resource = "urn:<name>:client_id"

[[credentials.default]]
env_var = "KEYCARD_CLIENT_SECRET"
resource = "urn:<name>:client_secret"
```

Substitute `<name>` for the kebab-case project name so the URNs line up exactly with what `provision-credentials.sh` created.

Use the `keycard-upsert-config` skill for these edits. Nothing else belongs in `keycard.toml` — no `[project]`, no `[server]`, no `schema_version`, no `[zone].url`. The MCP server reads its runtime config (`KEYCARD_URL`, `PORT`) from `.env`, not from `keycard.toml`. `KEYCARD_CLIENT_ID` / `KEYCARD_CLIENT_SECRET` are never written to either file — they are brokered from the vault by `keycard run`.

## 3. Runtime credential discovery

The proxy no longer hard-codes `ClientSecret` as the only credential provider. At startup, `src/credentials.ts` calls `discoverApplicationCredential()` which probes the environment and returns the first matching `ApplicationCredential`:

| Priority | Env signal | Provider | Typical environment |
|---|---|---|---|
| 1 | `KEYCARD_CLIENT_ID` + `KEYCARD_CLIENT_SECRET` both set | `ClientSecret` | Local via `keycard run` |
| 2 | `KEYCARD_APPLICATION_CREDENTIAL_TYPE` set | Depends on value (see below) | Explicit override on any platform |
| 3 | Any of `KEYCARD_EKS_WORKLOAD_IDENTITY_TOKEN_FILE`, `AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE`, `AWS_WEB_IDENTITY_TOKEN_FILE` | `EKSWorkloadIdentity` | EKS pods with mounted identity tokens |
| 4 | `FLY_APP_NAME` set | `FlyWorkloadIdentity` | Fly.io machines |
| 5 | _(none matched)_ | **throws** with actionable guidance | — |

### Explicit override via `KEYCARD_APPLICATION_CREDENTIAL_TYPE`

Set this env var to force a specific provider, bypassing auto-detection. Accepted values:

- `eks_workload_identity` — construct `EKSWorkloadIdentity` (honors `KEYCARD_EKS_WORKLOAD_IDENTITY_TOKEN_FILE` for custom token path).
- `fly_workload_identity` — construct `FlyWorkloadIdentity` with `audience` set to `KEYCARD_URL`.
- `web_identity` — construct `WebIdentity` (generates and persists an RSA key pair for `private_key_jwt` authentication).

Any other value throws.

### FlyWorkloadIdentity

`FlyWorkloadIdentity` implements the `ApplicationCredential` interface for Fly.io machines. On each token-exchange call it:

1. Reads the machine API token from `FLY_API_TOKEN` env var or `/.fly/api` file.
2. Fetches a short-lived OIDC JWT from `POST http://_api.internal:4280/v1/tokens/oidc` with `{ "aud": "<KEYCARD_URL>" }`.
3. Caches the token until 60 seconds before its `exp` claim.
4. Returns the OIDC token as a `client_assertion` (type `urn:ietf:params:oauth:client-assertion-type:jwt-bearer`), identical in shape to `EKSWorkloadIdentity`.

The deploy procedure (see `deploy-fly.md` §4–§5) registers the Fly OIDC provider and an application-credential binding (subject `<fly-org>:<project-name>:*`) so that Keycard's STS accepts the machine-issued OIDC token as valid proof of identity for the proxy application.

## 4. Agent verification

The build step does not need brokered credentials, only the runtime does. Verify the build first, then verify `keycard run` can hydrate the env.

```bash
npm install && npm run build
```

Then a non-interactive smoke test that the two vault resources exist and are wired to a `keycard-vault` provider. Do NOT use `keycard run -- node -e ...` here — `keycard run` requires an interactive TTY and refuses to nest inside the agent's own `keycard run` session, costing the agent minutes of debugging for no signal beyond what the API check below already gives. The actual brokered hydration is verified the first time the user runs `keycard run -- npm start` in §6.

```bash
for urn in "urn:<name>:client_id" "urn:<name>:client_secret"; do
  keycard agent api "/zones/<zone-id>/resources?identifier=${urn}" --org "<org-id>" \
    | jq -e --arg u "$urn" '.items[] | select(.identifier == $u) | .credential_provider_id' >/dev/null \
    || { echo "MISSING: $urn"; exit 1; }
done
echo "OK: both vault resources resolve"
```

Both lookups MUST succeed and return a non-null `credential_provider_id`. If either fails, the most likely causes are:

- the matching vault resource does not exist, has the wrong identifier, or `provision-credentials.sh` failed before attaching the secret via `POST /zones/<zone-id>/secrets`
- a `[[credentials.default]]` entry pointing at the wrong URN — re-check the `<name>` substitution in the appended blocks
- `keycard.toml` has unresolved `<org-id>` / `<zone-id>` placeholders, or is missing `[org]` / `[zone]` blocks entirely — `keycard run` will fail to authenticate when the user runs the proxy

Do NOT start the proxy server inside the agent session — Claude Code does not hot-reload MCP config, and the proxy must be running in a long-lived terminal anyway. The user starts it themselves in §6.

## 5. What the agent MUST NOT do

- Do not write `KEYCARD_CLIENT_ID` or `KEYCARD_CLIENT_SECRET` to `.env`, `keycard.toml`, source code, or any file. Their entire role in this template is to demonstrate broker-only secret delivery.
- Do not add `[project]`, `[server]`, `schema_version`, or any `[zone].url` field to `keycard.toml`. The shipped file is intentionally minimal — only `[org].id`, `[zone].id`, and the two `[[credentials.default]]` blocks belong there. Other server-side config goes in `.env`.
- Do not put `${KEYCARD_URL}` (or any `${...}` interpolation) anywhere in `keycard.toml` — TOML does not expand env vars.
- Do not modify the user's pre-existing `keycard.toml` outside the project directory. The project-local one is bootstrapped from it but lives independently.
- Do not run the underlying `keycard agent api .../credentials` call yourself — always invoke `scripts/provision-credentials.sh`. The credential payload must not appear in any tool-call transcript.
- Do not commit `.env`, `KEYCARD_URL`, or anything containing the Keycard ID.
- Do not pick a `keycard-vault` provider for the **proxy** resource (1f) — vault providers cannot mint OAuth tokens for an MCP Resource.
- Do not pick a `keycard-sts` provider for the **vault** resources in 1g — STS providers do not store secret material.
- Do not start the proxy server in the agent session.
- Do not write Cedar or per-tool policy — v1 auth is OAuth scope-based (`mcp:tools`); per-tool authorization is out of scope.
- Do not print SPEC phrasing such as "transitive consent", "RFC 8693", "client_assertion", "private_key_jwt", "STS provider", or "bearer token scoped to mcp:tools" in any user-facing message — translate to outcomes per §0c.

## 6. Handoff data (for the skill to render)

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

The skill renders the handoff from the following data. The agent extracts these values and passes them to the skill; the SPEC does not prescribe the user-facing wording.

| Key | Value | Run-where | Reason (plain outcomes) |
|---|---|---|---|
| `name` | `<name>` | — | Kebab-case project name used everywhere |
| `port` | `<port>` | — | Local HTTP port the proxy listens on |
| `build_command` | `npm install && npm run build` | this session | Compiles the project |
| `start_command` | `cd <name> && keycard run -- npm start` | their terminal (separate, keep open) | The wrapper hands the proxy a short-lived credential it needs to start; the proxy refuses to boot without it |
| `expected_ready_log` | `mcp-brokered-credentials-typescript listening on http://localhost:<port>` / `Upstream: https://mcp.linear.app/mcp (brokered)` | — | Signal to wait for before proceeding |
| `claude_register_command` | `claude mcp add --transport http <name> http://localhost:<port>/mcp` | this session (agent may execute) | Adds the proxy to Claude's MCP config |
| `restart_command` | `keycard run -- claude` | their terminal | Claude only discovers MCP servers at startup, so a restart is required |
| `auth_command` | `/mcp` → pick `<name>` | new agent session | Completes the OAuth flow; the first time, the user will see a Linear consent screen because this proxy depends on Linear |
| `try_it` | `search` with a regex like `issue`; `execute` with a tool name from the results | new agent session | Confirms the proxy can call Linear on the user's behalf using a brokered credential |

### Carried IDs for the recap

After §1 and §4, the agent has these values in hand: `<zone-id>`, `<linear-provider-id>`, `<linear-application-id>`, `<linear-resource-id>`, `<sts-provider-id>`, `<proxy-application-id>`, `<proxy-resource-id>`, `<vault-provider-id>`, and the verified vault URNs (`urn:<name>:client_id`, `urn:<name>:client_secret`). The skill renders them in its own voice — the SPEC does not supply a recap template. Point the user at `https://console.keycard.ai` for looking up any of the registered IDs.

## 7. What to say to the user (per-step narration)

The `keycard-template-app` skill prescribes the narration style; the lines below supply the template-specific *content*. The agent MUST paraphrase these into the skill's voice — never read them verbatim and never pass through protocol jargon such as "transitive consent", "RFC 8693", "STS provider", "bearer token scoped to mcp:tools", "client_assertion", or "private_key_jwt" in user-facing copy. Use the concept introductions in §0c for first-mention framing; after that, use plain outcome language.

| Step | Tell the user before you start |
|---|---|
| Step 4 (copy) | "Copying the `mcp-brokered-credentials-typescript` blueprint into `./<name>` — this gives you an MCP proxy that talks to Linear's MCP server using Keycard-brokered credentials. No Linear API key needed." |
| Step 6 (fill in) | "Filling in `.env` with your zone's OIDC issuer URL and a free local port. I'll also write `keycard.toml` with your zone/org IDs and two credential entries — those tell `keycard run` to broker the proxy's `client_id` and `client_secret` from the zone vault at startup." |
| Step 7 (register) | "This template needs more Keycard primitives than the basic server. I'm about to register: (1) an OAuth provider for Linear so Keycard can broker tokens to `mcp.linear.app`, (2) a Linear Application + Resource so Keycard knows what it's brokering, (3) your proxy's own Application + Resource backed by the zone's STS, (4) a dependency from the proxy to Linear so the user gets a single consent screen, and (5) application credentials stored in the zone vault. Each of these builds on the one before — I'll name what I get back after each step." |
| Step 8 (smoke-test) | "Building the project and verifying the two vault resources (`urn:<name>:client_id` and `urn:<name>:client_secret`) resolve correctly in the API. I'm not starting the server here — it needs `keycard run` to broker the secrets into the process, which can't nest inside the agent session. The actual end-to-end test happens when you run it yourself in the next step." |
| Step 9 (handoff) | "All the Keycard-side setup is done — your zone knows about both the proxy and Linear, and the vault has the proxy's credentials. The last bit has to happen in your terminal: start the proxy with `keycard run -- npm start`, restart Claude, and authenticate via `/mcp`. The first time you'll see a Linear consent screen because this proxy depends on Linear." |

## 8. Things to try once it's running

The agent SHOULD print these as concrete suggestions after the handoff recap, so the user knows what to do first:

1. **Search Linear's tool catalog.** Ask Claude: *"Use `search` with the pattern `issue`."* The proxy will list every Linear MCP tool whose name or description matches — you'll see tools like `list_issues`, `create_issue`, `update_issue`, etc., each with its full input schema.
2. **Execute a Linear tool.** Pick a tool name from the search results (e.g. `list_issues`) and ask Claude: *"Use `execute` to call `list_issues` with `{}`."* The proxy brokers a fresh Linear-scoped token and calls Linear on your behalf — no API key anywhere.
3. **Watch the consent flow.** The very first time you authenticate via `/mcp`, Keycard shows a consent screen that includes both the proxy *and* Linear (because Linear is wired as a dependency). On subsequent sessions, consent is remembered and the flow is instant.
4. **Inspect the brokering.** Check the proxy's terminal output — you'll see the token-exchange request to Keycard's STS each time `search` or `execute` is called. The brokered Linear token is never logged (by design), but you can see the exchange happening.

## 9. Where to extend

- **Swap the upstream.** The Linear MCP URL is defined in `src/upstream.ts` as `LINEAR_RESOURCE`. To proxy a different OAuth-MCP server (e.g. GitHub, Slack), change this constant and register the new upstream's provider/application/resource in Keycard following the same pattern as §1a–§1c.
- **Change what gets proxied.** `src/tools/search.ts` filters the upstream tool catalog by regex; `src/tools/execute.ts` forwards a single tool call. You can add tools that call multiple upstream tools, aggregate results, or transform the response before returning it.
- **Understand the token exchange.** `src/credentials.ts` handles credential discovery — it finds `KEYCARD_CLIENT_ID`/`KEYCARD_CLIENT_SECRET` (brokered by `keycard run`) and builds the `ApplicationCredential` used for RFC 8693 token exchange. `src/upstream.ts` then calls `authProvider.exchangeTokens(subjectToken, LINEAR_RESOURCE)` to get a Linear-scoped token per request. This is the core brokering pattern you'd reuse for any upstream.
- **Add a direct tool (no upstream).** You can also add tools that don't fan out — just create a file in `src/tools/` following the `hello` pattern from the base template. The proxy and direct tools coexist fine.

## 10. Common gotchas the agent should pre-empt

Smoke-test failure messages should be surfaced as verbatim tool/server output; any framing around them is the skill's voice, never quoted from this section.

When one of these fails, the agent SHOULD surface the matching diagnostic verbatim rather than printing a generic error.

1. **Vault provider vs. STS provider mix-up.** The proxy *resource* (§1f) MUST use the `keycard-sts` provider — it mints OAuth tokens for the `/mcp` endpoint. The vault *resources* in §1g MUST use a `keycard-vault` provider — they store the proxy's `client_id`/`client_secret`. Swapping them causes `invalid_target` on one side and "no secret material" on the other. Fix: check each resource's `credential_provider_id` in `https://console.keycard.ai → Resources`.

2. **Dependencies silently dropped on resource POST.** The `dependencies` field is only accepted via `PUT /applications/<app-id>/dependencies/<resource-id>` with an empty body. Passing `dependencies: [...]` on a resource or application POST/PATCH is silently ignored — the API returns 200 but the dependency is not created. Always use the dedicated PUT route (§1f-bis) and verify with the GET endpoint afterward.

3. **`keycard run` refusing to nest.** `keycard run` requires an interactive TTY and will not nest inside the agent's own `keycard run` session. Do NOT try to smoke-test with `keycard run -- npm start` from within the agent — use the API-based vault-resource check (§4) instead. The actual `keycard run` test happens when the user starts the proxy themselves.

4. **`${...}` interpolation in `keycard.toml`.** TOML does not expand environment variables. Never write `${KEYCARD_URL}` or any `${...}` syntax into `keycard.toml` — it will be treated as a literal string. Runtime config (`KEYCARD_URL`, `PORT`) goes in `.env`; `keycard.toml` only holds static IDs and credential-mapping entries.

5. **`KEYCARD_CLIENT_ID` or `KEYCARD_CLIENT_SECRET` written to `.env` or source code.** These secrets MUST only enter the process via `keycard run` brokering from the vault. Putting them in `.env` defeats the entire point of the template (demonstrating zero-static-secret credential delivery). If the proxy fails to start with "Could not discover application credentials", the user likely forgot `keycard run` — they ran `npm start` directly instead of `keycard run -- npm start`.

6. **Linear consent screen not appearing.** If the user authenticates via `/mcp` but never sees a Linear consent prompt, the dependency wiring (§1f-bis) is missing. Verify with `GET /zones/<zone-id>/applications/<proxy-application-id>/dependencies` — the Linear resource must appear in `items`. If not, re-run the PUT.

7. **`invalid_target` or `Requested authorization for unknown resource ...` on the proxy's own `/mcp`.** Same root cause as the base template — the Resource identifier must be `http://localhost:<port>/mcp` with the correct port and the `/mcp` suffix. Check the registered Resource in `https://console.keycard.ai → Resources`.

---

## Appendix A. SDK follow-up — credential discovery upstream

The `src/credentials.ts` file in this template is a stopgap. The discovery logic and `FlyWorkloadIdentity` class should move into the Keycard SDKs so every template and user app gets them automatically. This section tracks the required SDK changes.

### TypeScript (`@keycardai/oauth` + `@keycardai/mcp`)

**New file `packages/oauth/src/server/flyWorkloadIdentity.ts`**

Port the template-local `FlyWorkloadIdentity` class. Public API:

```typescript
export interface FlyWorkloadIdentityOptions {
  audience: string;
  metadataUrl?: string;   // default: http://_api.internal:4280/v1/tokens/oidc
  machineTokenEnv?: string; // default: FLY_API_TOKEN
}
export class FlyWorkloadIdentity implements ApplicationCredential { ... }
```

Mirrors `EKSWorkloadIdentity` in shape: `getAuth()` returns `null`, `prepareTokenExchangeRequest()` returns a `client_assertion` with type `jwt-bearer`.

**New file `packages/oauth/src/server/discover.ts`**

```typescript
export interface DiscoverOptions {
  serverName?: string;
  zoneUrl?: string;
}
export function discoverApplicationCredential(
  options?: DiscoverOptions
): ApplicationCredential;
```

Same priority as this template's `src/credentials.ts` and the Python SDK's `AuthProvider._discover_application_credential`.

**Re-exports**

- `packages/oauth/src/server/index.ts` — export `FlyWorkloadIdentity`, `FlyWorkloadIdentityOptions`, `discoverApplicationCredential`, `DiscoverOptions`.
- `packages/mcp/src/server/auth/credentials.ts` — re-export all of the above.

**AuthProvider opt-in**

Extend `AuthProvider` so that when `applicationCredential` is omitted it falls back to `discoverApplicationCredential()`, matching the Python SDK. This lets the template collapse to `new AuthProvider({ zoneUrl: KEYCARD_URL })`.

**Tests**

- Env-permutation table (local / EKS / Fly / explicit override / none-found).
- Stub Fly metadata server returning a signed JWT; verify token caching and refresh.

### Python (`keycardai-oauth` + `keycardai-mcp`)

**New class `FlyWorkloadIdentity`** in `packages/oauth/src/keycardai/oauth/server/credentials.py`, next to `EKSWorkloadIdentity`. Same constructor surface as the TS version.

**Extend `AuthProvider._discover_application_credential`** in `packages/mcp/src/keycardai/mcp/server/auth/provider.py`:

- Recognize `KEYCARD_APPLICATION_CREDENTIAL_TYPE=fly_workload_identity`.
- After the existing EKS auto-detect branch, add a `FLY_APP_NAME` auto-detect branch.

### Migration path

Once the TS SDK ships `discoverApplicationCredential` + `FlyWorkloadIdentity`:

1. This template's `src/credentials.ts` shrinks to re-exports.
2. `src/server.ts` can collapse to `new AuthProvider({ zoneUrl: KEYCARD_URL })` if the AuthProvider opt-in ships.
3. Bump `@keycardai/mcp` in `package.json` to the version containing the new exports.
