# SPEC — autonomous-agent-snowflake-wif

An autonomous **agent** that uses Keycard's public-key application credential flow to prove its identity. It generates an RSA keypair on first run, serves the public key at `/.well-known/jwks.json`, and authenticates to Keycard's STS using signed client assertion JWTs. The agent then authenticates to Snowflake via Workload Identity Federation (WIF/OIDC), obtaining an access token through Keycard's token exchange. It queries Snowflake and produces results autonomously. No static `client_secret` is ever written to disk, env, or config.

Pick this template to see Keycard's keypair-based application identity in action, or as a pattern for autonomous agents that need to authenticate to Snowflake without shared secrets.

The agent (e.g. the `keycard-template-app` skill) MUST perform every step in this document before declaring the project ready.

Throughout, treat `<name>` as the kebab-case project name (default: `autonomous-agent-snowflake-wif`), `<port>` as the local HTTP port (default: `9000`), and `<agent-base-url>` as the Tailscale Funnel public URL where this agent's well-known endpoints are reachable.

## 0. How the agent uses this document

**This SPEC is input for the agent, not output for the user.** The `keycard-template-app` skill is the sole renderer of user-facing narration. Read this document, extract the structured data below (primitives, edits, port, build command, smoke tests, handoff commands), and reason from it — but never quote or print any of it verbatim. If a sentence here is jargon-heavy, terse, or implementation-focused, the skill paraphrases it before showing anything to the user.

## 0c. Concepts the agent should introduce

Introduce each concept **once**, the first time it appears during narration. Use the one-sentence framing below and include the docs link so the user can read more in a side tab.

| Order | Concept | First appears at | One-sentence framing | Docs |
|---|---|---|---|---|
| 1 | Zone | Step 3 (resolve context) | Your private Keycard environment that holds users, apps, and policies and issues credentials. | https://docs.keycard.ai/platform/concepts/zones/ |
| 2 | Organization | Step 3 (resolve context) | The account that owns one or more zones — usually your company or team. | https://docs.keycard.ai/platform/concepts/zones/ |
| 3 | Application | §1a (agent application) | A software actor registered with Keycard — the agent gets one so Keycard knows who is asking for credentials. | https://docs.keycard.ai/platform/concepts/applications/ |
| 4 | Application Credential (public-key) | §1b (JWKS credential) | An application credential identified by the agent's OAuth Client ID Metadata Document URL — Keycard fetches the metadata document to discover the agent's public keys and verify its signed assertions, so no shared secret is ever exchanged. | https://docs.keycard.ai/platform/concepts/applications/ |
| 5 | Dependency | §1c (wiring) | A declared relationship that controls which resources an application can access — a simpler way to enforce access policy without writing policies directly. | https://docs.keycard.ai/platform/concepts/applications/#dependencies |
| 6 | Resource | §1c (wiring) | The protected API your application calls — the resource identifier must match exactly so Keycard's STS knows which tokens to issue. | https://docs.keycard.ai/platform/concepts/resources/ |
| 7 | Vault provider | §1d (Anthropic resource) | A provider that stores static secrets (like the Anthropic API key at `https://api.anthropic.com`) and delivers them at runtime via `keycard run` — no secrets in files. | https://docs.keycard.ai/platform/concepts/providers/ |
| 8 | Keycard issuer | §2 (KEYCARD_URL) | The URL apps use to discover Keycard's signing keys and token endpoints; for your zone it's `https://<zone-id>.<env-domain>`. | https://docs.keycard.ai/platform/architecture/standards-and-protocols/ |

## 0-prereq. Prerequisites

### 0a. Agent reachability

Keycard's STS must be able to fetch `<agent-base-url>/.well-known/oauth-client-metadata` (the Client ID Metadata Document) from the public internet to discover the agent's public keys and verify its signed client assertions. `localhost` does not work.

**Default to Tailscale Funnel** — do NOT ask the user to choose a reachability mode. This template always runs locally; deployment is a separate concern handled by the `keycard-deploy-app` skill if the user explicitly requests it.

1. **Check for existing Tailscale Funnel**: run `tailscale funnel status 2>/dev/null` — if it returns a funnel already serving on `<port>`, extract the public URL and use that as `<agent-base-url>`.
2. **Start a funnel**: if Tailscale is installed but no funnel is active on `<port>`, start one: `tailscale funnel --bg <port>` and extract the public URL.
3. **No Tailscale available**: abort with a clear message:

