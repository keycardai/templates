# SPEC — cross-cloud-agent-identity-python

> MCP server with scope-gated Snowflake access via three identity patterns — delegation, impersonation, and agent-identity — deployed identically to Vercel and Fly.io.

One Python codebase produces an MCP server with three tools (`delegate`, `impersonate`, `agent-identity`) that each connect to Snowflake via a different Keycard identity flow. A single Keycard application has two workload identity credentials (Vercel OIDC, Fly OIDC) so the same code runs on both platforms. Per-tool access control is enforced by scopes on the caller's MCP token (`snowflake:delegate`, `snowflake:impersonate`, `snowflake:agent-identity`). An internal Claude agent loop (via OpenAI SDK compatibility) uses identity-first dynamic discovery — it connects, resolves its identity and role grants, then enumerates only the databases/schemas it can actually access. MCP tool callers can optionally pass `database`, `schema`, and `role` parameters to narrow scope per-call.

Pick this template to see Keycard's scope-based authorization and three Snowflake identity patterns side-by-side, or as a starting point for MCP servers that need fine-grained tool-level access control.

The agent MUST perform every step in this document before declaring the project ready.

Throughout, treat `<name>` as the kebab-case project name (default: `cross-cloud-agent-identity-python`) and `<port>` as the local HTTP port (default: `8050`).

## 0. How the agent uses this document

**This SPEC is input for the agent, not output for the user.** Read this document, extract structured data, and reason from it — never quote or print it verbatim.

## 0c. Concepts the agent should introduce

| Order | Concept | First appears at | One-sentence framing | Docs |
|---|---|---|---|---|
| 1 | Zone | §0-prereq | Your private Keycard environment that holds users, apps, and policies and issues credentials. | https://docs.keycard.ai/concepts/zones/ |
| 2 | Organization | §0-prereq | The account that owns one or more zones. | https://docs.keycard.ai/concepts/zones/ |
| 3 | Application | §1a | A software actor registered with Keycard — this demo has one application deployed to two platforms. | https://docs.keycard.ai/concepts/applications/ |
| 4 | Application credential (workload identity) | §1c | A binding between a cloud platform's OIDC issuer and a Keycard application — no shared secret needed. | https://docs.keycard.ai/concepts/applications/#credentials |
| 5 | Vault provider | §0b | A provider that stores static secrets and delivers them at runtime via `keycard run`. | https://docs.keycard.ai/concepts/providers/ |
| 6 | OIDC provider | §1b | A trusted identity provider Keycard's STS uses to verify client assertions. | https://docs.keycard.ai/concepts/providers/ |
| 7 | OAuth provider (Snowflake) | §1g | A provider that holds Snowflake OAuth client credentials so Keycard can exchange tokens on behalf of users. | https://docs.keycard.ai/concepts/providers/ |
| 8 | Resource | §1d | The protected API your application calls — the resource identifier must match exactly. | https://docs.keycard.ai/concepts/resources/ |
| 9 | Dependency | §1e | A declared relationship controlling which resources an application can access. | https://docs.keycard.ai/concepts/applications/#dependencies |
| 10 | Scope | §1f | A permission string on the MCP access token that gates which tools the caller can invoke. | https://docs.keycard.ai/reference/security-architecture/ |
| 11 | Policy set | §1h | A versioned bundle of Cedar policies that Keycard evaluates for every authorization request in the zone. | https://docs.keycard.ai/console/access-policies |

## 0-prereq. Prerequisites

### 0a. Vault provider

Confirm a `keycard-vault` provider exists in the zone. Carry forward as `<vault-provider-id>`.

### 0b. Anthropic resource

Auto-resolve from existing zone resources — pick the entry whose `identifier` is `https://api.anthropic.com`. Carry forward as `<anthropic-resource-id>` and its identifier as `<anthropic-resource-identifier>`. If none exists, ask the user to create it.

### 0c. Snowflake and platform details

Auto-discover what you can from local config and CLIs before prompting the user. Only ask for values that cannot be resolved.

