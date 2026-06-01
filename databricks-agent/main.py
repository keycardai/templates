"""Databricks MCP server — Keycard-brokered credentials.

Exposes scope-gated tools across two Databricks branches — SQL Warehouse and
Genie — plus `list_clusters`. On each call, the `@grant` decorator exchanges
the user's Keycard bearer token for a Databricks-scoped OAuth token (OAuth 2.0
Token Exchange), then the tool calls the Databricks REST API directly. No
Databricks API key stored anywhere.

Authorization is toggled by ENFORCE_TOOL_SCOPES:
- true:  each tool verifies its required scope on the caller token.
- false: scope checks are bypassed; Keycard's delegation policy authorizes
  (or denies) the token exchange instead.

Run with:
    keycard run -- uv run python main.py
"""

import logging
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

from tools.genie import register_genie_tools
from tools.list_clusters import register_list_clusters_tool
from tools.scope import scope_enforcement_enabled
from tools.sql_warehouse import register_sql_tools

auth_provider = AuthProvider(
    zone_url=KEYCARD_URL,
    mcp_server_name=SERVER_NAME,
    mcp_base_url=SERVER_URL,
)

mcp = FastMCP(SERVER_NAME, auth=auth_provider.get_remote_auth_provider())
register_list_clusters_tool(mcp, auth_provider)
register_sql_tools(mcp, auth_provider)
register_genie_tools(mcp, auth_provider)

logging.getLogger(SERVER_NAME).info(
    "Per-tool scope enforcement: %s",
    "ENABLED" if scope_enforcement_enabled() else "DISABLED",
)


if __name__ == "__main__":
    mcp.run(transport="streamable-http", host="0.0.0.0", port=PORT)
