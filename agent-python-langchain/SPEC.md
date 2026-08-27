# SPEC: agent-python-langchain

A LangChain **agent** whose access to Google Calendar is brokered by Keycard. It
uses `KeycardGrantMiddleware` from `keycardai-langchain` to exchange the
signed-in user's token for a short-lived Google Calendar credential at every
tool call, so the agent never holds a calendar API key and every call is audited
as a delegation chain. Sign-in and consent both surface as LangGraph interrupts,
inside the chat.

Pick this template to see delegated, per-tool-call access in a LangChain agent,
or as the starting point for an agent that acts on a user's third-party accounts.

The agent (e.g. the `keycard-template-app` skill) MUST perform every step in
this document before declaring the project ready.

Throughout, treat `<name>` as the kebab-case project name (default:
`agent-python-langchain`), `<agent-port>` as the agent server port (default:
`2024`), and `<signin-port>` as the sign-in page port (default: `8765`).

## 0. How the agent uses this document

**This SPEC is input for the agent, not output for the user.** The
`keycard-template-app` skill is the sole renderer of user-facing narration. Read
this document, extract the structured data below, and reason from it, but never
quote or print any of it verbatim. Paraphrase before showing anything.

## 0c. Concepts the agent should introduce

Introduce each concept once, the first time it appears. Use the framing below and
include the docs link.

| Order | Concept | First appears at | One-sentence framing | Docs |
|---|---|---|---|---|
| 1 | Zone | Step 3 (resolve context) | Your private Keycard environment that holds users, apps, and policies and issues credentials. | https://docs.keycard.ai/platform/concepts/zones/ |
| 2 | Catalog | §1a (Google Calendar) | A library of ready-made integrations: installing one provisions the provider and resource for you instead of hand-configuring OAuth. | https://docs.keycard.ai/platform/concepts/resources/ |
| 3 | Credential provider | §1a (Google Calendar) | The upstream identity provider Keycard brokers credentials from, here Google. | https://docs.keycard.ai/platform/concepts/providers/ |
| 4 | Resource | §1a (Google Calendar) | The protected API the agent calls; the identifier must match exactly so Keycard knows which credential to issue. | https://docs.keycard.ai/platform/concepts/resources/ |
| 5 | Application | §1b (agent application) | A software actor registered with Keycard, so Keycard knows who is asking for credentials. | https://docs.keycard.ai/platform/concepts/applications/ |
| 6 | Dependency | §1d (wiring) | A declared relationship controlling which resources an application may access. | https://docs.keycard.ai/platform/concepts/applications/#dependencies |
| 7 | Token exchange (delegated access) | §4 (smoke test) | The agent trades the user's token for a short-lived credential scoped to one resource, so it acts on the user's behalf without ever holding their password or a long-lived key. | https://docs.keycard.ai/platform/architecture/standards-and-protocols/ |

## 0-prereq. Prerequisites

### 0a. A Google Cloud OAuth client

