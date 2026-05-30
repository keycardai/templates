"""Databricks MCP server — Keycard-brokered credentials.

Exposes a single `list_clusters` tool. On each call, the `@grant` decorator
exchanges the user's Keycard bearer token for a Databricks-scoped OAuth token
(OAuth 2.0 Token Exchange), then the tool calls the Databricks REST API
directly. No Databricks API key stored anywhere.

Run with:
    keycard run -- uv run python main.py
"""

import os

from dotenv import find_dotenv, load_dotenv

load_dotenv(find_dotenv(usecwd=True))

KEYCARD_URL = os.environ.get("KEYCARD_URL")
SERVER_URL = os.environ.get("MCP_SERVER_URL", "http://localhost:8000/")
PORT = int(os.environ.get("PORT", "8000"))
SERVER_NAME = "databricks-agent"

if not KEYCARD_URL:
    raise RuntimeError(
        "KEYCARD_URL is required. "
        "Set it in .env or run via `keycard run -- uv run python main.py`."
    )

from fastmcp import FastMCP
from keycardai.fastmcp import AuthProvider

from tools.list_clusters import register_list_clusters_tool

auth_provider = AuthProvider(
    zone_url=KEYCARD_URL,
    mcp_server_name=SERVER_NAME,
    mcp_base_url=SERVER_URL,
)

mcp = FastMCP(SERVER_NAME, auth=auth_provider.get_remote_auth_provider())
register_list_clusters_tool(mcp, auth_provider)


if __name__ == "__main__":
    mcp.run(transport="streamable-http", host="0.0.0.0", port=PORT)
