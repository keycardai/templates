# Keycard Template Eval

End-to-end eval harness for Keycard templates. Tests whether a Claude agent can correctly follow a template's `SPEC.md` to provision Keycard resources and start a working authenticated MCP server.

## How it works

1. Creates an ephemeral Keycard zone
2. Runs a Claude agent against the template's `SPEC.md` — the agent provisions the zone's Application and Resource, writes config files, and starts the server
3. Uses Playwright to authenticate as a test user via the zone's OAuth consent flow
4. Verifies the server accepts authenticated requests and rejects unauthenticated ones
5. Tears down the Application + Resource (zone is reused)

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

In Keycard Console, create four vault resources in your eval zone:

| Resource URN | Secret |
|---|---|
| `urn:keycard-eval:anthropic_api_key` | Your Anthropic API key |
| `urn:keycard-eval:test_user_email` | Email for the Playwright test user |
| `urn:keycard-eval:test_user_password` | Password for the Playwright test user |
| `urn:keycard-eval:org_id` | Your Keycard organization ID (Console → Settings) |

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
```