The first Google catalog install needs a Google OAuth client (id + secret). The
agent MUST NOT attempt to create this: direct the user to do it, and give them
the exact redirect URI to register, which is
`https://<zone-id>.<env-domain>/oauth/2/redirect` (the installed catalog
package's setup guide also prints it, and is the authoritative source).

Steps for the user, in Google Cloud Console:

1. Enable the **Google Calendar API** on the project.
2. On the OAuth consent screen, add scopes `calendar.readonly` and
   `calendar.events`, and add themselves as a test user if the app is in testing.
3. Credentials, then Create Credentials, then OAuth client ID, type **Web
   application**, and register the redirect URI above.

Collect the client id and secret into a gitignored env file. **Never echo the
secret into narration or a transcript**; pass it into request bodies from the
env file (e.g. via `jq --arg`).

### 0b. Model access

The agent reaches Anthropic on one of two paths, and the code picks by
environment:

- **Brokered (workload identity federation).** Keycard mints a zone token for
  the agent application and Anthropic exchanges it for an access token. Needs
  the provisioning in §1e, and no key is written to `.env`.
- **API key.** `ANTHROPIC_API_KEY` in `.env`. Auto-resolve from Keycard
  resources if the zone already has one; otherwise ask the user for it once.

The brokered path requires an Anthropic organization the user administers, so
fall back to the API key when §1e cannot be completed.

## 1. Keycard primitives to provision

Read before write at every step: this is idempotent, and the catalog install
endpoint specifically is **not** idempotent and has no uninstall, so a duplicate
install leaves a second resource behind.

### 1a. Google Calendar, from the catalog

Do not hand-build the provider and resource. Install the catalog package.

```bash
# resolve the package id from the slug (installs take the 26-char id, not the slug)
keycard agent api --org "$ORG" \
  "/catalog/zones/$ZONE/packages?limit=100&query[]=Google" \
  | jq -r '.items[] | select(.slug=="google-calendar") | .id'

# read the form BEFORE building the body: once the zone holds the Google
# provider, form.fields comes back empty and the body must omit "fields"
keycard agent api --org "$ORG" "/catalog/zones/$ZONE/packages/$PKG_ID" | jq '.form.fields'

# install (guard first: skip if a resource with identifier
# https://www.googleapis.com/calendar/v3 already exists)
env -u KEYCARD_SOCKET keycard agent api --org "$ORG" "/catalog/zones/$ZONE/install" -X POST \
  -d "$(jq -n --arg id "$PKG_ID" --arg cid "$GOOGLE_CLIENT_ID" --arg cs "$GOOGLE_CLIENT_SECRET" \
        '{package_id: $id, fields: {client_id: $cid, client_secret: $cs}}')"
```

This creates the shared **Google** credential provider (identifier
`https://accounts.google.com`) and a resource with identifier
`https://www.googleapis.com/calendar/v3`. Note the installed resource's slug is
`google-calendar-api`, **not** the package slug, so guard on the identifier.

A 201 returns no body, and `keycard agent api` prints only bodies, so verify by
listing resources rather than reading the response.

Then pin the scopes the agent needs (the api-server package installs none):

```bash
env -u KEYCARD_SOCKET keycard agent api --org "$ORG" "/zones/$ZONE/resources/$CALENDAR_RESOURCE_ID" -X PATCH \
  -d '{"scopes": ["https://www.googleapis.com/auth/calendar.readonly", "https://www.googleapis.com/auth/calendar.events"]}'
```

Both scopes are required for the demo: read alone makes the write pause for
consent, which is the point, but the grant has to be *available* to be granted.

### 1b. The agent application

```bash
env -u KEYCARD_SOCKET keycard agent api --org "$ORG" "/zones/$ZONE/applications" -X POST -d '{
  "name": "LangChain Calendar Agent",
  "identifier": "langchain-calendar-agent",
  "protocols": {"oauth2": {"redirect_uris": ["http://localhost:<signin-port>/callback"]}}
}'
```

Leave `consent` at its default (`required`). The consent screen is a feature of
this template, not an obstacle.

Then a password credential. The response carries `password` **once**: write it to
`.env` as `KEYCARD_CLIENT_SECRET` and never into narration.

```bash
env -u KEYCARD_SOCKET keycard agent api --org "$ORG" "/zones/$ZONE/application-credentials" -X POST \
  -d '{"application_id": "APP_ID", "type": "password", "identifier": "langchain-calendar-agent"}'
```

The credential's `identifier` doubles as the OAuth client id, and the returned
`password` as the client secret.

### 1c. A resource the agent owns (do not skip this)

**This is the least obvious requirement in the whole setup.** Keycard's STS only
lets an application exchange a subject token whose **first audience is a resource
that application owns** (see `validateResource` in
`svc-sts/src/handlers/oauth2/exchange/validators.js`). It is the "I am the
resource server receiving this token" invariant, the same one an MCP server
satisfies.

Without it, every exchange fails with `invalid_grant: Client is not allowed to
exchange token for this resource`, no matter how the dependencies are wired,
because a default sign-in produces a token audienced at the zone's
`openid-connect-userinfo` resource.

```bash
env -u KEYCARD_SOCKET keycard agent api --org "$ORG" "/zones/$ZONE/resources" -X POST -d '{
  "name": "LangChain Calendar Agent",
  "identifier": "http://localhost:<agent-port>",
  "application_id": "APP_ID",
  "credential_provider_id": "ZONE_PROVIDER_ID",
  "application_type": "native",
  "prefix": true
}'
```

`credential_provider_id` is the zone's **Zone Provider** (list providers and take
the one named `Zone Provider`). It is required: without it the authorize call
fails with `Resource "..." is missing a credential provider`. Every zone-native
resource uses it.