| Name | Discovery | Fallback |
|---|---|---|
| `<fly-app>` | Read `fly.toml` → `app` field. | Ask user. |
| `<fly-org>` | Run `fly orgs list` and pick the personal org, or the only org. If ambiguous, ask the user to choose. | Ask user. |
| `<vercel-team-slug>` | Run `vercel teams ls` (or inspect `.vercel/project.json` if present). If one team, use it. If ambiguous, ask the user to choose. | Ask user. |
| `<vercel-project>` | Run `vercel projects ls` or inspect `.vercel/project.json`. | Ask user. |
| `<snowflake-account>` | Check `SNOWFLAKE_ACCOUNT` env var. | Ask user (e.g. `ORGNAME-ACCTNAME`). |
| `<snowflake-warehouse>` | Check `SNOWFLAKE_WAREHOUSE` env var. Defaults to `COMPUTE_WH`. | Optional; default `COMPUTE_WH`. |
| `<snowflake-database>` | Check `SNOWFLAKE_DATABASE` env var. | Optional — agent discovers accessible databases dynamically via `SHOW GRANTS TO ROLE`. |
| `<snowflake-schema>` | Check `SNOWFLAKE_SCHEMA` env var. | Optional — agent discovers accessible schemas dynamically. |
| `<snowflake-role>` | Check `SNOWFLAKE_ROLE` env var. | Optional — agent uses auto-activated role. Set when multiple roles are granted. |

**Dynamic discovery:** The agent connects with its WIF identity, runs `CURRENT_USER()` / `CURRENT_ROLE()` / `SHOW GRANTS TO ROLE` to discover its accessible databases and schemas without pre-configuration. `SNOWFLAKE_DATABASE`, `SNOWFLAKE_SCHEMA`, and `SNOWFLAKE_ROLE` are optional hints that narrow the discovery scope. MCP tool callers can also pass `database`, `schema`, and `role` parameters per-call to override defaults.

Confirm discovered values with the user before proceeding.

## 1. Required Keycard primitives

Resolve exact endpoints and payload shape from the Keycard Management API reference — only identity-defining fields are pinned here. On `409`, reuse the existing record.

### 1a. Application (single, two deployment URLs)

| Field | Value |
|---|---|
| `identifier` | `https://<name>.<zone-id>.keycard.cloud` |

Carry forward as `<application-id>`. The identifier is a zone-scoped logical name — it does not need to resolve as a URL. The same application serves both Vercel and Fly deployments.

### 1b. OIDC providers (Vercel, Fly)

| Provider | `identifier` | Carry forward as |
|---|---|---|
| Vercel OIDC | `https://oidc.vercel.com/<vercel-team-slug>` | `<vercel-oidc-provider-id>` |
| Fly OIDC | `https://oidc.fly.io/<fly-org>` | `<fly-oidc-provider-id>` |

Reuse existing if a provider with the same identifier already exists.

For the correct OIDC provider creation payload (including `protocols.oauth2.issuer`), consult the `keycard-deploy-app` skill's provider-specific reference documents (resolve via the skill's supported-providers table).

Resolve the zone's STS credential provider and carry forward as `<sts-provider-id>`.

### 1c. Workload identity credentials (two bindings, one application)

| `provider_id` | `identifier` (matches `sub` claim) |
|---|---|
| `<vercel-oidc-provider-id>` | `owner:<vercel-team-slug>:project:<vercel-project>:environment:production` |
| `<fly-oidc-provider-id>` | `<fly-org>:<fly-app>:` |

Both credentials are bound to `<application-id>`. The application credential type is `token` (not `workload-identity`), with a `subject` field matching the platform's OIDC `sub` claim format. Consult the `keycard-deploy-app` skill's provider-specific reference documents for the exact payload schema.

### 1d. Resources

Agent API resources (one per deployment, plus local dev). The `identifier` must match the URL MCP clients connect to — including the `/mcp` path where the streamable HTTP transport is mounted. Each deployment's `SERVER_URL` env var and its `/.well-known/oauth-protected-resource` `resource` field **must** equal the corresponding resource `identifier` below:

| `application_id` | `identifier` | `credential_provider_id` | Carry forward as |
|---|---|---|---|
| `<application-id>` | `https://<vercel-project>.vercel.app/mcp` | `<default-provider-id>` | `<vercel-mcp-resource-id>` |
| `<application-id>` | `https://<fly-app>.fly.dev/mcp` | `<default-provider-id>` | `<fly-mcp-resource-id>` |
| `<application-id>` | `http://localhost:<port>/mcp` | `<default-provider-id>` | `<local-mcp-resource-id>` |

Snowflake WIF resource:

