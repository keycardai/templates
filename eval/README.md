# Keycard Template Eval

End-to-end eval harness for Keycard templates. Tests whether a Claude agent can correctly follow a template's `SPEC.md` to provision Keycard resources and produce a working, Keycard-authenticated project.

There are two flows, picked automatically from the template's shape.

## Server templates (inbound auth)

The `mcp-server-*` templates are servers that authenticate requests coming in.

1. Uses the configured Keycard zone (or creates an ephemeral zone if explicitly enabled)
2. Provisions the Application and Resource, writes config files, runs a Claude agent against the template's `SPEC.md` to build the project, and starts the server
3. Uses Playwright to authenticate as a test user via the zone's OAuth consent flow
4. Verifies the server accepts authenticated requests and rejects unauthenticated ones
5. Tears down the job's Application and Resource, including after a failure

Before provisioning in the shared zone, each job removes abandoned per-run
applications and resources older than 12 hours. The cutoff is twice the
default GitHub Actions job timeout and leaves fresh provisioning untouched.

Resource URLs use a per-job hostname under `.localhost` so the registered
identifiers are distinct without changing routes such as `/mcp`. CI derives
the hostname from the template name, GitHub run ID, and run attempt; local
runs use a random suffix. Harness probes and the browser callback use literal
`localhost`; OAuth audiences and resource metadata retain the job URL. The
LangChain calendar tools and Python A2A caller use their configured resource
URLs as destinations, so those templates still need a resolver that maps
`*.localhost` to loopback. The eval reuses one public dynamic client
registration per zone. The read-only zone preflight runs before any job
provisions resources.

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

## Cloudflare Workers templates (delegated access)

A `wrangler.jsonc`, `wrangler.json`, or `wrangler.toml` selects the headless
Cloudflare flow. It requires the persistent eval zone and an existing
`EVAL_TEST_USER_EMAIL` zone user. Do not run it concurrently with another
eval using that zone.

1. The harness provisions an implicit-consent application with a password
   credential for harness-only user impersonation. Both HTTP resources use
   the Zone Provider: the Worker owns the inbound audience and depends on
   the downstream stub. The existing scoped impersonation permit is reused.
2. The build agent installs and builds from SPEC.md without credentials.
   The harness then generates a per-run RSA PKCS#8 key and writes it to the
   gitignored `.dev.vars` file with mode 0600 before starting local Wrangler.
3. An anonymous cloudflared quick tunnel exposes the SDK's JWKS endpoint so
   the zone can fetch the key. The harness confirms the public JWKS before
   registering the public-key application credential. No Cloudflare
   account, login, deployment, or account resources are involved.
4. The harness mints a user token for the Worker audience and calls
   `GET /call`. The local calendar stub verifies the downstream token's
   signature against the zone JWKS plus its issuer, audience, and subject.
   The harness checks that `client_id` names the public-key credential,
   requires a 401 without a token, and captures a separate
   assertion from the template's actual token cache in Node, verifying
   `iss`, `sub`, and `aud` against configuration and zone discovery.
5. Cleanup stops the Worker, tunnel, and stub, deletes the credentials,
   application, and resources, and removes the local key file.
   Failed runs print bounded, redacted Wrangler and cloudflared output.

The device grant requires user approval, and the impersonation/token exchange
does not yield a refresh token. Neither grant is part of this headless eval.

## Setup

```bash
cd eval
npm install
npx playwright install chromium
```

### 1. Fill in `keycard.toml`

Edit `eval/keycard.toml` and replace the placeholders:

- `[org] id`: your Keycard organization ID (Console → Settings)
- `[zone] id`: the organization's Organization Zone ID (the `zone_id` on the organization; see [Zone sign-in](#zone-sign-in))

### Zone sign-in

Password login works only in the Keycard ID Zone: since svc-iam ID-809 (October 27, 2026) every other zone has `password_login_enabled` off, and the Management API refuses to turn it back on. A custom zone with no Identity Provider fails every authorize request with `No User Identity Provider configured in Zone`.

