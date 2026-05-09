# SPEC — agent-linear-triage-typescript

This template is an autonomous agent: it runs a pi-agent-core LLM loop that calls the `mcp-brokered-credentials-typescript` MCP proxy to triage Linear issues. The agent authenticates to Keycard using a **URL Application Credential** — an RSA keypair generated locally, with the public JWKS published at a well-known URL. No static client_secret is ever written to disk, env, or config.

The agent (e.g. the `keycard-template-app` skill) MUST perform every step in this document before declaring the project ready.

Throughout, treat `<name>` as the kebab-case project name (default: `agent-linear-triage-typescript`), `<port>` as the local HTTP port (default: `9000`), and `<agent-base-url>` as the public URL where this agent's well-known endpoints are reachable.

## 0. How the agent uses this document

**This SPEC is input for the agent, not output for the user.** The `keycard-template-app` skill is the sole renderer of user-facing narration. Read this document, extract the structured data below (primitives, edits, port, build command, smoke tests, handoff commands), and reason from it — but never quote or print any of it verbatim. If a sentence here is jargon-heavy, terse, or implementation-focused, the skill paraphrases it before showing anything to the user. The user should never be able to tell which sentence came from this SPEC.

## 0-prereq. Prerequisites

### 0a. Running mcp-brokered-credentials-typescript proxy

This template depends on a running instance of `mcp-brokered-credentials-typescript`. The proxy provides the `search` and `execute` MCP tools that fan out to Linear. Follow the proxy template's own `SPEC.md` to provision and start it before continuing.

Carry forward from the proxy's provisioning:
- `<proxy-resource-id>` — the proxy's Keycard resource ID
- `<proxy-mcp-url>` — the proxy's MCP endpoint (default: `http://localhost:8000/mcp`)

### 0b. Agent reachability

Keycard's STS must be able to fetch `<agent-base-url>/.well-known/jwks.json` from the public internet to verify the agent's signed client assertions. `localhost` does not work.

Choose **one** reachability mode:

#### Mode A: Tailscale Funnel (local dev)

Tailscale Funnel exposes a local port on the public internet over a stable `<host>.<tailnet>.ts.net` hostname with HTTPS terminated at the edge.