| `identifier` | `credential_provider_id` | Carry forward as |
|---|---|---|
| `snowflakecomputing.com` | `<sts-provider-id>` | `<snowflake-resource-id>` |

Vault resources (for local dev fallback):

| `identifier` | `credential_provider_id` |
|---|---|
| `urn:<name>:client_id` | `<vault-provider-id>` |
| `urn:<name>:client_secret` | `<vault-provider-id>` |

Created by `scripts/provision-credentials.sh` — verify rather than re-create.

### 1e. Dependencies

| From application | To resource | Resulting access |
|---|---|---|
| `<application-id>` | `<snowflake-resource-id>` | Application may obtain Snowflake WIF tokens. |
| `<application-id>` | `<anthropic-resource-id>` | Application may fetch Anthropic key at runtime. |

### 1f. Scope reference (no resource-level configuration needed)

The following scope strings appear in Cedar policies (§1i) and in the application code's tool-level access checks. They do **not** need to be registered on the MCP resources — Cedar policies reference them as free-form strings in the `context.scopes` set, and Keycard's authorization server includes them on tokens when a matching Cedar permit exists.

**Do not create scope definitions on any resource.** Proceed directly to §1g.

| Scope | Description |
|---|---|
| `snowflake:delegate` | Invoke the `delegate` tool (act as caller). |
| `snowflake:impersonate` | Invoke the `impersonate` tool (act as specified user). |
| `snowflake:agent-identity` | Invoke the `agent-identity` tool (act as application). |

### 1g. Snowflake OAuth integration and Keycard provider

This section has two parts: (A) create the OAuth security integration in Snowflake, (B) extract its config values and create a Snowflake OAuth provider in Keycard.

#### 1g-A. Create the Snowflake security integration

Present SQL to the user with values filled in:

```sql
USE ROLE ACCOUNTADMIN;

CREATE OR REPLACE SECURITY INTEGRATION kc_cross_cloud_oauth
  TYPE = oauth
  ENABLED = true
  OAUTH_CLIENT = custom
  OAUTH_CLIENT_TYPE = 'CONFIDENTIAL'
  OAUTH_ALLOW_NON_TLS_REDIRECT_URI = true
  OAUTH_REDIRECT_URI = '<keycard-url>/oauth/2/redirect'
  OAUTH_ISSUE_REFRESH_TOKENS = TRUE
  OAUTH_REFRESH_TOKEN_VALIDITY = 86400
  PRE_AUTHORIZED_ROLES_LIST = (KEYCARD_AGENT_READ)
  BLOCKED_ROLES_LIST = ('SYSADMIN');
```

#### 1g-B. Extract OAuth config values

After the user creates the integration, present this SQL to extract the four values the agent needs to create the provider:

```sql
DESCRIBE SECURITY INTEGRATION kc_cross_cloud_oauth;
SELECT
    MAX(CASE WHEN "property" = 'OAUTH_AUTHORIZATION_ENDPOINT' THEN "property_value" END) AS oauth_authorization_endpoint,
    MAX(CASE WHEN "property" = 'OAUTH_TOKEN_ENDPOINT' THEN "property_value" END) AS oauth_token_endpoint,
    MAX(CASE WHEN "property" = 'OAUTH_CLIENT_ID' THEN "property_value" END) AS oauth_client_id,
    'https://' || CURRENT_ORGANIZATION_NAME() || '-' || CURRENT_ACCOUNT_NAME() || '.snowflakecomputing.com' AS oauth_issuer
FROM TABLE(RESULT_SCAN(LAST_QUERY_ID()));
```

Ask the user to provide the four resulting values:

| Value | Example | Carry forward as |
|---|---|---|
| `OAUTH_AUTHORIZATION_ENDPOINT` | `https://xy12345.us-east-2.aws.snowflakecomputing.com/oauth/authorize` | `<sf-oauth-authorization-endpoint>` |
| `OAUTH_TOKEN_ENDPOINT` | `https://xy12345.us-east-2.aws.snowflakecomputing.com/oauth/token-request` | `<sf-oauth-token-endpoint>` |
| `OAUTH_CLIENT_ID` | `aBcDeFgHiJkLmNoPqRsTuVwXyZ0=` | `<sf-oauth-client-id>` |
| `oauth_issuer` | `https://MYORG-MYACCT.snowflakecomputing.com` | `<sf-oauth-issuer>` |