The eval therefore runs in the organization's Organization Zone, which comes with Keycard ID as its Identity Provider. Use an organization dedicated to the eval, with SSO off: the eval provisions apps, resources and an impersonation policy there, and a user who must sign in through SSO gets sent to the SSO provider instead of a password form.

The test user is a Keycard account (signed up at the Keycard ID Zone, email verified) that is invited to the organization as a member. A browser sign-in passes through two hops: the Organization Zone, then the ID Zone's login form. `browser.ts` submits the identifier and password wherever they're asked for and approves each consent screen on the way.

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

Run once with a visible browser to sign in through the Organization Zone and create the test user in the eval zone:

```bash
EVAL_HEADLESS=false keycard run -- npm run eval -- --template mcp-server-typescript-express
```

When the browser opens, sign in with the email/password from your vault resources, signing up at the Keycard ID Zone first if the account doesn't exist yet, and verify the email. The first sign-in creates the test user in the eval zone. After that, all subsequent runs are fully headless.

In GitHub Actions, the preflight job checks the eval zone before any template runs and doesn't change it. It expects the user identified by `EVAL_TEST_USER_EMAIL` to exist in the zone and the Identity Provider to be Keycard ID in the Organization Zone, or the Organization Zone itself in a custom zone. When the job can't read the organization or the Organization Zone's issuer to verify which provider is configured, it warns instead of failing.

## Run

```bash
keycard run -- npm run eval -- --template mcp-server-typescript-express
keycard run -- npm run eval -- --template agent-python-langchain
keycard run -- npm run eval -- --template delegated-access-typescript-cloudflare
```

The agent template needs `uv` on PATH and no vault resources beyond the three
above. `EVAL_TEST_USER_EMAIL` doubles as the impersonation target, so that user
must exist in the eval zone; the password is unused on this path.

Cloudflare also needs Node.js 22.12 or later, `cloudflared` on PATH, and network access for its
anonymous quick tunnel. CI verifies the checksum of a pinned binary and
only installs it for Wrangler templates. Leave `.dev.vars` absent before
running eval; the harness will not overwrite an existing one.

### GitHub Actions cadence

Template Eval runs every Monday at 06:00 UTC and on manual dispatch without
checking SDK releases. A nightly check at 09:00 UTC looks for new SDK tags
rather than running once per SDK release.

The nightly check uses the workflow's read-only GitHub token to list tags in
`keycardai/python-sdk`, `keycardai/typescript-sdk`, `keycardai/go-sdk`,
`keycardai/ruby-sdk`, and `keycardai/java-sdk`. It saves the tag names as an
`sdk-tags` artifact with 90-day retention, then compares them with the artifact
from the most recent successful nightly that ran the eval. Skipped and failed
nights do not replace that baseline. If there is no previous successful
nightly eval, its artifact is missing or unreadable, or the GitHub API check
fails, the nightly runs the eval.

The Actions run summary lists new tags or explains why the eval was skipped.
Failed runs stay visible in Actions. The scheduled failure
notification posts to Slack only when `EVAL_SLACK_WEBHOOK_URL` is configured.
Template Eval does not gate releases or checks in the SDK repositories.

All Template Eval runs share a concurrency group so they do not overlap in the
shared eval zone. GitHub does not cancel the active run, but it keeps only one
pending run per group. A newer queued run replaces an older pending run.

### Skipping templates

`eval-skip.txt` contains only comments, so it excludes no templates. The
workflow's discover job uses it to exclude templates from the automatic
matrix, one directory name per line. It ignores `#` comments and blank lines.
A named `workflow_dispatch` template input bypasses the list.

### Harness notes for the build agent