Preconditions:
- `tailscale` CLI installed and `tailscale up` already done.
- Funnel enabled on the tailnet (ACLs allow funnel for the node). See [Tailscale Funnel docs](https://tailscale.com/kb/1223/funnel).

```bash
tailscale funnel --bg <port>
```

The command prints the public URL (e.g. `https://myhost.tail12345.ts.net`). Use that as `<agent-base-url>`.

#### Mode B: Fly.io (hosted)

Fly gives a stable `https://<app>.fly.dev` hostname. The template ships `Dockerfile`, `fly.toml`, and `.dockerignore` for this mode.

```bash
fly launch --no-deploy
fly volumes create agent_data --size 1 --region <region>
fly secrets set \
  KEYCARD_URL="<keycard-url>" \
  PROXY_MCP_URL="<proxy-mcp-url>" \
  AGENT_TASK="<task>" \
  ANTHROPIC_API_KEY="<key>" \
  AGENT_BASE_URL="https://<app>.fly.dev" \
  AGENT_KEYS_DIR="/data/agent_keys"
fly deploy
```

After deploy, `<agent-base-url>` is `https://<app>.fly.dev`.

Note: `keycard run` is NOT invoked inside the Fly container. The agent authenticates end-to-end using its URL Application Credential (private key on the persistent volume). This is the operational difference between local dev and hosted: in local dev, `keycard run` brokers the user-bootstrap subject token; in hosted mode, the agent owns its identity entirely.

## 1. Required Keycard primitives

The agent MUST ensure every primitive below exists in the active Keycard environment. Most calls are idempotent; on `409` ("already exists"), GET the list endpoint and reuse the existing record's ID.

Background reading:
- [Platform Concepts](https://docs.keycard.ai/platform/)
- [Applications](https://docs.keycard.ai/platform/concepts/applications/)

### 1a. Agent application

This is the application that the agent identifies as when talking to Keycard's STS. Its identity is the public URL where the JWKS is hosted — no shared secret.

```bash
keycard agent api -X POST /zones/<zone-id>/applications --org <org-id> -d '{
  "name": "<name>",
  "identifier": "<agent-base-url>",
  "description": "Autonomous Linear triage agent with URL Application Credential",
  "consent": "implicit"
}'
```

Carry the result forward as `<agent-application-id>`.

### 1b. URL application credential

Register the agent's JWKS URL as an application credential. This tells Keycard's STS where to fetch the public key for verifying the agent's signed client assertion JWTs (RFC 7523 private_key_jwt).

```bash
keycard agent api -X POST /zones/<zone-id>/application-credentials --org <org-id> -d '{
  "application_id": "<agent-application-id>",
  "type": "jwks_uri",
  "jwks_uri": "<agent-base-url>/.well-known/jwks.json"
}'
```

If the active Keycard build does not accept those fields verbatim, abort and ask the user to create the credential manually:

```
Could not auto-register the URL application credential. Create it at
https://console.keycard.ai → Applications → <name> → Credentials with
type "URL" pointing at <agent-base-url>/.well-known/jwks.json, then retry.
```

### 1c. Wire the proxy resource as a dependency

Dependencies declare service-to-service relationships and drive the transitive consent flow — when the user authenticates to the agent's application, Keycard surfaces proxy + Linear consent because they are wired as dependencies.

```bash
keycard agent api -X PUT \
  "/zones/<zone-id>/applications/<agent-application-id>/dependencies/<proxy-resource-id>" \
  --org <org-id> -d '{}'
```

Verify the wiring landed:

```bash
keycard agent api \
  "/zones/<zone-id>/applications/<agent-application-id>/dependencies" \
  --org <org-id>
```

The proxy resource MUST appear in the returned `items`. If it does not, abort:

```
Could not wire the proxy as a dependency of the agent application. Open
https://console.keycard.ai → Applications → <name> → Dependencies and
connect the proxy resource manually, then retry.
```

### 1d. Publish the JWKS URL (idempotent)

After the agent's well-known server is running (step 3), verify the JWKS is reachable:

```bash
curl -sf "<agent-base-url>/.well-known/jwks.json" | jq .keys
```

This MUST return an array with at least one RSA public key. If it does not, the agent's Express server is not reachable at `<agent-base-url>` — check the reachability mode (§0b).

Alternatively, use the bundled helper script:

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
PROXY_MCP_URL=<proxy-mcp-url>
KEYCARD_URL=https://<id>.keycard.cloud
AGENT_PROVIDER=anthropic
AGENT_MODEL=claude-sonnet-4-20250514
AGENT_TASK=Find Linear issues older than 7 days assigned to me, summarize blockers, and post a triage report.
PORT=<port>
```

`.env` MUST NOT contain `KEYCARD_CLIENT_ID` or `KEYCARD_CLIENT_SECRET` — the agent uses a URL Application Credential (keypair + JWKS), not a shared secret.

### keycard.toml

The template ships a minimal `keycard.toml` at the project root:

```toml
[org]
id = "<org-id>"

[zone]
id = "<zone-id>"
```

The agent MUST replace both placeholder IDs with the values from the user's existing zone-bound `keycard.toml`. If no such file exists, abort and tell the user to run `keycard init` first.

Do NOT add `[[credentials.default]]` blocks — the agent authenticates via its URL Application Credential (keypair on disk + public JWKS at the well-known URL), not via brokered vault secrets.

Use the `keycard-upsert-config` skill for these edits. Nothing else belongs in `keycard.toml` — no `[project]`, no `[server]`, no `schema_version`, no `[zone].url`.

## 3. Agent verification

### Build

```bash
npm install && npm run build
```

### Identity check

Verify the keypair was generated:

```bash
ls -la agent_keys/
```

Should contain `<name>.pem` (private key) and `<name>.json` (public key metadata).

### JWKS reachability (Mode A only)

If using Tailscale Funnel, verify from a separate terminal:

```bash
curl -sf "<agent-base-url>/.well-known/jwks.json" | jq '.keys | length'
```

Must return `1` or more.

### Application credential check

```bash
keycard agent api \
  "/zones/<zone-id>/application-credentials?application_id=<agent-application-id>" \
  --org <org-id> \
  | jq -e '.items[] | select(.type == "jwks_uri")'
```

Must return an entry with the agent's JWKS URL.

## 4. What the agent MUST NOT do

- Do not write `KEYCARD_CLIENT_ID` or `KEYCARD_CLIENT_SECRET` to `.env`, `keycard.toml`, source code, or any file. This template demonstrates URL Application Credentials — keypair-only, no shared secrets.
- Do not add `[[credentials.default]]` blocks to `keycard.toml`. Vault-brokered secrets are for the proxy template, not this one.
- Do not add `[project]`, `[server]`, `schema_version`, or any `[zone].url` field to `keycard.toml`.
- Do not put `${KEYCARD_URL}` (or any `${...}` interpolation) in `keycard.toml` — TOML does not expand env vars.
- Do not modify the user's pre-existing `keycard.toml` outside the project directory.
- Do not commit `.env`, `agent_keys/`, or anything containing the Keycard ID or private key material.
- Do not issue a `password` credential for this application — URL Application Credentials only.
- Do not start the agent inside the provisioning session — the agent requires a running proxy and reachable well-known endpoint.
- Do not write Cedar or per-tool policy — v1 auth is OAuth scope-based; per-tool authorization is out of scope.
- Do not print SPEC phrasing such as "URL Application Credential", "client_assertion", "JWKS", "RFC 7523", "private_key_jwt", "STS provider", or "transitive consent" in any user-facing message — translate to outcomes (e.g. "the agent proves its identity with a keypair instead of a shared secret").

## 5. Handoff data (for the skill to render)

The skill renders the handoff from the following data. The agent extracts these values and passes them to the skill; the SPEC does not prescribe the user-facing wording.

| Key | Value | Run-where | Reason (plain outcomes) |
|---|---|---|---|
| `name` | `<name>` | — | Kebab-case project name |
| `port` | `<port>` | — | Local HTTP port the agent listens on |
| `proxy_precondition` | Proxy must be running: `cd mcp-brokered-credentials-typescript && keycard run -- npm start` | their terminal (separate, keep open) | The agent calls the proxy's MCP tools; without it, tool discovery fails |
| `proxy_ready_log` | `mcp-brokered-credentials-typescript listening on http://localhost:8000` | — | Signal to wait for before starting the agent |
| `reachability_mode` | A (Tailscale Funnel) or B (Fly.io) — chosen at §0-prereq | — | Keycard must be able to reach the agent's public key endpoint to verify its identity |
| `reachability_command_A` | `tailscale funnel --bg <port>` | their terminal | Exposes the agent on the public internet so Keycard can fetch its public key |
| `start_command_A` | `AGENT_BASE_URL=<agent-base-url> keycard run -- npm start` | their terminal | Starts the agent with its public URL set |
| `start_command_B` | Already running on Fly (deployed at §0-prereq) | — | — |
| `build_command` | `npm install && npm run build` | this session | Compiles the project |

### Expected behavior once started

The agent will: boot its identity (generate or load its keypair and serve the public key), authenticate to the proxy using that keypair, discover the proxy's MCP tools, execute the triage task autonomously, print results, and exit.

### Carried IDs for the recap

After §1 and §3, the agent has these values in hand: `<zone-id>`, `<agent-application-id>`, `<proxy-resource-id>`, `<agent-base-url>`, and the reachability mode. The skill renders them in its own voice — the SPEC does not supply a recap template. Point the user at `https://console.keycard.ai` for looking up any of the registered IDs.