#### 1g-C. Create the Snowflake OAuth provider in Keycard

Using the values from §1g-B, create a Snowflake OAuth provider in the zone via the Management API. This provider enables Keycard to perform on-behalf-of token exchanges with Snowflake for the `delegate` flow.

| Field | Value |
|---|---|
| `identifier` | `<sf-oauth-issuer>` |
| `protocols.oauth2.issuer` | `<sf-oauth-issuer>` |
| `protocols.oauth2.authorization_endpoint` | `<sf-oauth-authorization-endpoint>` |
| `protocols.oauth2.token_endpoint` | `<sf-oauth-token-endpoint>` |
| `protocols.oauth2.client_id` | `<sf-oauth-client-id>` |

Carry forward as `<snowflake-oauth-provider-id>`. Consult the Keycard Management API reference for the exact provider creation payload shape. Do **not** set `client_secret` via the API.

#### 1g-D. User configures the client secret in the Keycard Console

The OAuth client secret cannot be set via the Management API. Present the user with the SQL to extract it:

```sql
SELECT PARSE_JSON(SYSTEM$SHOW_OAUTH_CLIENT_SECRETS('KC_CROSS_CLOUD_OAUTH')):"OAUTH_CLIENT_SECRET"::STRING AS oauth_client_secret;
```

Then construct the provider edit URL and instruct the user to paste the secret there:

```
https://console.keycard.ai/orgs/<org-slug>/zones/<zone-slug>/providers/<snowflake-oauth-provider-id>/edit
```

Resolve `<org-slug>` and `<zone-slug>` from the zone's console URL pattern (these are the human-readable slugs, not raw IDs — look them up from the Keycard Console or derive from known org/zone metadata).

The `delegate` flow uses this provider to exchange the caller's token for a Snowflake session scoped to their identity.

### 1h. Snowflake WIF user setup

Present SQL to the user with values filled in:

```sql
USE ROLE ACCOUNTADMIN;

CREATE USER KEYCARD_CROSS_CLOUD_AGENT
  WORKLOAD_IDENTITY = (
    TYPE = OIDC
    ISSUER = '<keycard-url>'
    SUBJECT = '<application-id>'
  )
  TYPE = SERVICE;

-- Create a role for the agent (or reuse an existing one)
CREATE ROLE IF NOT EXISTS KEYCARD_AGENT_READ;
GRANT ROLE KEYCARD_AGENT_READ TO USER KEYCARD_CROSS_CLOUD_AGENT;

-- Grant access to the target warehouse, database, and schema.
-- These grants control what the agent discovers dynamically via SHOW GRANTS TO ROLE.
GRANT USAGE  ON WAREHOUSE <snowflake-warehouse>                    TO ROLE KEYCARD_AGENT_READ;
GRANT USAGE  ON DATABASE   <snowflake-database>                    TO ROLE KEYCARD_AGENT_READ;
GRANT USAGE  ON SCHEMA     <snowflake-database>.<snowflake-schema> TO ROLE KEYCARD_AGENT_READ;
GRANT SELECT ON ALL    TABLES IN SCHEMA <snowflake-database>.<snowflake-schema> TO ROLE KEYCARD_AGENT_READ;
GRANT SELECT ON FUTURE TABLES IN SCHEMA <snowflake-database>.<snowflake-schema> TO ROLE KEYCARD_AGENT_READ;
```

The WIF user is used for `agent-identity` and `impersonate` flows. `delegate` uses the caller's exchanged token (via the OAuth integration above) which maps to their own Snowflake user.

**Dynamic discovery:** The agent does not require `SNOWFLAKE_DATABASE` or `SNOWFLAKE_SCHEMA` to be configured. On connect it runs `SHOW GRANTS TO ROLE KEYCARD_AGENT_READ` and discovers which databases/schemas have `USAGE` granted. The GRANT statements above are what control visibility — without `GRANT USAGE ON DATABASE`, the database won't appear in discovery; without `GRANT SELECT`, `INFORMATION_SCHEMA.TABLES` returns 0 rows for that schema.

### 1i. Demo policy set

**This section MUST be executed during provisioning.** It does not depend on resource-level scope definitions (§1f) — Cedar policies reference scope strings directly from the token's `context.scopes` set, which Keycard populates based on these policies.

