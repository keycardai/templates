# autonomous-agent-snowflake-wif

Autonomous agent that queries a Snowflake data warehouse via **Workload Identity Federation (WIF/OIDC)**, authenticating with a **URL Application Credential** — the agent's own cryptographic identity, not a shared secret.

## How it works

This template implements AAuth's [identity-only mode](https://github.com/dickhardt/AAuth#what-aauth-provides): the agent generates an RSA keypair, publishes the public key at `/.well-known/jwks.json`, and signs every authentication request with a client assertion JWT ([RFC 7523](https://datatracker.ietf.org/doc/html/rfc7523)). Keycard's STS verifies the signature by fetching the JWKS from the agent's public URL — no pre-shared secret, no vault brokering. The private key never leaves the agent's local storage.

The agent authenticates to Snowflake via Keycard's token exchange, obtaining an OIDC access token that Snowflake validates through its Workload Identity Federation configuration. It then runs a [pi-agent-core](https://github.com/earendil-works/pi) LLM loop to query Snowflake and produce results autonomously.

Other agents reach it over [A2A protocol 1.0](https://a2a-protocol.org) (`@keycardai/a2a` 0.4 on `@a2a-js/sdk` 1.x): the agent card at `/.well-known/agent-card.json` advertises a JSON-RPC interface under `supportedInterfaces`, and `/a2a/jsonrpc` accepts `SendMessage` and `GetTask` with an `A2A-Version: 1.0` header. The endpoint is fronted by `requireBearerAuth`, so a missing or rejected Keycard token is answered with HTTP 401 and an RFC 6750 `WWW-Authenticate: Bearer` challenge (`error="invalid_token"` when a token was presented), not with a JSON-RPC error. Agents still on A2A 0.3 (`message/send`) are not served; see the `legacyCompat` option in the `@keycardai/a2a` README if you need the migration window.

```
┌─────────────────────────────────────────────┐
│  Agent process (this template)              │
│                                             │
│  ┌──────────┐   ┌────────────────────────┐  │
│  │ pi-agent │──▶│ Snowflake              │  │
│  │ core     │   │ (WIF/OIDC)             │  │
│  └──────────┘   └────────────────────────┘  │
│       │                                     │
│  ┌────┴────────┐                            │
│  │ WebIdentity │                            │
│  │ (keypair)   │                            │
│  └──────┬──────┘                            │
│         │                                   │
│  ┌──────▼──────────────────┐                │
│  │ GET /.well-known/       │                │
│  │     jwks.json           │                │
│  └─────────────────────────┘                │
└─────────────────────────────────────────────┘
         ▲
         │  Keycard STS fetches JWKS to
         │  verify client_assertion JWTs
```

## Prerequisites

1. **Snowflake account** with Workload Identity Federation (OIDC) configured. The Snowflake security integration must trust tokens issued by your Keycard zone.

2. **Agent reachable on the internet** — Keycard's STS must be able to `GET <your-url>/.well-known/jwks.json`. Two modes:

   - **Tailscale Funnel** (local dev): `tailscale funnel --bg 9000` exposes the agent on `https://<host>.<tailnet>.ts.net`. Requires [Tailscale Funnel](https://tailscale.com/kb/1223/funnel) enabled on the tailnet.

   - **Fly.io** (hosted): `fly deploy` using the included `Dockerfile` + `fly.toml`. Gives a stable `https://<app>.fly.dev`.

3. **Keycard CLI** installed and authenticated (`keycard init`).

4. **LLM API key** for the configured provider (default: `ANTHROPIC_API_KEY`).

## Quick start

```bash
# 1. Copy the template
cp -R autonomous-agent-snowflake-wif my-agent
cd my-agent

# 2. Install and build
npm install && npm run build

# 3. Make the agent reachable (pick one)
#    Mode A: Tailscale Funnel
tailscale funnel --bg 9000
#    → note the printed URL, e.g. https://myhost.tail12345.ts.net

#    Mode B: Fly.io — see SPEC.md §0b

# 4. Provision Keycard (automated by keycard-template-app skill, or follow SPEC.md)
#    Creates the agent application + URL credential + Snowflake resource

# 5. Configure .env
cp .env.example .env
#    Edit AGENT_BASE_URL, KEYCARD_URL, SNOWFLAKE_ACCOUNT, etc.

# 6. Run
AGENT_BASE_URL=https://myhost.tail12345.ts.net keycard run -- npm start
```

The agent will:
- Bootstrap its cryptographic identity (generate/load RSA keypair)
- Serve the public JWKS at `/.well-known/jwks.json`
- Authenticate to Snowflake via Keycard STS (OIDC token exchange)
- Query Snowflake and produce a summary report
- Print results and exit

## Configuration

| Variable | Required | Default | Description |
|---|---|---|---|
| `AGENT_BASE_URL` | yes | — | Public URL where this agent is reachable |
| `KEYCARD_URL` | yes | — | Keycard zone URL (`https://<id>.keycard.cloud`) |
| `KEYCARD_RESOURCE_ID` | no | _(unset)_ | The agent's registered Resource identifier, its `AGENT_BASE_URL`. When set, inbound A2A calls carrying a token minted for any other resource are refused with a 401 `invalid_token` challenge. |
| `SNOWFLAKE_ACCOUNT` | yes | — | Snowflake account identifier (`ORGNAME-ACCTNAME`) |
| `SNOWFLAKE_USER` | no | — | Snowflake user for WIF authentication |
| `SNOWFLAKE_DATABASE` | no | — | Default database |
| `SNOWFLAKE_WAREHOUSE` | no | — | Default warehouse |
| `SNOWFLAKE_ROLE` | no | — | Snowflake role to assume |
| `AGENT_PROVIDER` | no | `anthropic` | pi-ai LLM provider |
| `AGENT_MODEL` | no | `claude-sonnet-4-20250514` | pi-ai model ID |
| `AGENT_TASK` | no | Snowflake query prompt | Task the agent executes |
| `PORT` | no | `9000` | Port for the well-known endpoint server |
| `AGENT_KEYS_DIR` | no | `./agent_keys` | Directory for the RSA keypair |

## Identity model

This template demonstrates AAuth's identity-only access mode realized over OAuth:

- **No pre-registration**: The agent publishes its identity (JWKS) at a well-known URL. Any party can verify it.
- **No shared secrets**: Authentication uses signed JWTs (proof-of-possession), not `client_secret`.
- **Per-instance identity**: Each agent instance has its own keypair. Rotating is as simple as deleting `agent_keys/` and restarting.

For more on AAuth, see the [AAuth specification](https://github.com/dickhardt/AAuth).

## License

See [LICENSE](../LICENSE) in the repository root.