### 1d. Wiring

Add the Calendar resource as a dependency of the agent application (204,
idempotent):

```bash
env -u KEYCARD_SOCKET keycard agent api --org "$ORG" \
  "/zones/$ZONE/applications/$APP_ID/dependencies/$CALENDAR_RESOURCE_ID" -X PUT
```

### 1e. Anthropic, brokered through workload identity federation

Only for the brokered model path (§0b). Skip the whole subsection on the API key
path.

#### Prerequisite in the Anthropic console

The agent MUST NOT attempt this: it needs Anthropic organization admin rights.
Direct the user to the Anthropic console to add a workload identity federation
issuer for the zone (issuer URL `https://<zone-id>.<env-domain>`, the same value
as `KEYCARD_ZONE_URL`) and a federation rule whose subject match is the agent
application's **identifier** (`langchain-calendar-agent` from §1b), then collect
four ids from them:

| Value | Where it comes from | `.env` variable |
|---|---|---|
| Federation rule id | The rule created on the issuer | `ANTHROPIC_FEDERATION_RULE_ID` |
| Organization id | Organization settings, a raw UUID | `ANTHROPIC_ORGANIZATION_ID` |
| Service account id | The service account the rule mints tokens for | `ANTHROPIC_SERVICE_ACCOUNT_ID` |
| Workspace id | A `wrkspc_`-prefixed id, from a dedicated workspace | `ANTHROPIC_WORKSPACE_ID` |

Two traps in that console flow, both of which produce a rejected exchange rather
than a clear error:

1. The issuer form's **max token lifetime** defaults to 1 hour. Zone tokens are
   exactly 24 hours, so a 1 hour limit rejects every token. Set it to 24.
2. The **Default** workspace has no id and cannot be used with federation. Have
   the user create a dedicated workspace and take its `wrkspc_` id.

The subject match is the application **identifier**, which is what the zone puts
in the token's `sub` claim, not the 26-character application id. The token also
carries a `keycard_app_id` claim holding that 26-character id, which the rule can
add as an optional exact-match condition to pin the rule to one application even
if an identifier is later reused.

#### Keycard resource and grant

The Anthropic API is a zone-native resource, so it takes the **Zone Provider**
like §1c (guard on the identifier first):

```bash
env -u KEYCARD_SOCKET keycard agent api --org "$ORG" "/zones/$ZONE/resources" -X POST -d '{
  "name": "Anthropic API",
  "identifier": "https://api.anthropic.com",
  "credential_provider_id": "ZONE_PROVIDER_ID",
  "application_type": "native",
  "prefix": true
}'
```

Then grant it to the agent application as a dependency (204, idempotent):

```bash
env -u KEYCARD_SOCKET keycard agent api --org "$ORG" \
  "/zones/$ZONE/applications/$APP_ID/dependencies/$ANTHROPIC_RESOURCE_ID" -X PUT
```

The agent then acquires model credentials under its own identity
(`Access.as_self()`, client credentials), so the model call is audited as the
application rather than as a user.

## 2. Files to write

`.env`, from the values produced above:

```
KEYCARD_ZONE_URL=https://<zone-id>.<env-domain>
KEYCARD_RESOURCE=https://www.googleapis.com/calendar/v3
KEYCARD_AGENT_RESOURCE=http://localhost:<agent-port>
KEYCARD_CLIENT_ID=langchain-calendar-agent
KEYCARD_CLIENT_SECRET=<from §1b, once>
KEYCARD_AUTHORIZATION_PAGE=http://localhost:<signin-port>/
ANTHROPIC_API_KEY=<from §0b, API key path only>
ANTHROPIC_MODEL=claude-opus-5
```