**Intent.** Create a new Cedar policy set that **extends** the zone's current active policy set with two additional scope-gating policies. All existing managed policies are preserved — users, the CLI, and vault access continue to work. The two custom policies narrow MCP tool access: only the demo user may request `snowflake:delegate` and `snowflake:agent-identity` scopes. `snowflake:impersonate` is denied by omission (Cedar default-deny).

**Critical:** The new policy set MUST include every policy version from the currently active set. Dropping any existing managed policy will break user/CLI access to vault resources and other zone functionality.

Look up the current zone user and carry forward as `<demo-user-id>`:

```bash
keycard agent api "/zones/<zone-id>/users" --org "<org-id>" | jq -r '.items[0].id'
```

#### Snapshot the currently active policy set

1. Fetch the active policy set and its active version:

```bash
keycard agent api "/zones/<zone-id>/policy-sets?filter[active]=true" --org "<org-id>"
```

2. Fetch the active version's manifest to get the full list of policy version entries:

```bash
keycard agent api "/zones/<zone-id>/policy-sets/<active-policy-set-id>/versions/<active-version-id>" --org "<org-id>"
```

3. Carry forward **every** entry in the manifest as `<existing-policy-entries>` (a list of `{policy_id, policy_version_id}` pairs). There may be more than two — the managed set typically includes policies for user access, vault access, and other zone-level permits beyond just `default-app-delegation` and `default-app-direct-access`.

#### Create the two custom scope policies

Create two customer policies and their versions (schema version `2026-03-16`):

| Policy name | Cedar |
|---|---|
| `demo-scope-delegate` | Below |
| `demo-scope-agent-identity` | Below |

```cedar
@id("demo-scope-delegate")
permit (
  principal in Keycard::User::"<demo-user-id>",
  action,
  resource
) when {
  context has scopes && context.scopes.contains("snowflake:delegate")
};
```

```cedar
@id("demo-scope-agent-identity")
permit (
  principal in Keycard::User::"<demo-user-id>",
  action,
  resource
) when {
  context has scopes && context.scopes.contains("snowflake:agent-identity")
};
```

Carry forward the resulting version IDs as `<delegate-policy-version-id>` and `<agent-identity-policy-version-id>`.

#### Assemble the policy set

1. Create a policy set named `demo-scope-access` with `scope_type: "zone"`.
2. Create a policy set version whose manifest contains **all entries from `<existing-policy-entries>`** plus the two new custom policy versions:

| Entry | Source |
|---|---|
| 1 … N | Every `{policy_id, policy_version_id}` from the currently active set's manifest (copied verbatim) |
| N+1 | customer `demo-scope-delegate` → `<delegate-policy-version-id>` |
| N+2 | customer `demo-scope-agent-identity` → `<agent-identity-policy-version-id>` |

3. Activate the policy set version (PATCH with `active: true`).

## 2. Configuration the agent MUST write

### .env

```
KEYCARD_ZONE_URL=https://<zone-id>.keycard.cloud
SERVER_PORT=<port>
SERVER_URL=http://localhost:<port>/mcp
SNOWFLAKE_ACCOUNT=<snowflake-account>
SNOWFLAKE_WAREHOUSE=<snowflake-warehouse>
ANTHROPIC_RESOURCE=https://api.anthropic.com
SNOWFLAKE_RESOURCE=snowflakecomputing.com
```

Optional — narrow default discovery scope (agent discovers all granted resources dynamically by default):

```
SNOWFLAKE_DATABASE=<snowflake-database>
SNOWFLAKE_SCHEMA=<snowflake-schema>
SNOWFLAKE_ROLE=<snowflake-role>
```

`ANTHROPIC_API_KEY` and `KEYCARD_CLIENT_ID`/`KEYCARD_CLIENT_SECRET` MUST NOT appear in `.env`.

### keycard.toml

```toml
[org]
id = "<org-id>"

[zone]
id = "<zone-id>"

[[credentials.default]]
env_var = "KEYCARD_CLIENT_ID"
resource = "urn:<name>:client_id"

[[credentials.default]]
env_var = "KEYCARD_CLIENT_SECRET"
resource = "urn:<name>:client_secret"
```

### Platform environment variables

