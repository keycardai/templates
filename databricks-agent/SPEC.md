# SPEC — databricks-agent

> A Keycard-protected MCP server exposing scope-gated tools across two Databricks branches (SQL Warehouse and Genie) plus `list_clusters`, brokering a Databricks workspace OAuth token at call time — no static API key. Authorizes access in one of two ways, toggled by one env flag.

An MCP server exposing per-tool-scoped tools. When a tool runs, the `@grant` decorator exchanges the user's Keycard bearer token for a Databricks-scoped OAuth token (OAuth 2.0 Token Exchange), then the tool calls the Databricks REST API directly. Credentials are minted per request — no Databricks key is stored anywhere.

The server authorizes access in one of two ways, selected by the `ENFORCE_TOOL_SCOPES` env flag:

- **`ENFORCE_TOOL_SCOPES=true` — scope-at-issuance + server verification.** The client requests specific per-tool scopes (e.g. `databricks:sql:execute`). Keycard's PDP evaluates Cedar against `context.scopes` and issues only the scopes the user's policy permits. Each tool then verifies its required scope is present before running, returning `insufficient_scope` otherwise.
- **`ENFORCE_TOOL_SCOPES=false` — policy-at-exchange / delegation.** The client requests no scopes and the server-side check is bypassed. Authorization happens at token-exchange time inside `@grant`: Keycard's delegation policy permits the on-behalf exchange only when the Databricks resource is wired as a dependency of this application. A denied exchange surfaces as a token-exchange error from the tool.

Pick this template to see Keycard's per-tool scope authorization and delegation control side-by-side against a plain REST API, or as a starting point for calling any OAuth-protected HTTP API on a user's behalf.

The agent (e.g. the `keycard-template-app` skill) MUST perform every step in this document before declaring the project ready. The `keycard run -- uv run python main.py` workflow at the end depends on every primitive being in place.

Throughout, treat `<name>` as the kebab-case project name (default: `databricks-agent`), `<port>` as the local HTTP port (default: `8000`), `<databricks-host>` as the workspace host the user supplies (e.g. `https://dbc-1234.cloud.databricks.com`), and `<server-url>` as the base URL the MCP client uses to reach this server, ending in a trailing slash (default `http://localhost:<port>/`; a public URL only if the server is hosted remotely).

## 0. How the agent uses this document

**This SPEC is input for the agent, not output for the user.** The skill is the sole renderer of user-facing narration. Read this document, extract the structured data below (primitives, edits, port, build command, smoke tests, handoff commands), and reason from it — never quote or print any of it verbatim. Paraphrase terse or jargon-heavy lines before showing anything to the user.

**All Keycard traffic is outbound from the server.** The `@grant` token exchange, JWKS discovery, and bearer verification are all calls the server makes to Keycard — Keycard never connects back to the server. The only inbound connection is from the MCP client (Claude/Cursor), which for local use is `localhost`. `<server-url>` and the server resource identifier (§1e) match that client-facing URL.

## 0c. Concepts the agent should introduce

Introduce each concept **once**, the first time it appears during narration. Use the one-sentence framing below and include the docs link.

