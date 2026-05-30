# SPEC — databricks-agent

> A Keycard-protected MCP server with one tool, `list_clusters`, that brokers a Databricks workspace OAuth token at call time and hits the Databricks REST API — no static API key.

An MCP server exposing a single tool. When Claude calls `list_clusters`, the `@grant` decorator exchanges the user's Keycard bearer token for a Databricks-scoped OAuth token (OAuth 2.0 Token Exchange), then the tool calls `GET {DATABRICKS_HOST}/api/2.0/clusters/list` directly. Credentials are minted per request — no Databricks key is stored anywhere.

Pick this template to see Keycard's brokered-credential flow against a plain REST API (rather than an upstream MCP server), or as a pattern for calling any OAuth-protected HTTP API on a user's behalf.

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
| 10 | Keycard issuer | §2 (KEYCARD_URL) | The URL apps use to discover Keycard's signing keys and token endpoints; for your zone it's `https://<zone-id>.keycard.cloud`. | https://docs.keycard.ai/platform/architecture/standards-and-protocols/ |

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

**Intent.** Additively grant the server application access to the Databricks resource, leaving other records untouched.

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

## 2. Configuration the agent MUST write

### .env

Write `.env` in the project root from `.env.example`:

```
KEYCARD_URL=https://<zone-id>.keycard.cloud
MCP_SERVER_URL=<server-url>
PORT=<port>
DATABRICKS_HOST=<databricks-host>
```

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
- Do not write Cedar or per-tool policy — auth is OAuth scope-based (`mcp:tools`); per-tool authorization is out of scope.
- Do not print SPEC jargon ("OAuth 2.0 Token Exchange", "STS provider", "bearer token scoped to mcp:tools") in user-facing messages — translate to outcomes per §0c.

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
| `try_it` | `list_clusters` with no arguments | new agent session | Confirms the server can call Databricks on the user's behalf with a brokered credential |

### Carried IDs for the recap

After §1 and §4 the agent holds: `<zone-id>`, `<databricks-provider-id>`, `<databricks-resource-id>`, `<server-application-id>`, `<server-resource-id>`, `<sts-provider-id>`, `<vault-provider-id>`, and the verified vault URNs (`urn:<name>:client_id`, `urn:<name>:client_secret`). Point the user at `https://console.keycard.ai` to look any of them up.

## 7. What to say to the user (per-step narration)

Paraphrase into the skill's voice — never read verbatim, and follow the jargon prohibition in §5. Use §0c for first-mention framing.

| Step | Tell the user before you start |
|---|---|
| Step 4 (copy) | "Copying the `databricks-agent` blueprint into `./<name>` — an MCP server with one tool, `list_clusters`, that talks to your Databricks workspace using a Keycard-brokered token. No Databricks API key needed." |
| Step 6 (fill in) | "Filling in `.env` with your zone's issuer URL, the server's local URL and port, and your Databricks workspace host. I'll also write `keycard.toml` with your zone/org IDs and two credential entries so `keycard run` brokers the server's `client_id` and `client_secret` from the vault at startup." |
| Step 7 (register) | "Registering the Keycard primitives: (1) an OAuth provider + resource for your Databricks workspace so Keycard can broker tokens to it, (2) this server's own application + resource backed by the zone's STS, (3) a dependency from the server to Databricks so you don't write policies by hand, and (4) application credentials stored in the zone vault. Each builds on the previous — I'll name what I get back after each step." |
| Step 8 (smoke-test) | "Installing dependencies and verifying the two vault resources resolve in the API. I'm not starting the server here — it needs `keycard run` to broker the secrets, which can't nest inside this session. The real test happens when you run it yourself." |
| Step 9 (handoff) | "Setup is done. In your terminal: run the server with `keycard run -- uv run python main.py`, restart Claude, authenticate via `/mcp`, then ask Claude to run `list_clusters`." |
