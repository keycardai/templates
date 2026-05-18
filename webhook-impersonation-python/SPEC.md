# SPEC — webhook-impersonation-python

> Webhook bridge that impersonates users via Keycard to create Linear issues — no user secrets stored, no interactive consent at call time.

A signed-webhook bridge: each event names the user it should act as, and the server uses Keycard impersonation to call an upstream API on that user's behalf. No user secrets are stored, and no interactive consent is needed at call time — the user authorizes the upstream once, ahead of time. The bridge's own credentials are vault-brokered at runtime; nothing sensitive lives on disk.

Pick this template to see Keycard's impersonation flow in action, or as a pattern for any webhook-to-API bridge where the acting user is named in the event payload rather than present at call time.

The agent (e.g. the `keycard-template-app` skill) MUST perform every step in this document before declaring the project ready. The `keycard run -- uvicorn main:app` workflow at the end depends on every primitive being in place.

Throughout, treat `<name>` as the kebab-case project name (default: `webhook-impersonation-python`) and `<port>` as the local HTTP port (default: `8000`).

## 0. How the agent uses this document

**This SPEC is input for the agent, not output for the user.** The skill is the sole renderer of user-facing narration. Read this document, extract the structured data below (primitives, edits, port, build command, smoke tests, handoff commands), and reason from it — but never quote or print any of it verbatim. If a sentence here is jargon-heavy, terse, or implementation-focused, the skill paraphrases it before showing anything to the user.

## 0c. Concepts the agent should introduce

Introduce each concept **once**, the first time it appears during narration. Use the one-sentence framing below and include the docs link so the user can read more in a side tab.

