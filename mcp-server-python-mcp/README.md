# mcp-server-python-mcp

Minimal Keycard-protected MCP server (Python + FastMCP) with a `hello_world` tool.

Python equivalent of [`mcp-server-typescript-express`](../mcp-server-typescript-express/).

## Requirements

- Python 3.10+
- [uv](https://docs.astral.sh/uv/)
- A Keycard zone — [sign up at keycard.ai](https://keycard.ai)

## Setup

```bash
uv sync
cp .env.example .env
# Fill in KEYCARD_ZONE_URL from Keycard Console → Zone Settings
```

## Run

```bash
uv run uvicorn main:app --host 0.0.0.0 --port 8000
```

Or via `keycard run` for full credential brokering:

```bash
keycard run -- uv run uvicorn main:app --port 8000
```

## Environment variables

| Variable | Description | Default |
|---|---|---|
| `KEYCARD_ZONE_URL` | Zone issuer URL, e.g. `https://<id>.keycard.cloud` | required |
| `KEYCARD_ZONE_ID` | Zone ID (alternative to `KEYCARD_ZONE_URL`) | — |
| `MCP_SERVER_URL` | Base URL this server is reachable at | `http://localhost:8000/` |
| `PORT` | HTTP port | `8000` |

## Endpoints

| Path | Description |
|---|---|
| `GET /healthz` | Health check — `{"ok": true}` |
| `GET /.well-known/oauth-protected-resource` | OAuth resource metadata (RFC 9728) |
| `GET /.well-known/oauth-authorization-server` | OAuth AS metadata (RFC 8414) |
| `POST /mcp` | MCP Streamable HTTP transport |

## Add a tool

Create a file in `tools/` following the pattern in `tools/hello.py`: export a `register_<name>_tool(mcp)` function that calls `@mcp.tool()`. Then import and call it in `main.py` — that's the only wiring needed.

```python
# tools/my_tool.py
from mcp.server.fastmcp import FastMCP

def register_my_tool(mcp: FastMCP) -> None:
    @mcp.tool()
    def my_tool(arg: str) -> str:
        """Tool description shown to the model."""
        return f"Result: {arg}"
```

## Provisioning

See [`SPEC.md`](./SPEC.md) — the agent reads this to provision the required Keycard resources (Application + Resource) and write your `.env`.
