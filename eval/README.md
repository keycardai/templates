# Keycard Template Eval

End-to-end eval harness for Keycard templates. Tests whether a Claude agent can correctly follow a template's `SPEC.md` to provision Keycard resources and start a working authenticated MCP server.

## How it works

1. Creates an ephemeral Keycard zone
2. Runs a Claude agent against the template's `SPEC.md` — the agent provisions the zone's Application and Resource, writes config files, and starts the server
3. Uses Playwright to authenticate as a test user via the zone's OAuth consent flow
4. Verifies the server accepts authenticated requests and rejects unauthenticated ones
5. Tears down the zone

## Setup

```bash
cd eval
npm install
npx playwright install chromium
cp .env.eval.example .env.eval
# Fill in .env.eval with your credentials
```

### One-time test user setup

Run with a visible browser once to create the test user account:

```bash
EVAL_HEADLESS=false npm run eval -- --template mcp-server-typescript-express
```

When the browser opens, sign up with the email/password you put in `.env.eval`. Verify your email when prompted. After that, all subsequent runs are fully headless.

## Run

```bash
npm run eval -- --template mcp-server-typescript-express
```