| Order | Concept | First appears at | One-sentence framing | Docs |
|---|---|---|---|---|
| 1 | Zone | Step 3 (resolve context) | Your private Keycard environment that holds users, apps, and policies and issues credentials. | https://docs.keycard.ai/concepts/zones/ |
| 2 | Organization | Step 3 (resolve context) | The account that owns one or more zones — usually your company or team. | https://docs.keycard.ai/concepts/zones/ |
| 3 | OAuth provider | §1a (Linear provider) | A credential provider that can mint or broker OAuth tokens for a third-party service — here it handles the OAuth 2.1 + dynamic client registration flow that Linear's MCP server expects. | https://docs.keycard.ai/concepts/providers/ |
| 4 | Application | §1b (Linear app) | A software actor registered with Keycard — the bridge and Linear each get one, so Keycard knows who is asking for credentials and who is granting them. | https://docs.keycard.ai/concepts/applications/ |
| 5 | Resource | §1c (Linear resource) | The protected API your application calls — the resource identifier must match the URL exactly so Keycard's token exchange knows which tokens to issue. | https://docs.keycard.ai/concepts/resources/ |
| 6 | Dependency | §1e (wiring) | A declared relationship that controls which resources an application can access — a simpler way to enforce access policy without writing policies directly. | https://docs.keycard.ai/concepts/applications/#dependencies |
| 7 | Vault provider | §0e (vault provider) | A provider that stores static secrets (like the bridge's `client_id`/`client_secret` and `webhook_secret`) and delivers them at runtime via `keycard run` — no secrets in files. | https://docs.keycard.ai/concepts/providers/ |
| 8 | Application credentials | §1f (credentials) | The credential the bridge uses to authenticate its own impersonation calls to Keycard. | https://docs.keycard.ai/concepts/applications/#credentials |
| 9 | Keycard issuer | §2 (KEYCARD_URL) | The URL apps use to discover Keycard's signing keys and token endpoints; for your zone it's `https://<zone-id>.keycard.cloud`. | https://docs.keycard.ai/reference/security-architecture/ |
| 10 | Impersonation policy | §1h (policy) | A Cedar permit rule that explicitly allows a specific application to act on behalf of users — impersonation is forbidden by default. | https://docs.keycard.ai/concepts/credentials/#impersonation |

## 0-prereq. Prerequisites

### 0d. Project name and port

Resolve `<name>` (kebab-case project name, default: `webhook-impersonation-python`) and `<port>` (local HTTP port, default: `8000`). Confirm `<port>` is free locally before proceeding.

### 0e. Vault provider

Resolve the zone's `keycard-vault` provider and carry it forward as `<vault-provider-id>`. If there are several, ask the user which to use. Both provisioning scripts in §1f and §1g require this value.

### 0f. Existing Linear primitives

Before creating anything, list the zone's providers, applications, and resources. If a provider with identifier `https://mcp.linear.app` already exists, reuse its ID as `<linear-provider-id>` and skip §1a. If an application with identifier `https://mcp.linear.app/mcp` already exists, reuse its ID as `<linear-application-id>` and skip §1b. If a resource with identifier `https://mcp.linear.app/mcp` already exists, reuse its ID as `<linear-resource-id>` and skip §1c. This avoids `409` round-trips and surfaces conflicts early — a mismatched existing record (right identifier, wrong provider or application binding) must be flagged to the user before the agent starts creating dependent primitives.

## 1. Required Keycard primitives

The agent MUST ensure every primitive below exists in the active Keycard environment. Most calls are idempotent; on `409` ("already exists"), GET the list endpoint and reuse the existing record's ID.

The agent uses the Keycard Management API (via `keycard agent api` or equivalent) to create the records below. Resolve the exact endpoints, field names, and payload shape from the Keycard API reference — only the **identity-defining fields** are pinned here. Carry each returned ID forward into the next step.

### 1a. Linear credential provider

A provider that can mint OAuth tokens for the Linear MCP server. Linear MCP speaks OAuth 2.1 with dynamic client registration, so Keycard's generic OAuth provider type is appropriate.

| Field | Value |
|---|---|
| `identifier` | `https://mcp.linear.app` |
| type | OAuth |
| name / description | human-readable, e.g. `linear` / "Linear MCP OAuth provider" |

Carry the result forward as `<linear-provider-id>`.

### 1b. Linear application

The Linear MCP service registered as a Keycard application — what the dependency in §1e points at.

| Field | Value |
|---|---|
| `identifier` | `https://mcp.linear.app/mcp` |
| name / description | human-readable, e.g. `linear` |

Carry the result forward as `<linear-application-id>`.

### 1c. Linear resource

The protected upstream the bridge calls. The `identifier` MUST equal `https://mcp.linear.app/mcp` exactly — Keycard's token exchange rejects requests whose `resource` does not match the registered identifier.

| Field | Value |
|---|---|
| `identifier` | `https://mcp.linear.app/mcp` (must match exactly) |
| application | `<linear-application-id>` |
| credential provider | `<linear-provider-id>` |

Carry the result forward as `<linear-resource-id>`.

### 1d. Bridge application

The application that THIS webhook bridge identifies as when it calls Keycard. Its `client_id` / `client_secret` (issued in §1f) authenticate the impersonation call.

| Field | Value |
|---|---|
| `identifier` | `<name>` |
| name / description | human-readable, e.g. `<name>` / "Webhook bridge that impersonates users to create Linear issues" |

Carry the result forward as `<bridge-application-id>`.

### 1e. Wire Linear as a dependency of the bridge application

**Intent.** Exactly one dependency edge from `<bridge-application-id>` to `<linear-resource-id>`; do not touch other dependencies on the bridge application or the Linear resource.

**How to achieve it.** Attach `<linear-resource-id>` as a dependency of `<bridge-application-id>` via the dedicated dependency endpoint, then GET the application's dependencies and confirm the Linear resource appears in the returned list. Do not proceed until that GET verifies — the `dependencies` field passed inline on a resource or application POST/PATCH is silently ignored.

### 1f. Bridge application credentials + vault resources

The bundled script `scripts/provision-credentials.sh` issues the bridge's application credentials and stores them as vault resources in one local operation, keeping the secret material inside the script's shell process so only the URNs reach the agent.

Invoke the script (`<vault-provider-id>` was resolved in §0e):

```bash
bash scripts/provision-credentials.sh \
  --zone "<zone-id>" \
  --org "<org-id>" \
  --app-id "<bridge-application-id>" \
  --vault-provider "<vault-provider-id>" \
  --name "<name>"
```

The script issues the bridge's `client_id` / `client_secret` and stores them as vault resources at `urn:<name>:client_id` and `urn:<name>:client_secret` without ever exposing the values to the agent transcript.

If the script fails, tell the user the provisioning step did not complete and they will need to issue the bridge credentials and create the two vault resources themselves — and to reach out to Keycard support if they get stuck. The agent MUST NOT attempt to recover by issuing the credentials itself, because that would expose the secret material in the tool-call transcript.

If the vault resources already exist, the script exits non-zero. To rotate, delete the existing vault resources first and re-run.

### 1g. Webhook secret vault resource

The bridge verifies incoming webhooks via HMAC-SHA256 using a shared secret stored in the vault. Run:

```bash
bash scripts/provision-webhook-secret.sh \
  --zone "<zone-id>" \
  --org "<org-id>" \
  --vault-provider "<vault-provider-id>" \
  --name "<name>"
```

The script generates a random 32-byte hex secret via `openssl rand -hex 32` and stores it at `urn:<name>:webhook_secret`, keeping the value inside the script's shell process.

If the script fails, abort and ask the user to create the vault resource manually in Console with identifier `urn:<name>:webhook_secret`.

### 1h. Impersonation policy

**Intent.** Policies are shared zone state and must be changed with care. The agent's edit MUST be additive: leave every other policy in the zone untouched, and own exactly one policy named `<name>-impersonation` whose Cedar body permits this bridge application to impersonate users. Impersonation is forbidden by default — without this policy every impersonation call fails with `access_denied`.

**Desired policy.** Name `<name>-impersonation`, body:

```cedar
permit (
  principal is Keycard::Application,
  action,
  resource
)
when {
  principal.identifier == "<name>" &&
  context.impersonate == true &&
  context has subject
};
```

**How to achieve it.** Use the Keycard Management API to read the zone's policies and decide which of three cases applies — never blind-write:

1. **No policy named `<name>-impersonation`** → create it with the body above.
2. **Policy exists with the body above** (compare after whitespace normalisation) → already in place; reuse and move on.
3. **Policy exists with a different body** → do NOT silently overwrite. Show the user a diff (current vs desired), get explicit confirmation, then update the body. If the user declines, stop and ask them to reconcile the policy in `https://console.keycard.ai → Policies` before retrying.

When reading or writing the policy body, response and request shapes can vary across Keycard builds (`policy`, `body`, `latest_version.body`; PATCH-on-policy vs. a `/versions` or `/draft` subroute). Resolve the exact shape from the API reference; the desired end-state is unchanged: a single policy named `<name>-impersonation` whose latest active version contains exactly the Cedar text above.

If the policy API is unavailable in this Keycard build, stop and ask the user to apply the Cedar above manually in `https://console.keycard.ai → Policies` as `<name>-impersonation`. The agent MUST NOT proceed past §1h until the policy is in place — verified either by the API call succeeding or by the user confirming the manual apply.

#### Customisation

To scope impersonation to specific users, replace `context has subject` with `context.subject.identifier == "user@example.com"` or a set membership check. The policy above is the broadest safe default — it permits impersonation for any user who has a delegated grant for the resource.

## 2. Configuration the agent MUST write

### KEYCARD_URL

`KEYCARD_URL` is `https://<id>.keycard.cloud`, where `<id>` is the user's Keycard zone ID.

### .env

Write `.env` in the project root from `.env.example`:

```
KEYCARD_URL=https://<id>.keycard.cloud
PORT=<port>
IMPERSONATION_RESOURCE=https://mcp.linear.app/mcp
```

`KEYCARD_URL` is read by the bridge. `main.py` loads `.env` via `python-dotenv` (`load_dotenv(find_dotenv(usecwd=True))`), so it is picked up automatically when the server starts.

`.env` MUST NOT contain `KEYCARD_CLIENT_ID`, `KEYCARD_CLIENT_SECRET`, or `WEBHOOK_SECRET` — they are brokered at runtime by `keycard run`.

### keycard.toml

The template ships a minimal `keycard.toml` at the project root with `[org]` and `[zone]` placeholder blocks:

```toml
[org]
id = "<org-id>"

[zone]
id = "<zone-id>"
```

The agent MUST replace both placeholder IDs with the values from the user's existing zone-bound `keycard.toml` (the one already present in the parent / cwd before scaffolding). If no such file exists, abort and tell the user to run `keycard init` first — without it, `keycard run` cannot authenticate.

Then the agent MUST ensure the three `[[credentials.default]]` entries match:

```toml
[[credentials.default]]
env_var = "KEYCARD_CLIENT_ID"
resource = "urn:<name>:client_id"

[[credentials.default]]
env_var = "KEYCARD_CLIENT_SECRET"
resource = "urn:<name>:client_secret"

[[credentials.default]]
env_var = "WEBHOOK_SECRET"
resource = "urn:<name>:webhook_secret"
```

Substitute `<name>` for the kebab-case project name so the URNs line up exactly with what the provisioning scripts created.

Use the `keycard-upsert-config` skill for these edits. Nothing else belongs in `keycard.toml` — the bridge reads runtime config (`KEYCARD_URL`, `PORT`, `IMPERSONATION_RESOURCE`) from `.env`. TOML does not expand environment variables, so never write `${...}` syntax into `keycard.toml`.

### Source-file `<name>` substitutions

Two source files ship with the template's own name hard-coded and MUST be rewritten to `<name>` whenever the project is scaffolded under a different name (i.e. any time `<name>` != `webhook-impersonation-python`). If left unchanged, the webhook CLI will read the wrong vault URN and every send will fail with "credential not found", and `pyproject.toml`'s `[project].name` will collide with the template.

| File | Literal to replace | Replace with |
|---|---|---|
| `tools/send_webhook.py` | `PROJECT_NAME = "webhook-impersonation-python"` | `PROJECT_NAME = "<name>"` |
| `config.py` | `SERVER_NAME = "webhook-impersonation-python"` | `SERVER_NAME = "<name>"` |
| `pyproject.toml` | `name = "webhook-impersonation-python"` | `name = "<name>"` |

After editing, grep the project tree for `webhook-impersonation-python` and confirm the only remaining matches are inside `SPEC.md` and `README.md` (documentation, untouched). Any hit in `.py`, `.toml`, or `.sh` files means a substitution was missed.

## 3. User pre-flight — delegated grant

**This step is critical and MUST be narrated prominently.** Each user who will be impersonated MUST run, once, in their own shell:

```bash
keycard auth resource https://mcp.linear.app/mcp
```

This authenticates the user with their identity provider and creates a delegated grant in Keycard for the Linear resource. Without it, every impersonation call for that user returns `access_denied`.

The agent narration must call this out:
- Before the handoff, as a prerequisite
- In the demo runbook, as Terminal 1's action
- After the handoff, alongside the test command, noting that skipping it produces a 403

The same command can be re-run to re-authorize if the grant is revoked.

## 4. Agent verification

There is no build step for Python — `uv sync` installs dependencies but no compilation is required. Verify the vault resources exist and are wired to a `keycard-vault` provider. Do NOT use `keycard run` here: it requires an interactive TTY and will not nest inside the agent's own `keycard run` session — the actual `keycard run` test happens when the user starts the bridge themselves.

```bash
uv sync
```

Then a non-interactive smoke test that all three vault resources exist:

```bash
for urn in "urn:<name>:client_id" "urn:<name>:client_secret" "urn:<name>:webhook_secret"; do
  keycard agent api "/zones/<zone-id>/resources?identifier=${urn}" --org "<org-id>" \
    | jq -e --arg u "$urn" '.items[] | select(.identifier == $u) | .credential_provider_id' >/dev/null \
    || { echo "MISSING: $urn"; exit 1; }
done
echo "OK: all three vault resources resolve"
```

All three lookups MUST succeed and return a non-null `credential_provider_id`. If any fail, the most likely causes are:

- the matching vault resource does not exist, has the wrong identifier, or a provisioning script failed before attaching the secret
- a `[[credentials.default]]` entry pointing at the wrong URN — re-check the `<name>` substitution in the appended blocks
- `keycard.toml` has unresolved `<org-id>` / `<zone-id>` placeholders, or is missing `[org]` / `[zone]` blocks entirely — `keycard run` will fail to authenticate when the user runs the bridge

Do NOT start the bridge server inside the agent session. The user starts it themselves in §6.

## 5. Agent guardrails

Quick-reference prohibitions:

- Do not modify the user's pre-existing `keycard.toml` outside the project directory. The project-local one is bootstrapped from it but lives independently.
- Do not run the underlying `keycard agent api .../credentials` call yourself — always invoke `scripts/provision-credentials.sh`. The credential payload must not appear in any tool-call transcript.
- Do not commit `.env`, `KEYCARD_URL`, or anything containing the Keycard ID.
- Do not add `[project]`, `[server]`, `schema_version`, or any `[zone].url` field to `keycard.toml`. The shipped file is intentionally minimal — only `[org].id`, `[zone].id`, and the three `[[credentials.default]]` blocks belong there.
- Do not write the webhook secret into source / `.env` / chat transcript — always go through `scripts/provision-webhook-secret.sh`.
- Do not print SPEC phrasing such as "transitive consent", "RFC 8693", "client_assertion", "private_key_jwt", "substitute-user", or "bearer token" in any user-facing message — translate to outcomes per §0c.

## 6. Handoff data (for the skill to render)

The skill renders the handoff from the following data:

| Key | Value | Run-where | Reason (plain outcomes) |
|---|---|---|---|
| `name` | `<name>` | — | Kebab-case project name used everywhere |
| `port` | `<port>` | — | Local HTTP port the bridge listens on |
| `install_command` | `uv sync` | this session | Installs dependencies |
| `consent_command` | `keycard auth resource https://mcp.linear.app/mcp` | each impersonated user's terminal, once | Creates the delegated grant that impersonation requires — without it every call returns 403 |
| `start_command` | `cd <name> && keycard run -- uvicorn main:app --host 0.0.0.0 --port <port>` | server terminal (keep open) | The wrapper hands the bridge its credentials at startup; the bridge refuses to work without them |
| `expected_ready_log` | uvicorn startup output on port `<port>` | — | Signal to wait for before sending webhooks |
| `try_it` | `uv run send-webhook --user alice@example.com --team Engineering --title "Investigate flaky test"` | sender terminal | Confirms the bridge can impersonate Alice, resolve the team name to its Linear UUID, and create a Linear issue |
| `try_it_tamper` | `uv run send-webhook --user alice@example.com --team Engineering --title "..." --tamper` | sender terminal | Confirms HMAC verification rejects tampered signatures (expect 401) |
| `try_it_no_consent` | `uv run send-webhook --user nobody@example.com --team Engineering --title "..."` | sender terminal | Confirms impersonation fails for users without a delegated grant (expect 403) |
| `verify` | Server logs + Linear UI + Keycard Console → Audit Logs | — | Three-way confirmation that the issue was created as the impersonated user |

The demo uses three terminals: one to run `consent_command` once per impersonated user, one to keep `start_command` running, and one to fire `try_it` (and the `_tamper` / `_no_consent` variants) repeatedly.

### Carried IDs for the recap

After §1 and §4, the agent has these values in hand: `<zone-id>`, `<linear-provider-id>`, `<linear-application-id>`, `<linear-resource-id>`, `<bridge-application-id>`, `<vault-provider-id>`, and the verified vault URNs (`urn:<name>:client_id`, `urn:<name>:client_secret`, `urn:<name>:webhook_secret`). The skill renders them in its own voice. Point the user at `https://console.keycard.ai` for looking up any of the registered IDs.

## 7. What to say to the user (per-step narration)

The `keycard-template-app` skill prescribes the narration style; the lines below supply the template-specific *content*. Paraphrase into the skill's voice — never read verbatim, and follow the jargon prohibition in §5. Use §0c for first-mention framing; after that, use plain outcome language.

| Step | Tell the user before you start |
|---|---|
| Step 4 (copy) | "Copying the `webhook-impersonation-python` blueprint into `./<name>` — this gives you a webhook bridge that talks to Linear's MCP server using Keycard-brokered impersonation. No Linear API key needed, and no user needs to be present when the webhook fires." |
| Step 6 (fill in) | "Filling in `.env` with your zone's URL and a free local port. I'll also write `keycard.toml` with your zone/org IDs and three credential entries — those tell `keycard run` to broker the bridge's `client_id`, `client_secret`, and the webhook HMAC secret from the zone vault at startup." |
| Step 7 (register) | "This template needs several Keycard primitives. I'm about to register: (1) an OAuth provider for Linear so Keycard can broker tokens to `mcp.linear.app`, (2) a Linear Application + Resource so Keycard knows what it's brokering, (3) your bridge's own Application, (4) a dependency from the bridge to Linear — dependencies control which resources an application can access, (5) application credentials + a webhook secret stored in the zone vault, and (6) a Cedar policy that allows the bridge to impersonate users. Each builds on the previous — I'll name what I get back after each step." |
| Step 8 (smoke-test) | "Installing dependencies with `uv sync` and verifying all three vault resources (`urn:<name>:client_id`, `urn:<name>:client_secret`, and `urn:<name>:webhook_secret`) resolve correctly in the API. I'm not starting the server here — it needs `keycard run` to broker the secrets into the process, which can't nest inside the agent session. The actual end-to-end test happens when you run it yourself in the next step." |
| Step 9 (handoff) | "All the Keycard-side setup is done — your zone knows about the bridge, has the Linear dependency wired, and the vault holds all three secrets. An impersonation policy is in place. The last bit has to happen in your terminal: start the bridge with `keycard run -- uvicorn main:app --host 0.0.0.0 --port <port>`, then fire test webhooks from a second terminal with `uv run send-webhook`." |