`index.ts` keeps a notes map keyed by template name, passed to `runBuildAgent`
as extra constraints that override `SPEC.md` where the eval's provisioning
deliberately differs from it. The two `mcp-brokered-credentials-*` templates
carry notes saying the provisioned zone-native resource and config are correct
as written, because without them the agent spent every turn reconciling the
config toward the SPEC's brokered external-provider setup and never built.
`mcp-delegated-access-go` carries a note telling the agent to build without
starting the server: its `main.go` exits without `KEYCARD_CLIENT_ID` and
`KEYCARD_CLIENT_SECRET`, which the harness passes only to the server it starts
after the build, so the SPEC's smoke test cannot pass inside the build step.
When the build agent fails, the harness prints its whole transcript (tool
output capped at 500 characters per call) instead of the last five lines.

### Ruby coverage

`mcp-server-ruby` is discovered by its `Gemfile` and takes the MCP-server flow
like the other inbound-auth templates. The workflow installs Ruby 3.4 with
`ruby/setup-ruby` only when the template has a Gemfile, the build agent runs
`bundle install` and then loads `config.ru` through `Rack::Builder.parse_file`
with `.env` sourced (no port bound, but the load still fails if `KEYCARD_URL`
is missing), and the harness starts the server with
`bundle exec rackup --host 0.0.0.0 --port 8000`, passing `KEYCARD_URL`,
`KEYCARD_RESOURCE_ID`, and `PORT` through the process environment as it does
for Go. The template carries a notes entry because its `SPEC.md` tells the
agent to provision through `keycard agent api` and to abort without a
zone-bound `keycard.toml`, which no longer applies once the harness has
provisioned.

### Java coverage

`mcp-server-java` is discovered by its `build.gradle.kts` and takes the
MCP-server flow. The workflow installs Temurin 21 and `setup-gradle` only when
the template has a `build.gradle.kts`, then runs the Gradle wrapper once to
download Gradle and resolve dependencies, because each of the build agent's
shell commands times out after 60 seconds. The build agent runs
`./gradlew installDist`, and the harness starts the server with the generated
start script `build/install/<template>/bin/<template>`, passing `KEYCARD_URL`,
`KEYCARD_RESOURCE_ID`, and `PORT` through the process environment as it does
for Go and Ruby. The template carries a notes entry for the same reason as Ruby,
plus the build command the harness depends on.

## Environment variables

| Variable | Used by | Meaning |
|---|---|---|
| `CI_KEYCARD_CLIENT_ID`, `CI_KEYCARD_CLIENT_SECRET`, `CI_KEYCARD_ENDPOINT` | both | Service account that creates the zone |
| `EVAL_KEYCARD_CLIENT_ID`, `EVAL_KEYCARD_CLIENT_SECRET` | both | Optional. A service account for the eval alone, so PR CI (`ci.yml`) and the eval show up as different actors and rotate separately. Set both or neither; when unset, the eval uses `CI_KEYCARD_*` |
| `ANTHROPIC_API_KEY` | both | Drives the build agent, and the agent template's model turn |
| `EVAL_TEST_USER_EMAIL` | both | Browser sign-in for servers, impersonation target for agents |
| `EVAL_TEST_USER_PASSWORD` | servers | Browser sign-in only |
| `EVAL_HEADLESS` | servers | Set to `false` to watch the browser |
| `EVAL_ZONE_ID`, `EVAL_ZONE_ISSUER_URL` | both | The persistent eval zone. Required for agent templates: impersonation needs a zone user that already exists |
| `EVAL_ALLOW_EPHEMERAL` | servers | Create a throwaway zone instead. Agent templates refuse it, since a fresh zone has no users to impersonate |
| `EVAL_AGENT_PORT` | agents | Port for `langgraph dev`, default `2024` |
| `EVAL_STUB_PORT` | agents, Cloudflare | Port for the stub calendar, default `8901` |
| `EVAL_WORKER_PORT` | Cloudflare | Port for local Wrangler, default `8787` |
| `EVAL_AGENT_MODEL` | agents | Model for the agent's own turn, default `claude-sonnet-4-6` |