```
The agent needs a public URL so Keycard can fetch its public key.
Install Tailscale and enable Funnel (https://tailscale.com/kb/1223/funnel),
then retry.
```

### 0b. ANTHROPIC_API_KEY

The agent needs an LLM API key. **Auto-resolve from Keycard resources** — do NOT ask the user for the key or tell them to paste it into `.env`.

The Anthropic API is commonly registered as a Keycard resource with identifier `https://api.anthropic.com`. Look up available resources:

```bash
keycard agent api "/zones/<zone-id>/resources" --org <org-id>
```

Pick the entry whose `identifier` is `https://api.anthropic.com` (exact match preferred), or failing that, whose `identifier` or `name` contains `anthropic`. The resource should have a `credential_provider_id` — typically a `keycard-vault` provider that stores the API key.

- **Found**: carry forward `<anthropic-resource-identifier>` (e.g. `https://api.anthropic.com`). The key will be brokered into the agent's environment via `keycard.toml` + `keycard run` at startup. Do NOT write the key value to `.env` or any file.
- **Not found**: block provisioning and instruct the user to create the resource:
  1. Open https://console.keycard.ai → Resources → Create Resource.
  2. Set `name: anthropic-api`, `identifier: https://api.anthropic.com`, provider: a `keycard-vault` type provider in the zone, and paste the Anthropic API key as the secret.
  3. Once created, tell the agent to continue — no need to restart the session, the agent will pick up the new resource on the next API call.
  
  NEVER ask the user to paste the API key into the chat or any agent interaction — the key must only enter the system through the Keycard console.

### 0c. Snowflake account details

Ask the user to open the Snowflake console, go to **Admin → Accounts**, and copy-paste the account details. The agent needs:

- `SNOWFLAKE_ACCOUNT` — the account identifier shown in the Snowflake console (e.g. `ORGNAME-ACCTNAME`). This is the **Account** column value, not the account URL. (required)
- `SNOWFLAKE_DATABASE` — default database (optional, can be set later)
- `SNOWFLAKE_WAREHOUSE` — default warehouse (optional, can be set later)
- `SNOWFLAKE_ROLE` — Snowflake role to assume (optional, can be set later)

The `SNOWFLAKE_USER` defaults to `autonomous_agent` (the service user created in §1f). Do NOT ask the user for this — it is derived from the WIF setup.

## 1. Required Keycard primitives

The agent MUST ensure every primitive below exists in the active Keycard environment. Most calls are idempotent; on `409` ("already exists"), GET the list endpoint and reuse the existing record's ID.

Background reading on the domain model the steps below build:

