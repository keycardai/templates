# Cross-Cloud Agent Identity (Python)

MCP server demonstrating three Snowflake connection patterns via Keycard identity — **delegation**, **impersonation**, and **agent-identity** — with scope-based per-tool authorization. Deploys identically to Vercel and Fly.io using workload identity (no shared secrets).

## What it demonstrates

| Tool | Scope Required | Identity Flow |
|------|---------------|---------------|
| `delegate` | `snowflake:delegate` | Exchange caller's MCP bearer token for a Snowflake session scoped to their identity |
| `impersonate` | `snowflake:impersonate` | Agent acts as a specified user via substitute-user exchange |
| `agent-identity` | `snowflake:agent-identity` | Agent uses its own platform credential to connect as itself |

Each tool accepts a natural-language `query`, introspects available Snowflake tables, and either answers the question or returns diagnostic information about why it cannot.

## Architecture

```
┌─────────────────┐      ┌──────────────────────────────┐
│  MCP Client     │      │  MCP Server (this project)   │
│  (with scoped   │─────▶│  ┌────────────────────────┐  │
│   access token) │      │  │ scope check            │  │
└─────────────────┘      │  └──────────┬─────────────┘  │
                         │             ▼                 │
                         │  ┌────────────────────────┐  │
                         │  │ Keycard STS exchange   │  │
                         │  └──────────┬─────────────┘  │
                         │             ▼                 │
                         │  ┌────────────────────────┐  │
                         │  │ Snowflake WIF          │  │
                         │  └──────────┬─────────────┘  │
                         │             ▼                 │
                         │  ┌────────────────────────┐  │
                         │  │ Claude agent loop       │  │
                         │  │ (introspect + answer)  │  │
                         │  └────────────────────────┘  │
                         └──────────────────────────────┘
```

## Quick start

### Prerequisites

- Python 3.12+
- [uv](https://docs.astral.sh/uv/)
- Keycard CLI (`keycard`)
- A configured Keycard zone (see `SPEC.md` for provisioning)

### Install

```bash
uv sync
```

### Run locally

```bash
keycard run -- uv run server
```

The server starts on `http://localhost:8050` (configurable via `SERVER_PORT`).

### Deploy to Vercel

```bash
vercel deploy --prod
```

### Deploy to Fly.io

```bash
fly deploy
```

## Environment variables

| Variable | Description | Default |
|----------|-------------|---------|
| `KEYCARD_ZONE_URL` | Keycard zone URL | — |
| `SERVER_PORT` | HTTP port | `8050` |
| `SERVER_URL` | Public URL of this server | `http://localhost:8050` |
| `SNOWFLAKE_ACCOUNT` | Snowflake account identifier | — |
| `SNOWFLAKE_WAREHOUSE` | Snowflake warehouse | `COMPUTE_WH` |
| `SNOWFLAKE_RESOURCE` | Resource identifier for Snowflake WIF | `snowflakecomputing.com` |
| `ANTHROPIC_RESOURCE` | Resource identifier for Anthropic key | `https://api.anthropic.com` |
| `ANTHROPIC_API_KEY` | Fallback for local dev (normally fetched via Keycard) | — |
| `ANTHROPIC_MODEL` | Model for the agent loop | `claude-sonnet-4-20250514` |

## Keycard provisioning

See [`SPEC.md`](./SPEC.md) for the full provisioning contract. Key points:

- **One application** with two workload identity credentials (Vercel OIDC + Fly OIDC)
- **Three scopes** on the MCP resource control tool access
- **Two dependencies**: Snowflake (WIF) and Anthropic (bootstrap)
- Anthropic key is obtained at startup via agent-identity — never stored as env var

## How it works

1. **MCP client connects** with an access token that includes one or more scopes
2. **Scope check**: Each tool verifies the caller's token has the required scope
3. **Token acquisition**: Depending on the tool, either exchanges the caller's token (delegate), uses substitute-user (impersonate), or uses platform OIDC (agent-identity)
4. **Snowflake connection**: Uses the obtained token with WIF/OIDC authenticator
5. **Agent loop**: Claude model introspects available tables, generates SQL, executes, and returns results or diagnostics
