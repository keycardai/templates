"""Delegate tool: connects to Snowflake as the calling user.

Uses RFC 8693 token exchange to swap the caller's MCP bearer token for a
Snowflake-scoped token. The resulting connection reflects the caller's
identity and permissions in Snowflake.

Requires scope: snowflake:delegate
"""

from __future__ import annotations

import logging
import os

from mcp.server.fastmcp import Context, FastMCP

from keycardai.mcp.server.auth import AuthProvider

from ..agent_loop import run_agent_loop
from ..scope import SCOPE_DELEGATE, require_scope
from ..tokens.exchange import exchange_token
from ..tokens.platform import get_client_assertion

logger = logging.getLogger(__name__)


def register_delegate_tool(mcp: FastMCP, auth_provider: AuthProvider) -> None:
    """Register the delegate tool on the MCP server."""

    @mcp.tool()
    @require_scope(SCOPE_DELEGATE)
    async def delegate(
        query: str,
        ctx: Context,
        database: str | None = None,
        schema: str | None = None,
        role: str | None = None,
    ) -> str:
        """Query Snowflake as the calling user via delegated identity.

        Uses the caller's MCP token to obtain a Snowflake session scoped to
        their identity. The agent introspects available tables and attempts
        to answer the query, or returns diagnostic information if it cannot.

        Requires scope: snowflake:delegate

        Args:
            query: Natural-language question to answer using Snowflake data.
            database: Optional — narrow discovery to this database.
            schema: Optional — narrow discovery to this schema.
            role: Optional — USE ROLE before querying (must be in caller's available roles).
        """
        zone_url = os.getenv("KEYCARD_ZONE_URL", "")
        account = os.getenv("SNOWFLAKE_ACCOUNT", "")
        resource = os.getenv(
            "SNOWFLAKE_OAUTH_RESOURCE",
            f"https://{account}.snowflakecomputing.com" if account else "snowflakecomputing.com",
        )

        try:
            request = ctx.request_context.request
            auth_header = request.headers.get("authorization", "")
            if not auth_header.startswith("Bearer "):
                return '{"ok": false, "error": "NO_TOKEN", "message": "No bearer token in request"}'
            user_token = auth_header[7:]
        except AttributeError:
            return '{"ok": false, "error": "INTERNAL", "message": "Cannot access request context"}'

        token_result = await exchange_token(
            zone_url=zone_url,
            user_token=user_token,
            resource=resource,
            get_client_assertion=get_client_assertion,
        )

        if not token_result.ok:
            return token_result.to_json()

        result = await run_agent_loop(
            token_result.data, query,
            database=database, schema=schema, role=role,
            authenticator="oauth",
        )
        return result.to_json()