On the brokered model path, omit `ANTHROPIC_API_KEY` and write the four ids from
§1e instead:

```
ANTHROPIC_FEDERATION_RULE_ID=<from §1e>
ANTHROPIC_ORGANIZATION_ID=<from §1e>
ANTHROPIC_SERVICE_ACCOUNT_ID=<from §1e>
ANTHROPIC_WORKSPACE_ID=<from §1e>
```

All four are required together: with any of them missing the agent reads
`ANTHROPIC_API_KEY`. `ANTHROPIC_RESOURCE` defaults to `https://api.anthropic.com`
and only needs setting for a non-default Anthropic deployment.

`KEYCARD_SUBJECT_TOKEN` is written by `calendar_agent/signin.py`; do not set it by hand.

## 3. Build and run

```bash
uv sync
uv run python calendar_agent/signin.py --serve      # sign-in + consent page, <signin-port>
uv run langgraph dev --no-browser        # agent server, <agent-port>
```

`langgraph dev` reads `.env` at startup, so start it after `.env` exists.
`signin.py --serve` listens without signing anyone in, which is what makes the
in-chat sign-in demonstrable.

## 4. Smoke tests

1. **Server is up**: `curl -s http://127.0.0.1:<agent-port>/ok` returns
   `{"ok":true}`, and `POST /assistants/search` with `{}` lists an assistant
   named `agent`.
2. **Sign-in interrupt**: with no `KEYCARD_SUBJECT_TOKEN` in `.env`, send a run
   asking about the calendar. Expect it to pause with an interrupt whose payload
   `type` is `sign_in_required` and whose `sign_in_url` points at the sign-in
   page. No exchange should have been attempted.
3. **Sign in**: open the sign-in page, complete the flow, and confirm
   `KEYCARD_SUBJECT_TOKEN` appears in `.env`. Confirm the consent screen listed
   the agent and Google Calendar.
4. **Read succeeds**: resume the run and expect real calendar events, with the
   tool result's `window.date` matching today's actual date.
5. **Delegation is audited**: in the console audit log, find a
   `credentials:issue` event whose actor is an `identity_chain` containing both
   the application and the user, and a token-exchange event naming the Google
   Calendar resource.

6. **Brokered model access** (brokered path only): with no `ANTHROPIC_API_KEY`
   in `.env`, send any run and expect a model reply. In the audit log, find a
   `credentials:issue` event for `https://api.anthropic.com` whose actor is the
   agent application alone, with no user in the chain.

If step 2 does not pause, `KEYCARD_SUBJECT_TOKEN` is already set: clear it and
restart the agent server.

## 5. What the agent must NOT do

- Do not create the Google Cloud OAuth client, or ask for the secret in chat.
  Direct the user to the console and read it from the env file.
- Do not print `KEYCARD_CLIENT_SECRET`, `GOOGLE_CLIENT_SECRET`, or any access
  token into narration.
- Do not retry a catalog install on a non-2xx. It is not idempotent and has no
  uninstall; list resources and report what exists.
- Do not set `consent` to `implicit` on the agent application to avoid the
  consent screen.
- Do not hand-write `KEYCARD_SUBJECT_TOKEN`.
- Do not create the Anthropic federation issuer, rule, or workspace. They need
  Anthropic organization admin rights: direct the user to the console and read
  the four ids from the env file.
- Do not set both `ANTHROPIC_API_KEY` and the four federation ids: the key path
  is the fallback, and keeping the key defeats the point of the brokered path.

## 6. Handoff

Tell the user:

- The chat URL if they ran a UI, or the curl form if not.
- That sign-in and consent happen in the chat, and that the write will pause
  separately from the read if only read has been granted.
- Where to see the delegation chain in the console audit log.
- Which model path is in use. On the API key path, that
  `KEYCARD_CLIENT_SECRET` and `ANTHROPIC_API_KEY` are the two static secrets and
  both can be removed (workload identity for the agent, §1e for Anthropic). On
  the brokered path, that `KEYCARD_CLIENT_SECRET` is the only one left.