| Variable | Value (both Vercel and Fly) | Required |
|---|---|---|
| `KEYCARD_ZONE_URL` | `https://<zone-id>.keycard.cloud` | Yes |
| `SERVER_URL` | Platform's public URL + `/mcp` path (e.g. `https://<fly-app>.fly.dev/mcp`) | Yes |
| `SNOWFLAKE_ACCOUNT` | `<snowflake-account>` | Yes |
| `SNOWFLAKE_WAREHOUSE` | `<snowflake-warehouse>` | Yes |
| `ANTHROPIC_RESOURCE` | `https://api.anthropic.com` | Yes |
| `SNOWFLAKE_RESOURCE` | `snowflakecomputing.com` | Yes |
| `SNOWFLAKE_DATABASE` | Target database (agent discovers dynamically if unset) | No |
| `SNOWFLAKE_SCHEMA` | Target schema (agent discovers dynamically if unset) | No |
| `SNOWFLAKE_ROLE` | Snowflake role to USE (agent uses auto-activated role if unset) | No |

## 3. Agent verification

```bash
uv sync
```

Verify dependencies and resources:

```bash
keycard agent api "/zones/<zone-id>/applications/<application-id>/dependencies" --org "<org-id>" \
  | jq -e '.items | length == 2' >/dev/null

keycard agent api "/zones/<zone-id>/resources" --org "<org-id>" \
  | jq -e '.items[] | select(.identifier == "snowflakecomputing.com")'
```

Verify the active policy set contains four policies:

```bash
keycard agent api "/zones/<zone-id>/policy-sets?filter[active]=true" --org "<org-id>" \
  | jq -e '.items | length == 1'
```

### Smoke test — local startup

The provisioning agent is already running inside a `keycard run` session, so it cannot nest another `keycard run`. Instead, set temporary placeholder credentials and run the server directly:

```bash
KEYCARD_CLIENT_ID=test KEYCARD_CLIENT_SECRET=test uv run server
```

Start the server in the background. Wait for the process to begin listening on `<port>`, then GET `http://localhost:<port>/.well-known/oauth-protected-resource`. A `200` with a JSON body whose `resource` field equals the `SERVER_URL` value from `.env` confirms the server boots and the OAuth metadata route is wired correctly. The `resource` value **must** match the `identifier` of the corresponding Keycard MCP resource (e.g. `http://localhost:<port>/mcp` for local dev). Terminate the server immediately after the check succeeds.

## 4. Agent guardrails

- Do not write `ANTHROPIC_API_KEY` into `.env` or platform env vars. The agent fetches it via Keycard at runtime.
- Do not write `KEYCARD_CLIENT_ID` or `KEYCARD_CLIENT_SECRET` into `.env`. They are brokered by `keycard run`.
- Do not run the underlying credential API call yourself — use `scripts/provision-credentials.sh`.
- When running `scripts/provision-credentials.sh` inside a `keycard run` session, bypass the local socket which mishandles POST JSON bodies: `env -u KEYCARD_SOCKET bash scripts/provision-credentials.sh ...`.
- Do not nest `keycard run` — the provisioning agent already runs inside a `keycard run` session. For smoke tests, use placeholder credentials (`KEYCARD_CLIENT_ID=test KEYCARD_CLIENT_SECRET=test uv run server`).
- Do not commit `.env` or credential material.

## 5. Handoff data

| Key | Value | Run-where |
|---|---|---|
| `name` | `<name>` | — |
| `port` | `<port>` | — |
| `install_command` | `uv sync` | this session |
| `start_local` | `cd <name> && keycard run -- uv run server` | local terminal |
| `deploy_vercel` | `cd <name> && vercel deploy --prod` | user terminal |
| `deploy_fly` | `cd <name> && fly deploy` | user terminal |
| `try_delegate` | MCP `delegate` tool: query="How many rows in the customers table?" | MCP client (needs `snowflake:delegate` scope) |
| `try_impersonate` | MCP `impersonate` tool: user_identifier="analyst@company.com", query="Show revenue by region" | MCP client (needs `snowflake:impersonate` scope) |
| `try_agent_identity` | MCP `agent-identity` tool: query="List all available tables" | MCP client (needs `snowflake:agent-identity` scope) |
| `try_scoped_query` | MCP `agent-identity` tool: query="Show revenue", database="ANALYTICS", schema="PUBLIC" | MCP client — demonstrates per-call scope narrowing |
| `try_scope_denied` | Call `impersonate` tool — expect denial. No Cedar permit exists for `snowflake:impersonate` (default-deny). | MCP client |
| `verify` | Keycard Console → Audit Logs | — |
