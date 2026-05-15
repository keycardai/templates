# mcp-brokered-credentials-python

MCP proxy to Linear with Keycard-brokered credentials. No static API keys — the user's Keycard bearer token is exchanged for a Linear-scoped OAuth token via RFC 8693 on every tool call.

Exposes two tools:
- **`search`** — regex-search Linear's MCP tool catalog
- **`execute`** — call any Linear tool by name with brokered credentials

## Prerequisites

- Python 3.10+
- [uv](https://docs.astral.sh/uv/)
- [Keycard CLI](https://docs.keycard.ai/cli/)
- A Keycard zone with an STS provider and a vault provider

## Setup

Follow `SPEC.md` to provision the required Keycard resources (Linear provider, applications, resources, dependency wiring, vault credentials), or use the `keycard-template-app` skill to do it automatically.

1. **Install dependencies**

   ```bash
   uv sync
   ```

2. **Configure `.env`**

   ```bash
   cp .env.example .env
   # Fill in KEYCARD_URL and PORT
   ```

3. **Configure `keycard.toml`**

   Fill in your `[org].id` and `[zone].id`, then append the two `[[credentials.default]]` entries as described in `SPEC.md §2`.

## Run

```bash
keycard run -- uvicorn main:app --host 0.0.0.0 --port 8000
```

`keycard run` brokers `KEYCARD_CLIENT_ID` and `KEYCARD_CLIENT_SECRET` from the zone vault into the process environment. Running `uvicorn` directly (without `keycard run`) will fail at startup because credentials cannot be discovered.

## How it works

```
Claude → [Keycard bearer token] → proxy → [RFC 8693 token exchange] → [Linear token] → Linear MCP
```

1. Claude authenticates to the proxy with a Keycard bearer token.
2. When a tool is called, `@auth_provider.grant("https://mcp.linear.app/mcp")` exchanges that token for a Linear-scoped OAuth token via the zone's STS.
3. The proxy opens a fresh MCP session to `https://mcp.linear.app/mcp` with the brokered token and forwards the call.
4. The brokered token is scoped to the call duration — no Linear tokens are cached or stored.

## Extending

- **Swap the upstream** — change `LINEAR_MCP_URL` in `upstream.py` and register the new upstream's Keycard primitives (§1a–§1c of `SPEC.md`).
- **Add direct tools** — add a file to `tools/` following the pattern in `tools/search.py` or `tools/execute.py`, without `@auth_provider.grant()`.
- **Proxy multiple upstreams** — pass a list of resource URLs to `@auth_provider.grant(["url1", "url2"])` and call `access_ctx.access(url)` per resource.