- [Platform Concepts](https://docs.keycard.ai/platform/)
- [Applications](https://docs.keycard.ai/platform/concepts/applications/)
- [Resources](https://docs.keycard.ai/platform/concepts/resources/)

### 1a. Agent application

See [Applications](https://docs.keycard.ai/platform/concepts/applications/). This is the application that the agent identifies as when talking to Keycard's STS. The application `identifier` MUST be the URL of the agent's OAuth Client ID Metadata Document (`<agent-base-url>/.well-known/oauth-client-metadata`), per [draft-ietf-oauth-client-id-metadata-document](https://datatracker.ietf.org/doc/draft-ietf-oauth-client-id-metadata-document/). This URL is the agent's `client_id` — no shared secret.

```bash
keycard agent api -X POST /zones/<zone-id>/applications --org <org-id> -d '{
  "name": "<name>",
  "identifier": "<agent-base-url>/.well-known/oauth-client-metadata",
  "description": "Autonomous Snowflake WIF agent with public-key credential",
  "consent": "implicit"
}'
```

The `consent` enum is `required` | `implicit`. `"explicit"` is rejected with a validation error.

Carry the result forward as `<agent-application-id>`.

### 1b. Public-key application credential

Register the agent's public-key credential. The credential type is `"public-key"` — this tells Keycard's STS to fetch the agent's Client ID Metadata Document to discover the JWKS for verifying the agent's signed client assertion JWTs. The `identifier` field MUST be the metadata document URL (`<agent-base-url>/.well-known/oauth-client-metadata`) — this is the `client_id` that appears as the `iss` claim in the agent's JWT assertions. The `jwks_uri` field is the full URL to the JWKS endpoint.

```bash
keycard agent api -X POST /zones/<zone-id>/application-credentials --org <org-id> -d '{
  "application_id": "<agent-application-id>",
  "type": "public-key",
  "identifier": "<agent-base-url>/.well-known/oauth-client-metadata",
  "jwks_uri": "<agent-base-url>/.well-known/jwks.json"
}'
```

If the API rejects this shape, check the current schema by inspecting an existing `public-key` credential in the zone:

```bash
keycard agent api "/zones/<zone-id>/application-credentials" --org <org-id> \
  | jq '.items[] | select(.type == "public-key")'
```

If no `public-key` credentials exist and the POST fails, abort and ask the user to create the credential manually:

```
Could not auto-register the public-key application credential. Create it at
https://console.keycard.ai → Applications → <name> → Credentials with
type "public-key", identifier "<agent-base-url>/.well-known/oauth-client-metadata",
pointing at <agent-base-url>/.well-known/jwks.json, then retry.
```

Carry the result forward as `<agent-credential-id>`.

### 1c. Snowflake resource

The agent authenticates to Snowflake by exchanging its Keycard client assertion for an access token scoped to the `snowflakecomputing.com` resource. This resource MUST exist in the zone and MUST be configured with an STS credential provider so that Keycard can issue tokens for it.

Check if it already exists:

```bash
keycard agent api "/zones/<zone-id>/resources" --org <org-id> \
  | jq '.items[] | select(.identifier == "snowflakecomputing.com")'
```

If found, verify it has a `credential_provider_id` pointing at an STS-type provider. If `credential_provider_id` is `null` or missing, the resource must be updated (see below).

If not found, first resolve the STS provider in the zone:

```bash
keycard agent api "/zones/<zone-id>/credential-providers" --org <org-id> \
  | jq '.items[] | select(.type == "sts")'
```

Carry the STS provider's `id` forward as `<sts-provider-id>`. If no STS provider exists in the zone, abort:

```
No STS credential provider found in the zone. The Snowflake resource requires
an STS provider so Keycard can issue OIDC tokens for Workload Identity Federation.
Create an STS provider at https://console.keycard.ai → Providers, then retry.
```

Create the resource with the STS provider:

```bash
keycard agent api -X POST "/zones/<zone-id>/resources" --org <org-id> -d '{
  "name": "snowflake",
  "identifier": "snowflakecomputing.com",
  "description": "Snowflake data warehouse — WIF/OIDC access",
  "credential_provider_id": "<sts-provider-id>"
}'
```

If the resource already exists but is missing `credential_provider_id`, update it:

```bash
keycard agent api -X PATCH "/zones/<zone-id>/resources/<snowflake-resource-id>" \
  --org <org-id> -d '{
  "credential_provider_id": "<sts-provider-id>"
}'
```

**IMPORTANT**: The resource `identifier` MUST be exactly `snowflakecomputing.com` — no protocol prefix, no trailing slash, no account-specific URL. This identifier is what the agent passes as the `resource` parameter during token exchange, and it must match what Snowflake expects in the OIDC token's `aud` claim.

Carry forward `<snowflake-resource-id>`.

### 1d. Wire the Snowflake resource as a dependency

See [Applications → Dependencies](https://docs.keycard.ai/platform/concepts/applications/#dependencies). Dependencies control which resources an application can access — a way to enforce access policy without writing policies directly.

Dependencies live on the **application**, not the resource. Use `PUT /applications/<app-id>/dependencies/<resource-id>` with an empty JSON body (see gotcha 2 for why other routes silently fail).

```bash
keycard agent api -X PUT \
  "/zones/<zone-id>/applications/<agent-application-id>/dependencies/<snowflake-resource-id>" \
  --org <org-id> -d '{}'
```

Verify the wiring landed:

```bash
keycard agent api \
  "/zones/<zone-id>/applications/<agent-application-id>/dependencies" \
  --org <org-id>
```

The Snowflake resource MUST appear in the returned `items`. If it does not, abort:

```
Could not wire Snowflake as a dependency of the agent application. Open
https://console.keycard.ai → Applications → <name> → Dependencies and
connect the Snowflake resource manually, then retry.
```

### 1e. Anthropic API resource (conditional)

If §0b found an Anthropic resource (identifier `https://api.anthropic.com`) in the zone, this step is a no-op — the resource already exists and will be wired into `keycard.toml` in §2.

If §0b did NOT find one, the agent should create it. The Anthropic API resource follows the same pattern as any Keycard resource — it has an identifier (`https://api.anthropic.com`) and is backed by a credential provider that stores the actual API key.

1. Confirm a `keycard-vault` provider exists in the zone (`type = "keycard-vault"`). If there are several, use the same one other resources in the zone use. Carry it forward as `<vault-provider-id>`. If the zone has no vault provider, skip resource creation — fall back to `.env`.

2. Create the resource using a pipe pattern that keeps the key out of the agent transcript:

```bash
jq -n --arg s "$ANTHROPIC_API_KEY" '{
  name: "anthropic-api",
  identifier: "https://api.anthropic.com",
  description: "Anthropic API — brokered API key for LLM agents",
  credential_provider_id: "<vault-provider-id>",
  secret: $s
}' | keycard agent api -X POST "/zones/<zone-id>/resources" --org <org-id> -d @-
```

The agent MUST NOT read, echo, or log the API key value. If `ANTHROPIC_API_KEY` is not in the environment and cannot be piped safely, tell the user to create the resource manually:

```
The Anthropic API key is needed but not in the current environment. Create a
resource at https://console.keycard.ai → Resources with:
  name: anthropic-api
  identifier: https://api.anthropic.com
  provider: <vault-provider-name> (keycard-vault type)
  secret: <your Anthropic API key>
Then retry.
```

Carry forward `<anthropic-resource-identifier>` (i.e. `https://api.anthropic.com`).

### 1f. Snowflake WIF setup instructions

After provisioning the Keycard primitives, the agent MUST give the user instructions to configure Snowflake Workload Identity Federation. The Snowflake account admin must execute the following SQL in their Snowflake account to create a service user that trusts the agent's Keycard-issued OIDC tokens.

The agent MUST populate `<keycard-url>` and `<agent-application-id>` with the actual values from the user's zone so the user gets a working code example they can copy-paste directly.

- `ISSUER` = the Keycard zone URL (i.e. `<keycard-url>`, e.g. `https://xdw1camj3yeep8t4y8h1zduo62.keycard.cloud`)
- `SUBJECT` = the Keycard application ID (i.e. `<agent-application-id>`, e.g. `f0g84cj58valtvyz5iwcesqwx2`)

Present the following SQL to the user, with values filled in:

```sql
CREATE USER autonomous_agent
  WORKLOAD_IDENTITY = (
    TYPE = OIDC
    ISSUER = '<keycard-url>'
    SUBJECT = '<agent-application-id>'
  )
  TYPE = SERVICE;
```

Tell the user to:
1. Open a Snowflake worksheet (or use SnowSQL / the Snowflake CLI).
2. Execute the SQL above. The user's Snowflake admin will know what role and permissions to use — do NOT suggest `ACCOUNTADMIN` or any specific admin role. The agent MUST NOT advise on Snowflake permission management, role grants, or warehouse access — that is the Snowflake admin's domain and suggesting admin roles is a security risk.
3. Remind the user that `SNOWFLAKE_USER` in `.env` must match the Snowflake user name created here (default: `autonomous_agent`).

### 1g. Publish the JWKS URL (idempotent)

After the agent's well-known server is running, verify the JWKS is reachable (see §4 "JWKS reachability" for the check). Alternatively, use the bundled helper script:

```bash
bash scripts/publish-jwks.sh \
  --zone "<zone-id>" \
  --org "<org-id>" \
  --app-id "<agent-application-id>" \
  --jwks-url "<agent-base-url>/.well-known/jwks.json"
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

Write `.env` in the project root from `.env.example`:

```
AGENT_BASE_URL=<agent-base-url>
KEYCARD_URL=https://<id>.keycard.cloud
SNOWFLAKE_ACCOUNT=<snowflake-account>
SNOWFLAKE_USER=autonomous_agent
SNOWFLAKE_DATABASE=<snowflake-database>
SNOWFLAKE_WAREHOUSE=<snowflake-warehouse>
# SNOWFLAKE_ROLE=<snowflake-role>
AGENT_PROVIDER=anthropic
AGENT_MODEL=claude-sonnet-4-20250514
AGENT_TASK=Query Snowflake for recent data and produce a summary report.
PORT=<port>
```

`.env` MUST NOT contain `KEYCARD_CLIENT_ID` or `KEYCARD_CLIENT_SECRET` — the agent uses a public-key application credential (keypair + JWKS), not a shared secret.

`ANTHROPIC_API_KEY`: if brokered from vault (§1e), write only a comment `# ANTHROPIC_API_KEY — brokered from vault via keycard run`; if NOT brokered, write `# ANTHROPIC_API_KEY=<set before running>` and note in the handoff.

### keycard.toml

The template ships a minimal `keycard.toml` at the project root with only `[org]` and `[zone]` placeholder blocks:

```toml
[org]
id = "<org-id>"

[zone]
id = "<zone-id>"
```

The agent MUST replace both placeholder IDs with the values from the user's existing zone-bound `keycard.toml` (the one already present in the parent / cwd before scaffolding). If no such file exists, abort and tell the user to run `keycard init` first — without it, `keycard run` cannot authenticate.

**Anthropic API key brokering (conditional)**: if §1e resolved a vault resource for the Anthropic key, append a single `[[credentials.default]]` entry:

```toml
[[credentials.default]]
env_var = "ANTHROPIC_API_KEY"
resource = "<anthropic-resource-identifier>"
```

Substitute `<anthropic-resource-identifier>` for the exact resource identifier (e.g. `https://api.anthropic.com`). This tells `keycard run` to fetch the secret from the vault-backed resource and inject it as `ANTHROPIC_API_KEY` into the agent's process environment at startup.

Use the `keycard-upsert-config` skill for these edits. Nothing else belongs in `keycard.toml` — no `[project]`, no `[server]`, no `schema_version`, no `[zone].url`. See gotchas 3 and 4 for common mistakes with this file.

## 3. Runtime credential discovery

At startup, `src/index.ts` calls `bootstrapIdentity()` which generates or loads an RSA keypair from `AGENT_KEYS_DIR` (default: `./agent_keys`). The keypair is stored as `<key-id>.pem` (private key) and `<key-id>.json` (public key metadata), where `<key-id>` defaults to the constant `AGENT_NAME` in `src/identity.ts`.

**Known issue**: the `AGENT_NAME` constant in `src/identity.ts` is hardcoded to `"autonomous-agent-snowflake-wif"` regardless of the project name. When scaffolding a project with a different `<name>`, update this constant to match:

```typescript
const AGENT_NAME = "<name>";
```

The agent then starts an Express server that serves two identity endpoints:
- `GET /.well-known/jwks.json` — the agent's public key (JWKS)
- `GET /.well-known/oauth-client-metadata` — the OAuth Client ID Metadata Document per [draft-ietf-oauth-client-id-metadata-document](https://datatracker.ietf.org/doc/draft-ietf-oauth-client-id-metadata-document/)

The metadata document URL (`<agent-base-url>/.well-known/oauth-client-metadata`) is the agent's `client_id`. The document contains `client_id`, `client_name`, `token_endpoint_auth_method: "private_key_jwt"`, `grant_types`, and the inline `jwks`. The STS fetches this document to discover the agent's public keys.

When authenticating to Snowflake, `src/tokenProvider.ts` uses a `KeycardTokenProvider` that signs a client assertion JWT and exchanges it at the Keycard STS for an access token scoped to the `snowflakecomputing.com` resource. The authentication flow:

| Step | What happens | Where |
|---|---|---|
| 1 | Agent signs a client assertion JWT (`iss` = metadata document URL) with its private key | `WebIdentity` |
| 2 | Agent sends the assertion as both subject and client credential to Keycard STS | `tokenProvider.ts` |
| 3 | Keycard STS fetches `<agent-base-url>/.well-known/oauth-client-metadata` to discover the agent's JWKS and verify the assertion | Keycard STS |
| 4 | STS returns an access token scoped to `snowflakecomputing.com` | Keycard STS |
| 5 | Agent connects to Snowflake using the OIDC access token via Workload Identity Federation | `snowflake.ts` |
| 6 | Snowflake validates the OIDC token (issuer + subject match the WIF user config) | Snowflake |

There is no user/subject token in this flow — the agent authenticates purely with its own client assertion. The agent IS the subject.

## 4. Agent verification

The build step does not need brokered credentials, only the runtime does. Verify the build first, then verify the Keycard primitives are correctly registered.

### Build

```bash
npm install && npm run build
```

### Identity check

Verify the keypair was generated:

```bash
ls -la agent_keys/
```

Should contain `<key-id>.pem` (private key) and `<key-id>.json` (public key metadata). If the directory does not exist, the build succeeded but the identity has not been bootstrapped yet — it generates on first `npm start`.

### Application credential check

```bash
keycard agent api \
  "/zones/<zone-id>/application-credentials?application_id=<agent-application-id>" \
  --org <org-id> \
  | jq -e '.items[] | select(.type == "public-key")'
```

Must return an entry with `identifier` set to `<agent-base-url>/.well-known/oauth-client-metadata` and the agent's JWKS URL in the `jwks_uri` field.

### Dependency check

```bash
keycard agent api \
  "/zones/<zone-id>/applications/<agent-application-id>/dependencies" \
  --org <org-id> \
  | jq -e '.items[] | select(.identifier == "snowflakecomputing.com")'
```

Must return the Snowflake resource. If it does not, the dependency wiring (§1d) is missing.

### Anthropic resource check (conditional)

If §1e created or found the Anthropic resource:

```bash
keycard agent api "/zones/<zone-id>/resources?identifier=https://api.anthropic.com" --org "<org-id>" \
  | jq -e '.items[] | select(.credential_provider_id != null)'
```

Must return a resource with a non-null `credential_provider_id` pointing at a `keycard-vault` provider.

### Snowflake resource check

```bash
keycard agent api "/zones/<zone-id>/resources?identifier=snowflakecomputing.com" --org "<org-id>" \
  | jq -e '.items[0]'
```

Must return a resource with `identifier: "snowflakecomputing.com"`.

### Client metadata and JWKS reachability

Verify the metadata document and JWKS endpoint are reachable from a separate terminal:

```bash
curl -sf "<agent-base-url>/.well-known/oauth-client-metadata" | jq '.client_id'
curl -sf "<agent-base-url>/.well-known/jwks.json" | jq '.keys | length'
```

The first must return `"<agent-base-url>/.well-known/oauth-client-metadata"` (the agent's `client_id`). The second must return `1` or more.

Do NOT start the agent server inside the agent session (see gotcha 5). The user starts it themselves in §6.

## 5. Agent guardrails

Quick-reference prohibitions. §10 has diagnostics for the ones that commonly go wrong at runtime.

- Do not write `KEYCARD_CLIENT_ID` or `KEYCARD_CLIENT_SECRET` to `.env`, `keycard.toml`, source code, or any file — this template uses a public-key credential, not vault-brokered application secrets. The ONLY `[[credentials.default]]` block allowed is for `ANTHROPIC_API_KEY` (§1e).
- Do not issue a `password` credential for this application — public-key credentials only.
- Do not modify the user's pre-existing `keycard.toml` outside the project directory.
- Do not commit `.env`, `agent_keys/`, or anything containing the Keycard ID or private key material.
- Do not start the agent inside the provisioning session (see §10 gotcha 5).
- Do not write Cedar or per-tool policy — v1 auth is OAuth scope-based; per-tool authorization is out of scope.
- Do not print SPEC phrasing such as "public-key credential", "client_assertion", "JWKS", "RFC 7523", "private_key_jwt", "STS provider", or "transitive consent" in any user-facing message — translate to outcomes per §0c.
- Do not ask the user about deployment or the Anthropic API key — auto-resolve per §0a, §0b.
- Do not echo, log, or include the Anthropic API key value in any tool-call transcript.
- Do not suggest `ACCOUNTADMIN`, `SYSADMIN`, `SECURITYADMIN`, or any specific Snowflake admin role in SQL examples, handoff instructions, or narration. Do not advise on Snowflake role grants, warehouse access, or permission management — that is the Snowflake admin's responsibility. Only present the `CREATE USER` SQL from §1f.

## 6. Handoff data (for the skill to render)

The skill renders the handoff from the following data. The agent extracts these values and passes them to the skill; the SPEC does not prescribe the user-facing wording.

| Key | Value | Run-where | Reason (plain outcomes) |
|---|---|---|---|
| `name` | `<name>` | — | Kebab-case project name |
| `port` | `<port>` | — | Local HTTP port the agent listens on |
| `snowflake_setup` | Snowflake admin must execute the `CREATE USER` SQL from §1f | their Snowflake worksheet | Creates the WIF service user that trusts the agent's Keycard-issued tokens |
| `reachability_command` | `tailscale funnel --bg <port>` | their terminal | Exposes the agent on the public internet so Keycard can fetch its public key |
| `start_command` | `cd <name> && keycard run -- npm start` | their terminal | Starts the agent with its public URL set; `keycard run` brokers the Anthropic key from vault if configured |
| `build_command` | `npm install && npm run build` | this session | Compiles the project |
| `anthropic_key_status` | `vault-brokered` (if §1e resolved) or `manual` (user must set in .env) | — | Whether the LLM key is managed by Keycard |

### Expected behavior once started

The agent will: boot its identity (generate or load its keypair and serve the public key), authenticate to Snowflake via Keycard WIF/OIDC token exchange, accept A2A requests, query Snowflake, and produce results.

### Carried IDs for the recap

After §1 and §4, the agent has these values in hand: `<zone-id>`, `<agent-application-id>`, `<agent-credential-id>`, `<snowflake-resource-id>`, `<agent-base-url>`, and `<anthropic-resource-identifier>` (typically `https://api.anthropic.com`, if applicable). The skill renders them in its own voice — the SPEC does not supply a recap template. Point the user at `https://console.keycard.ai` for looking up any of the registered IDs.

## 7. What to say to the user (per-step narration)

The `keycard-template-app` skill prescribes the narration style; the lines below supply the template-specific *content*. Paraphrase into the skill's voice — never read verbatim, and follow the jargon prohibition in §5. Use §0c for first-mention framing; after that, use plain outcome language.

| Step | Tell the user before you start |
|---|---|
| Step 4 (copy) | "Copying the `autonomous-agent-snowflake-wif` blueprint into `./<name>` — this gives you an autonomous agent that queries Snowflake via Workload Identity Federation, authenticating with a locally-generated keypair instead of a shared secret." |
| Step 6 (fill in) | "Filling in `.env` with your zone's issuer URL, Snowflake account details, and the agent's public URL. I'll also write `keycard.toml` with your zone/org IDs. If your zone has an Anthropic API key in the vault, I'll wire that in too so the LLM key is brokered at startup — no key in any file." |
| Step 7 (register) | "I need to register a couple of things in Keycard: (1) an application for the agent so Keycard knows who it is, (2) a credential entry pointing at the agent's public key URL so Keycard can verify its signed requests, (3) a Snowflake resource so Keycard knows what the agent is accessing, and (4) a dependency from the agent to Snowflake — that's what gives the agent permission to request Snowflake tokens. Each step builds on the previous one." |
| Step 7b (Snowflake WIF) | "Now you need to configure Snowflake to trust tokens from your Keycard zone. I'll give you the exact SQL to run — it creates a service user with Workload Identity Federation that matches this agent's identity." |
| Step 8 (smoke-test) | "Building the project and checking that the Keycard application and credential are correctly registered. I'm not starting the agent here — it needs the public key endpoint reachable, which happens when you run it yourself." |
| Step 9 (handoff) | "All the Keycard-side setup is done — your zone knows about the agent application, trusts its public key, and has the Snowflake resource registered. Make sure you've run the Snowflake SQL to create the WIF user, then start the agent." |

## 8. Things to try once it's running

The agent SHOULD print these as concrete suggestions after the handoff recap, so the user knows what to do first:

1. **Watch the agent work.** Start the agent and observe the terminal — it authenticates to Snowflake via WIF, runs queries, and prints a summary. The whole loop runs autonomously.
2. **Change the task.** Edit `AGENT_TASK` in `.env` to a different Snowflake query (e.g. "Find all orders from last week and summarize revenue by region") and restart. The agent adapts to whatever task you give it.
3. **Watch the auth flow.** The agent's startup logs show: identity bootstrap → JWKS serving → Snowflake WIF connection. The logs will confirm a successful OIDC token exchange and Snowflake connection.
4. **Inspect the keypair.** Run `cat agent_keys/<key-id>.json` to see the public key metadata. The private key (`<key-id>.pem`) never leaves the agent's machine.

## 9. Where to extend

- **Query different data.** Change `AGENT_TASK` in `.env` to any Snowflake query task — the agent adapts to whatever you describe.
- **Change the LLM.** Set `AGENT_PROVIDER` and `AGENT_MODEL` in `.env`. The agent uses `pi-ai`'s model registry, which supports Anthropic, OpenAI, Google, Mistral, and others.
- **Customize the system prompt.** Edit `src/agent.ts` — the `DEFAULT_SYSTEM_PROMPT` tells the LLM how to query Snowflake. Tailor it for different workflows (e.g. data analysis, report generation, anomaly detection).
- **Deploy to a hosting provider.** When you're ready to run 24/7, use the `keycard-deploy-app` skill to deploy. The template ships `Dockerfile`, `fly.toml`, and `.dockerignore` for Fly.io out of the box.
- **Broker more secrets.** Add additional `[[credentials.default]]` entries in `keycard.toml` to broker other vault-stored secrets (e.g. API keys for other providers). Each entry maps a vault resource URN to an env var.

## 10. Common gotchas the agent should pre-empt

When one of these fails, surface the matching diagnostic verbatim rather than printing a generic error. Any framing around diagnostics is the skill's voice, never quoted from this section.

1. **Credential type is `public-key`, not `jwks_uri`.** The application credential POST requires `"type": "public-key"` with both `identifier` (the application's base URL) and `jwks_uri` (the full JWKS endpoint URL). Using `"type": "jwks_uri"` will fail with a validation error about missing `provider_id`. If you see this error, switch to `"type": "public-key"`.

2. **Dependencies silently dropped on resource POST.** The `dependencies` field is only accepted via `PUT /applications/<app-id>/dependencies/<resource-id>` with an empty body. Passing `dependencies: [...]` on a resource or application POST/PATCH is silently ignored — the API returns 200 but the dependency is not created. Always use the dedicated PUT route (§1d) and verify with the GET endpoint afterward.

3. **`${...}` interpolation in `keycard.toml`.** TOML does not expand environment variables. Never write `${KEYCARD_URL}` or any `${...}` syntax into `keycard.toml` — it will be treated as a literal string. Runtime config (`KEYCARD_URL`, `PORT`, `AGENT_BASE_URL`) goes in `.env`; `keycard.toml` only holds static IDs and credential-mapping entries.

4. **Wrong `[[credentials.default]]` blocks.** See §5 — the only allowed entry is for `ANTHROPIC_API_KEY`. Adding `KEYCARD_CLIENT_ID` or `KEYCARD_CLIENT_SECRET` entries is wrong — this agent uses a public-key credential, not shared secrets.

5. **`keycard run` refusing to nest.** `keycard run` requires an interactive TTY and will not nest inside the agent's own session. Use the API-based checks (§4) instead — the actual runtime test happens when the user starts the agent themselves.

6. **Snowflake connection refused or auth error.** If the agent starts but fails at "Connecting to Snowflake via Keycard WIF", check: (a) the Snowflake WIF user was created with the correct `ISSUER` and `SUBJECT` values (§1f), (b) the `SNOWFLAKE_ACCOUNT` in `.env` is correct, (c) the Snowflake user has been granted appropriate roles and warehouse access.

7. **`invalid_target` or `Requested authorization for unknown resource ...`.** The resource identifier registered in Keycard must be exactly `snowflakecomputing.com`. If you registered something different (e.g. with a protocol prefix or account-specific URL), delete it and re-create with the exact identifier.

8. **Missing `ANTHROPIC_API_KEY` at runtime.** The agent will fail at the LLM call step with a provider-specific auth error. If the key is vault-brokered, ensure `keycard run` is wrapping the start command so the secret is injected. If not vault-brokered, ensure it is set in `.env` or the user's shell environment.

9. **JWKS not reachable.** `curl -sf "<agent-base-url>/.well-known/jwks.json"` returns nothing or an error. The agent's Express server must be running and the Tailscale Funnel must be active. Fix: check `tailscale funnel status`.

10. **Agent keypair named after template default, not project name.** The `AGENT_NAME` constant in `src/identity.ts` defaults to `"autonomous-agent-snowflake-wif"`. If the project was renamed to `<name>`, the keypair files will still use the old name. This is cosmetic (the keys work fine) but confusing. Update the constant if the name was changed (see §3).

11. **Snowflake resource missing STS provider — `500 Internal Server Error` on token exchange.** If the `snowflakecomputing.com` resource exists but has no `credential_provider_id` pointing at an STS-type provider, Keycard's STS cannot issue tokens for it and returns a generic 500. Fix: find the STS provider in the zone (`keycard agent api "/zones/<zone-id>/credential-providers" --org <org-id> | jq '.items[] | select(.type == "sts")'`) and PATCH the resource to set `credential_provider_id`.

12. **Snowflake WIF user ISSUER/SUBJECT mismatch.** The `ISSUER` in the Snowflake `CREATE USER` statement must exactly match the Keycard zone URL (`<keycard-url>`), and the `SUBJECT` must exactly match the Keycard application ID (`<agent-application-id>`). If either is wrong, Snowflake will reject the OIDC token with an authentication error. Fix: `ALTER USER autonomous_agent SET WORKLOAD_IDENTITY = (TYPE = OIDC ISSUER = '<correct-keycard-url>' SUBJECT = '<correct-app-id>');`.
