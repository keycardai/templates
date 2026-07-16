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
from urllib.parse import urlparse

from dotenv import find_dotenv, load_dotenv
from fastmcp import FastMCP
from keycardai.fastmcp import AuthProvider

# Load .env BEFORE importing the tool modules: each tool reads DATABRICKS_HOST
# at import time, so the environment must be populated first. Otherwise the host
# falls back to its placeholder and token exchange fails with invalid_target.
load_dotenv(find_dotenv(usecwd=True))

from tools.authorize import register_authorization_flow  # noqa: E402
from tools.genie import register_genie_tools  # noqa: E402
from tools.list_clusters import register_list_clusters_tool  # noqa: E402
from tools.scope import authorization_flow_enabled, scope_enforcement_enabled  # noqa: E402
from tools.sql_warehouse import register_sql_tools  # noqa: E402

KEYCARD_URL = os.environ.get("KEYCARD_URL")
# Single source of truth: the advertised server URL also dictates the bind port.
# These must agree, otherwise MCP auth fails with an invalid audience.
SERVER_URL = os.environ.get("MCP_SERVER_URL", "http://localhost:8000/")
PORT = urlparse(SERVER_URL).port or 8000
SERVER_NAME = "databricks-agent"

if not KEYCARD_URL:
    raise RuntimeError(
        "KEYCARD_URL is required. "
        "Set it in .env or run via `keycard run -- uv run python main.py`."
    )

auth_provider = AuthProvider(
    zone_url=KEYCARD_URL,
    mcp_server_name=SERVER_NAME,
    mcp_base_url=SERVER_URL,
)

mcp = FastMCP(SERVER_NAME, auth=auth_provider.get_remote_auth_provider())
register_list_clusters_tool(mcp, auth_provider)
register_sql_tools(mcp, auth_provider)
register_genie_tools(mcp, auth_provider)
register_authorization_flow(mcp, auth_provider)

logging.getLogger(SERVER_NAME).info(
    "Per-tool scope enforcement: %s",
    "ENABLED" if scope_enforcement_enabled() else "DISABLED",
)
logging.getLogger(SERVER_NAME).info(
    "On-demand authorization flow: %s",
    "ENABLED" if authorization_flow_enabled() else "DISABLED",
)


if __name__ == "__main__":
    mcp.run(transport="streamable-http", host="0.0.0.0", port=PORT)