| Order | Concept | First appears at | One-sentence framing | Docs |
|---|---|---|---|---|
| 1 | Zone | Step 3 (resolve context) | Your private Keycard environment that holds users, apps, and policies and issues credentials. | https://docs.keycard.ai/platform/concepts/zones/ |
| 2 | Organization | Step 3 (resolve context) | The account that owns one or more zones — usually your company or team. | https://docs.keycard.ai/platform/concepts/zones/ |
| 3 | OAuth provider | §1a (Databricks provider) | A credential provider that brokers OAuth tokens for a third-party service — here it mints tokens Databricks accepts. | https://docs.keycard.ai/platform/concepts/providers/ |
| 4 | Resource | §1b (Databricks resource) | The protected API your application calls — its identifier must match the API host exactly so Keycard's STS knows which tokens to issue. | https://docs.keycard.ai/platform/concepts/resources/ |
| 5 | Application | §1c (server app) | A software actor registered with Keycard — this server gets one so Keycard knows who is asking for credentials. | https://docs.keycard.ai/platform/concepts/applications/ |
| 6 | Dependency | §1d (wiring) | A declared relationship that controls which resources an application can access — enforces access without writing policies directly. | https://docs.keycard.ai/platform/concepts/applications/#dependencies |
| 7 | STS provider | §1e (server resource) | The credential source built into every zone that mints OAuth access tokens for resources within the zone. | https://docs.keycard.ai/platform/concepts/providers/ |
| 8 | Vault provider | §1f (credentials) | A provider that stores static secrets (the server's `client_id`/`client_secret`) and delivers them at runtime via `keycard run`. | https://docs.keycard.ai/platform/concepts/providers/ |
| 9 | Application credentials | §1f (credentials) | The credential the server uses to authenticate its own token-exchange calls to Keycard's STS. | https://docs.keycard.ai/platform/concepts/applications/ |
| 10 | Scope | §1g (scope reference) | A permission string on the MCP access token that gates which tool the caller may invoke. | https://docs.keycard.ai/reference/security-architecture/ |
| 11 | Policy set | §1h (policy set) | A versioned bundle of Cedar policies Keycard evaluates for every authorization request in the zone. | https://docs.keycard.ai/console/access-policies |
| 12 | Keycard issuer | §2 (KEYCARD_URL) | The URL apps use to discover Keycard's signing keys and token endpoints; for your zone it's `https://<zone-id>.keycard.cloud`. | https://docs.keycard.ai/platform/architecture/standards-and-protocols/ |

## 1. Required Keycard primitives

The agent MUST ensure every primitive below exists in the active Keycard environment, constructing each Management API call from the [Keycard API reference](https://docs.keycard.ai/api/). Most calls are idempotent; on `409` ("already exists"), GET the list endpoint and reuse the existing record's ID.

Background reading on the domain model:

- [Platform Concepts](https://docs.keycard.ai/platform/)
- [Providers](https://docs.keycard.ai/platform/concepts/providers/)
- [Applications](https://docs.keycard.ai/platform/concepts/applications/)
- [Resources](https://docs.keycard.ai/platform/concepts/resources/)

The Databricks endpoint the server calls is documented at [Clusters API → List](https://docs.databricks.com/api/workspace/clusters/list).

### 1a. Databricks credential provider

A provider that can mint OAuth tokens accepted by `<databricks-host>`. Carry the result forward as `<databricks-provider-id>`.

| Field | Value |
|---|---|
| `type` | `oauth` |
| `identifier` | `<databricks-host>` |

If the active Keycard build does not accept an OAuth provider for Databricks verbatim, consult the API reference and adjust. If it still fails, tell the user provisioning could not configure the Databricks provider and to create it in `https://console.keycard.ai → Providers` (pointing at the Databricks workspace OAuth server), then retry.

### 1b. Databricks resource

The protected API the server calls. The identifier MUST be `<databricks-host>` exactly — Keycard's STS rejects token requests whose `resource` does not match. Carry forward as `<databricks-resource-id>`.

| Field | Value |
|---|---|
| `identifier` | `<databricks-host>` |
| `credential_provider_id` | `<databricks-provider-id>` |

### 1c. Server application

The application THIS server identifies as when it talks to Keycard's STS. Its `client_id` / `client_secret` are the credentials used to authenticate the token-exchange call. Carry forward as `<server-application-id>`.

| Field | Value |
|---|---|
| `identifier` | `<server-url>` |
| `consent` | `implicit` |

### 1d. Wire Databricks as a dependency of the server application

**Intent.** Additively grant the server application access to the Databricks resource, leaving other records untouched. This dependency is also the **authorization control for the exchange-time path** (`ENFORCE_TOOL_SCOPES=false`): the delegation policy in §1h permits the on-behalf token exchange only when this dependency exists.

**How to achieve it.** Dependencies live on the **application**. `PUT /zones/<zone-id>/applications/<server-application-id>/dependencies/<databricks-resource-id>` with an empty JSON body, then GET the dependencies list and confirm the Databricks resource appears in `items`. If it does not, consult the API reference and retry; if still absent, tell the user to connect the Databricks resource as a dependency of `<name>` in `https://console.keycard.ai → Applications`.

### 1e. Server MCP resource

The server registers itself as a resource so Keycard's STS mints mcp-scoped tokens that authenticate users to it. The identifier MUST be `<server-url>mcp` (the `<server-url>` from §2 with `mcp` appended — `http://localhost:<port>/mcp` for local use). Discover the zone's built-in STS provider (`type = "keycard-sts"`) and carry it forward as `<sts-provider-id>`. Carry the resource forward as `<server-resource-id>`.

| Field | Value |
|---|---|
| `identifier` | `<server-url>mcp` |
| `scopes` | `["mcp:tools"]` |
| `application_id` | `<server-application-id>` |
| `credential_provider_id` | `<sts-provider-id>` |

### 1f. Server application credentials + vault resources

Issue application credentials for the server and copy them into zone-vault resources in one local operation. The bundled `scripts/provision-credentials.sh` keeps the credential material (`client_id`, `client_secret`) inside its own shell process; only the non-sensitive URNs that resolve them at runtime reach the agent.

Confirm a `keycard-vault` provider exists (`type = "keycard-vault"`); if several, ask the user which to use. Carry it forward as `<vault-provider-id>`. If none exists, tell the user this template needs a vault provider to broker the server's credentials and to create one in `https://console.keycard.ai → Providers`, then retry.

```bash
bash scripts/provision-credentials.sh \
  --zone "<zone-id>" \
  --org "<org-id>" \
  --app-id "<server-application-id>" \
  --vault-provider "<vault-provider-id>" \
  --name "<name>"
```

The script issues a `password`-type application credential, creates vault resources at `urn:<name>:client_id` and `urn:<name>:client_secret`, attaches the secrets, and wipes the in-memory credential. On failure it prints a remediation message; the correct fallback is to tell the user provisioning failed, ask them to issue credentials in `https://console.keycard.ai → Applications → <name> → Credentials` and store them in vault resources at those two URNs themselves, and to reach Keycard support if stuck. The agent MUST NOT run the underlying `application-credentials` call itself — that would expose the secret in the tool-call transcript.

### 1g. Scope reference (no resource-level configuration needed)

Each MCP tool requires exactly one scope. These strings appear in the per-tool scope-grant Cedar policies (§1h) and in the server's `@require_scope` checks. They do **not** need to be registered on any resource — Cedar references them as free-form strings in the `context.scopes` set, and Keycard's authorization server includes a scope on an issued token only when a matching Cedar permit exists. **Do not create scope definitions on any resource.**

| Scope | Tool |
|---|---|
| `databricks:clusters:read` | `list_clusters` |
| `databricks:sql:warehouses:read` | `list_warehouses` |
| `databricks:sql:execute` | `execute_statement` |
| `databricks:sql:read` | `get_statement` |
| `databricks:genie:spaces:read` | `list_genie_spaces` |
| `databricks:genie:converse` | `start_genie_conversation` |
| `databricks:genie:read` | `get_genie_message`, `get_genie_query_result` |

### 1h. Authorization policy set (Cedar, schema `2026-03-16`)

**Intent.** Create a new Cedar policy set that **extends** the zone's currently active set with the policies for both authorization modes, preserving every existing managed policy so users, the CLI, and vault access keep working. All additions are permits.

**Critical.** The new policy-set version MUST include every policy version from the currently active set, with one deliberate substitution described under the dependency-gated delegation policy below. Dropping any other managed policy (especially `default-user-grants`) breaks `keycard run` vault exchange for the demo user.

Look up the demo user and carry forward as `<demo-user-id>`:

```bash
keycard agent api "/zones/<zone-id>/users" --org "<org-id>" | jq -r '.items[0].id'
```

#### Snapshot the active policy set

Fetch the active policy set, then its active version's manifest, and carry **every** `{policy_id, policy_version_id}` entry forward as `<existing-policy-entries>`. A freshly-provisioned zone typically contains `default-user-grants`, `default-app-delegation`, and `default-app-direct-access`.

```bash
keycard agent api "/zones/<zone-id>/policy-sets?filter[active]=true" --org "<org-id>"
keycard agent api "/zones/<zone-id>/policy-sets/<active-policy-set-id>/versions/<active-version-id>" --org "<org-id>"
```

#### Per-tool scope-grant policies (issuance)

Create one customer policy per scope the demo user is allowed to obtain. To make the demo show fine-grained allow/deny, permit the SQL branch and clusters but **omit the Genie branch** — so a request for `databricks:genie:converse` is stripped at issuance (Cedar default-deny) and the Genie tools return `insufficient_scope`.

| Policy name | Permits scope |
|---|---|
| `demo-scope-clusters-read` | `databricks:clusters:read` |
| `demo-scope-sql-warehouses-read` | `databricks:sql:warehouses:read` |
| `demo-scope-sql-execute` | `databricks:sql:execute` |
| `demo-scope-sql-read` | `databricks:sql:read` |

Each policy has the same shape; substitute the policy `@id` and the scope string:

```cedar
@id("demo-scope-sql-execute")
permit (
  principal in Keycard::User::"<demo-user-id>",
  action,
  resource
) when {
  context has scopes && context.scopes.contains("databricks:sql:execute")
};
```

Carry the resulting version IDs forward (e.g. `<scope-sql-execute-policy-version-id>`).

#### Dependency-gated delegation (exchange)

Replace the broad managed `default-app-delegation` (which permits any application's on-behalf exchange when `context.on_behalf == true`) with a dependency-gated equivalent, so the application's dependency graph (§1d) becomes the real authorization control. This is still additive with respect to user/vault policies — only the delegation default changes form.

```cedar
@id("demo-app-delegation-by-dependency")
permit (
  principal is Keycard::Application,
  action,
  resource
) when {
  context.on_behalf == true &&
  principal.dependencies.contains(resource)
};
```

Create this as a customer policy; carry its version forward as `<delegation-policy-version-id>`.

#### Assemble and activate

Create a policy set named `databricks-demo-access` with `scope_type: "zone"`, then a version whose manifest contains:

| Entry | Source |
|---|---|
| Existing entries | Every `{policy_id, policy_version_id}` from `<existing-policy-entries>`, copied verbatim — **except** `default-app-delegation`, which is dropped in favor of the dependency-gated policy below |
| Per-tool scope grants | the four `demo-scope-*` customer policy versions |
| Dependency-gated delegation | customer `demo-app-delegation-by-dependency` → `<delegation-policy-version-id>` |

Activate the new policy-set version (PATCH with `active: true`). Verify against the Console audit log during the smoke phase: a permitted scope appears on the issued token; an omitted scope does not; and with the dependency present the on-behalf exchange to `<databricks-host>` is permitted.

## 2. Configuration the agent MUST write

### .env

Write `.env` in the project root from `.env.example`:

```
KEYCARD_URL=https://<zone-id>.keycard.cloud
MCP_SERVER_URL=<server-url>
DATABRICKS_HOST=<databricks-host>
ENFORCE_TOOL_SCOPES=true
DATABRICKS_WAREHOUSE_ID=<warehouse-id>
DATABRICKS_GENIE_SPACE_ID=<genie-space-id>
```

`MCP_SERVER_URL` is the single source of truth for the listen port too: `main.py` parses the port from this URL and binds to it, so the advertised URL and bind port always agree (a mismatch breaks MCP auth with an invalid audience). `DATABRICKS_HOST` is the workspace host only (no API path) — every tool appends its own `/api/2.x/...` route. `ENFORCE_TOOL_SCOPES` selects how access is authorized: `true` makes the server verify per-tool scopes, `false` lets the delegation policy authorize the exchange instead. `DATABRICKS_WAREHOUSE_ID` and `DATABRICKS_GENIE_SPACE_ID` are optional defaults the SQL/Genie tools fall back to when the caller omits them.

`main.py` loads `.env` via `python-dotenv`, so these are picked up at startup. `.env` MUST NOT contain `KEYCARD_CLIENT_ID` or `KEYCARD_CLIENT_SECRET` — they are brokered at runtime by `keycard run`.

### keycard.toml

The template ships a minimal `keycard.toml` with `[org]` and `[zone]` blocks. Replace both IDs with the values from the user's existing zone-bound `keycard.toml`. If no such file exists, tell the user to run `keycard init` first — without it `keycard run` cannot authenticate.

Then append two credential entries matching the vault resources from §1f:

```toml
[[credentials.default]]
env_var = "KEYCARD_CLIENT_ID"
resource = "urn:<name>:client_id"

[[credentials.default]]
env_var = "KEYCARD_CLIENT_SECRET"
resource = "urn:<name>:client_secret"
```

Substitute `<name>` so the URNs line up with what `provision-credentials.sh` created. Use the `keycard-upsert-config` skill for these edits.

## 3. User pre-flight

For local use no extra setup is needed — `<server-url>` is `http://localhost:<port>/` and the MCP client reaches the server over loopback. If the server is hosted remotely instead, set `MCP_SERVER_URL` to its public base URL and keep that value consistent across `.env` and the §1e resource identifier (`<server-url>mcp`).

## 4. Agent verification

There is no build step. Install dependencies and confirm the two vault resources resolve to a credential provider:

```bash
uv sync
```

```bash
for urn in "urn:<name>:client_id" "urn:<name>:client_secret"; do
  keycard agent api "/zones/<zone-id>/resources?identifier=${urn}" --org "<org-id>" \
    | jq -e --arg u "$urn" '.items[] | select(.identifier == $u) | .credential_provider_id' >/dev/null \
    || { echo "MISSING: $urn"; exit 1; }
done
echo "OK: both vault resources resolve"
```

Both lookups MUST return a non-null `credential_provider_id`. Likely causes of failure: the vault resource is missing or has the wrong identifier, a `[[credentials.default]]` entry points at the wrong URN (re-check the `<name>` substitution), or `keycard.toml` still has placeholder `<org-id>`/`<zone-id>` values. Do NOT start the server inside the agent session — `keycard run` needs an interactive TTY and will not nest. The end-to-end test happens when the user runs it in §6.

## 5. Agent guardrails

- Do not modify the user's pre-existing `keycard.toml` outside the project directory.
- Do not run the underlying `keycard agent api .../application-credentials` call yourself — always invoke `scripts/provision-credentials.sh`. The credential payload must not appear in any tool-call transcript.
- Do not commit `.env`, `KEYCARD_URL`, the Keycard zone ID, or `<databricks-host>`.
- Do not add `[project]`, `[server]`, `schema_version`, or any `[zone].url` field to `keycard.toml`. Only `[org].id`, `[zone].id`, and the two `[[credentials.default]]` blocks belong there.
- When assembling the policy set (§1h), preserve every existing managed policy except the deliberate `default-app-delegation` substitution. Dropping `default-user-grants` breaks `keycard run` vault exchange.
- Do not print SPEC jargon ("OAuth 2.0 Token Exchange", "STS provider", "context.scopes") in user-facing messages — translate to outcomes per §0c.

## 6. Handoff data (for the skill to render)

After provisioning and verification, register the server in Claude's local MCP config:

```bash
claude mcp remove <name> 2>/dev/null || true
claude mcp add --transport http <name> <server-url>mcp
```

If `claude` is not on PATH, tell the user to add the server (`url` = `<server-url>mcp`) to `~/.claude.json` under `mcpServers`.

| Key | Value | Run-where | Reason (plain outcomes) |
|---|---|---|---|
| `name` | `<name>` | — | Kebab-case project name used everywhere |
| `port` | `<port>` | — | Local HTTP port the server listens on |
| `install_command` | `uv sync` | this session | Installs dependencies |
| `start_command` | `keycard run -- uv run python main.py` | their terminal (separate, keep open) | `keycard run` hands the server its brokered credentials; it cannot exchange tokens without them |
| `claude_register_command` | `claude mcp add --transport http <name> <server-url>mcp` | this session (agent may execute) | Adds the server to Claude's MCP config |
| `restart_command` | `keycard run -- claude` | their terminal | Claude only discovers MCP servers at startup |
| `auth_command` | `/mcp` → pick `<name>` | new agent session | Completes the OAuth flow; the first time, the user sees a Databricks consent screen because this server depends on Databricks |
| `try_it` | `list_warehouses`; then `execute_statement` with `{"statement": "SELECT 1"}` | new agent session | Confirms the server can call Databricks on the user's behalf with a brokered credential |
| `try_scope_denied` | With `ENFORCE_TOOL_SCOPES=true`, use `mcp-client-python --scopes databricks:genie:converse` then call `start_genie_conversation` — expect `insufficient_scope` (Genie scopes are not permitted by the demo policy) | MCP client | Shows scope enforcement: the omitted scope is stripped at issuance and the tool refuses |
| `try_exchange_gated` | Set `ENFORCE_TOOL_SCOPES=false`, restart the server, call any tool with no requested scopes — succeeds while the Databricks dependency exists; remove the dependency and the call returns a token-exchange error | MCP client | Shows delegation control: the delegation/dependency policy authorizes the exchange |

### Carried IDs for the recap

After §1 and §4 the agent holds: `<zone-id>`, `<databricks-provider-id>`, `<databricks-resource-id>`, `<server-application-id>`, `<server-resource-id>`, `<sts-provider-id>`, `<vault-provider-id>`, `<demo-user-id>`, the policy-set version IDs, and the verified vault URNs (`urn:<name>:client_id`, `urn:<name>:client_secret`). Point the user at `https://console.keycard.ai` to look any of them up.

## 7. What to say to the user (per-step narration)

Paraphrase into the skill's voice — never read verbatim, and follow the jargon prohibition in §5. Use §0c for first-mention framing.

| Step | Tell the user before you start |
|---|---|
| Step 4 (copy) | "Copying the `databricks-agent` blueprint into `./<name>` — an MCP server with SQL Warehouse and Genie tools (plus `list_clusters`) that talk to your Databricks workspace using Keycard-brokered tokens. No Databricks API key needed." |
| Step 6 (fill in) | "Filling in `.env` with your zone's issuer URL, the server's local URL and port, your Databricks workspace host, and the scope-enforcement flag. I'll also write `keycard.toml` with your zone/org IDs and two credential entries so `keycard run` brokers the server's `client_id` and `client_secret` from the vault at startup." |
| Step 7 (register) | "Registering the Keycard primitives: (1) an OAuth provider + resource for your Databricks workspace, (2) this server's own application + resource backed by the zone's STS, (3) a dependency from the server to Databricks, (4) application credentials in the zone vault, and (5) a Cedar policy set that grants the demo user the SQL tool scopes and gates delegation by that dependency. Each builds on the previous — I'll name what I get back after each step." |
| Step 8 (smoke-test) | "Installing dependencies and verifying the two vault resources resolve in the API. I'm not starting the server here — it needs `keycard run` to broker the secrets, which can't nest inside this session. The real test happens when you run it yourself." |
| Step 9 (handoff) | "Setup is done. In your terminal: run the server with `keycard run -- uv run python main.py`, restart Claude, authenticate via `/mcp`, then ask Claude to run `list_warehouses` or `execute_statement`. To see scope denial, use the `mcp-client-python` client to request a scope the policy omits." |
