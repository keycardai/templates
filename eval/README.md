# Keycard Template Eval

End-to-end eval harness for Keycard templates. Tests whether a Claude agent can correctly follow a template's `SPEC.md` to provision Keycard resources and produce a working, Keycard-authenticated project.

There are two flows, picked automatically from the template's shape.

## Server templates (inbound auth)

The `mcp-server-*` templates are servers that authenticate requests coming in.

1. Creates an ephemeral Keycard zone
2. Runs a Claude agent against the template's `SPEC.md`, which provisions the zone's Application and Resource, writes config files, and starts the server
3. Uses Playwright to authenticate as a test user via the zone's OAuth consent flow
4. Verifies the server accepts authenticated requests and rejects unauthenticated ones
5. Tears down the Application + Resource (zone is reused)

## Agent templates (outbound auth)

`agent-python-langchain` is an agent, not a server: it authenticates outward, so
there is no inbound request to accept or reject. A template is treated as an
agent when it has a `langgraph.json`, and the flow then differs in three places.

1. **Identity comes from impersonation, not a browser.** A substitute-user token
   exchange against the zone mints a real zone-issued user token, authorized by
   the agent application's own credential plus the zone's impersonation policy.
   The harness writes it to the template's `.env` as `KEYCARD_SUBJECT_TOKEN`,
   which is exactly what `calendar_agent/signin.py` writes after an interactive
   sign-in. Playwright never runs, and `browser.ts` is untouched.
2. **The calendar is a local stub, not Google.** The harness starts an HTTP
   server that answers the Google Calendar routes the template's tools call,
   registers it in the zone as the resource the agent depends on, and points
   `KEYCARD_RESOURCE` at it. The stub verifies every bearer token it receives
   against the zone's JWKS, checking issuer, audience and expiry.
3. **Verification asserts on the outbound call.** `verify-agent.ts` checks the
   agent's health endpoint, checks that the stub rejects an unauthenticated
   call, drives one real model turn asking for today's events, and then asserts
   that the tool call reached the stub carrying a zone-verified token audienced
   at the stub resource with the impersonated user as its subject. That covers
   provisioning, grant, mint and outbound call with no Google account.

Two resources are provisioned rather than one: the stub calendar resource, and
a resource the application owns whose identifier is the agent's own URL. The
second is `SPEC.md` section 1c, and without it every exchange fails with
`invalid_grant`. Both use the zone's Zone Provider, which is what makes the
minted calendar credential a zone JWT the stub can verify.

Impersonation needs an explicit permit. Since svc-pdp #220 (ACC-980) the
managed `default-app-direct-access` policy permits dependency-based access only
when `context.on_behalf` and `context.impersonate` are both false, and no
managed policy permits impersonation; a customer policy has to grant it.
Provisioning therefore ensures the eval zone carries a standing customer policy
named `eval-impersonation-permit` (`policy.ts`), scoped to applications whose
identifier matches `eval-app-*`, which is what every run's application is named.
The policy is looked up by name and only created when missing, then added to
the zone's active policy set alongside every existing policy (or, if that set is
platform-owned, in a customer set `eval-policy-set` that carries the same
content). The provisioning log reports whether the permit was found or created.

The application is created with `consent: "implicit"`. The shipped template
keeps the default (`required`) because the consent screen is part of the demo,
but a headless run has no one to click it.

The boot smoke test (`agent-python-langchain/scripts/ci-verify.sh`) already
covers startup, the graph registering, unit guards and the Fly image build. This
eval does not repeat any of it.

## Setup

```bash
cd eval
npm install
npx playwright install chromium
```

### 1. Fill in `keycard.toml`

Edit `eval/keycard.toml` and replace the placeholders:

- `[org] id` — your Keycard organization ID (Console → Settings)
- `[zone] id` — a dedicated eval zone ID (create one in Console, configure zone auth with no external IDP and no invite requirement)

### 2. Provision vault resources

In Keycard Console, create three vault resources in your eval zone:

| Resource URN | Secret |
|---|---|
| `urn:keycard-eval:anthropic_api_key` | Your Anthropic API key |
| `urn:keycard-eval:test_user_email` | Email for the Playwright test user |
| `urn:keycard-eval:test_user_password` | Password for the Playwright test user |

### 3. Bootstrap credentials

Copy `.env.eval.example` to `.env.eval` and fill in the service account credentials (these bootstrap zone creation and can't live in Keycard itself):

```bash
cp .env.eval.example .env.eval
```

### 4. One-time test user signup

Run once with a visible browser to sign up the test user in the eval zone:

```bash
EVAL_HEADLESS=false keycard run -- npm run eval -- --template mcp-server-typescript-express
```

When the browser opens, sign up with the email/password from your vault resources. Verify your email. After that, all subsequent runs are fully headless.

## Run

```bash
keycard run -- npm run eval -- --template mcp-server-typescript-express
keycard run -- npm run eval -- --template agent-python-langchain
```

The agent template needs `uv` on PATH and no vault resources beyond the three
above. `EVAL_TEST_USER_EMAIL` doubles as the impersonation target, so that user
must exist in the eval zone; the password is unused on this path.

### Skipping templates

`eval-skip.txt` lists templates the weekly workflow's discover job leaves out
of the matrix, one directory name per line with `#` comments. It holds
templates the harness has no flow for yet (`autonomous-agent-snowflake-wif` is
an A2A agent, which the MCP-server flow cannot start or probe). A named
`workflow_dispatch` template input bypasses the list, since naming a template
is operator intent.

### Harness notes for the build agent

`index.ts` keeps a notes map keyed by template name, passed to `runBuildAgent`
as extra constraints that override `SPEC.md` where the eval's provisioning
deliberately differs from it. The two `mcp-brokered-credentials-*` templates
carry notes saying the provisioned zone-native resource and config are correct
as written, because without them the agent spent every turn reconciling the
config toward the SPEC's brokered external-provider setup and never built.

## Environment variables

| Variable | Used by | Meaning |
|---|---|---|
| `CI_KEYCARD_CLIENT_ID`, `CI_KEYCARD_CLIENT_SECRET`, `CI_KEYCARD_ENDPOINT` | both | Service account that creates the zone |
| `ANTHROPIC_API_KEY` | both | Drives the build agent, and the agent template's model turn |
| `EVAL_TEST_USER_EMAIL` | both | Browser sign-in for servers, impersonation target for agents |
| `EVAL_TEST_USER_PASSWORD` | servers | Browser sign-in only |
| `EVAL_HEADLESS` | servers | Set to `false` to watch the browser |
| `EVAL_ZONE_ID`, `EVAL_ZONE_ISSUER_URL` | both | The persistent eval zone. Required for agent templates: impersonation needs a zone user that already exists |
| `EVAL_ALLOW_EPHEMERAL` | servers | Create a throwaway zone instead. Agent templates refuse it, since a fresh zone has no users to impersonate |
| `EVAL_AGENT_PORT` | agents | Port for `langgraph dev`, default `2024` |
| `EVAL_STUB_PORT` | agents | Port for the stub calendar, default `8901` |
| `EVAL_AGENT_MODEL` | agents | Model for the agent's own turn, default `claude-sonnet-4-6` |
