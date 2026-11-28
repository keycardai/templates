# mcp-server-python-mcp

Minimal Python MCP server with a `hello_world` tool. It mounts the MCP v2
`MCPServer` in Starlette and protects the endpoint with `keycardai-starlette`.

Python equivalent of [`mcp-server-typescript-express`](../mcp-server-typescript-express/).

## Requirements

- Python 3.10+
- [uv](https://docs.astral.sh/uv/)
- A Keycard zone — [sign up at keycard.ai](https://keycard.ai)

## Setup

```bash
uv sync
cp .env.example .env
# Fill in KEYCARD_URL from Keycard Console → Zone Settings
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
| `KEYCARD_URL` | Zone issuer URL, e.g. `https://<id>.keycard.cloud` | required |
| `KEYCARD_RESOURCE_ID` | The registered Resource's HTTP(S) URL. Its path sets the MCP endpoint, and the exact URL sets the token audience and OAuth discovery. | `http://localhost:<PORT>/mcp` |
| `PORT` | HTTP port | `8000` |

## Endpoints

| Path | Description |
|---|---|
| `GET /healthz` | Health check — `{"ok": true}` |
| `GET /.well-known/oauth-protected-resource/mcp` | OAuth resource metadata (RFC 9728) for the default resource |
| `GET /.well-known/oauth-authorization-server` | OAuth AS metadata (RFC 8414) |
| `POST /mcp` | MCP Streamable HTTP transport |

An unauthenticated `POST /mcp` returns HTTP 401 with a Bearer
`WWW-Authenticate` challenge. Its `resource_metadata` URL and the metadata
document's `resource` both come from `KEYCARD_RESOURCE_ID`. If you configure
a different path, such as `/tools/mcp`, use it for the MCP request and fetch
`/.well-known/oauth-protected-resource/tools/mcp` for discovery.

Run `bash scripts/ci-verify.sh` after `uv sync` to check startup, health,
OAuth metadata, and the 401 challenge. Export `PORT` and `KEYCARD_RESOURCE_ID`
before running it if you use nondefault values.

## Add a tool

Create a file in `tools/` following the pattern in `tools/hello.py`: export a `register_<name>_tool(mcp)` function that calls `@mcp.tool()`. Then import and call it in `main.py` — that's the only wiring needed.

```python
# tools/my_tool.py
from mcp.server.mcpserver import MCPServer

def register_my_tool(mcp: MCPServer) -> None:
    @mcp.tool()
    def my_tool(arg: str) -> str:
        """Tool description shown to the model."""
        return f"Result: {arg}"
```

## Provisioning

See [`SPEC.md`](./SPEC.md) — the agent reads this to provision the required Keycard resources (Application + Resource) and write your `.env`.
