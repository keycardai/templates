"""Impersonate tool: connects to Snowflake as a specified user.

Uses Keycard's substitute-user token exchange to obtain a Snowflake session
scoped to the specified user's identity. The agent authenticates with its
own platform credential but acts on behalf of another user.

Requires scope: snowflake:impersonate
"""

from __future__ import annotations

import logging
import os

from mcp.server.fastmcp import Context, FastMCP

from keycardai.mcp.server.auth import AuthProvider

from ..agent_loop import run_agent_loop
from ..scope import SCOPE_IMPERSONATE, require_scope
from ..tokens.exchange import impersonate_grant
from ..tokens.platform import get_client_assertion

logger = logging.getLogger(__name__)


def register_impersonate_tool(mcp: FastMCP, auth_provider: AuthProvider) -> None:
    """Register the impersonate tool on the MCP server."""

    @mcp.tool()
    @require_scope(SCOPE_IMPERSONATE)
    async def impersonate(
        query: str,
        user_identifier: str,
        ctx: Context,
        database: str | None = None,
        schema: str | None = None,
        role: str | None = None,
    ) -> str:
        """Query Snowflake as a specified user via impersonation.

        The agent uses its own platform identity to request a Snowflake session
        scoped to the specified user. This requires appropriate Keycard policy
        allowing impersonation.

        Requires scope: snowflake:impersonate

        Args:
            query: Natural-language question to answer using Snowflake data.
            user_identifier: The user to impersonate (email or principal identifier).
            database: Optional — narrow discovery to this database.
            schema: Optional — narrow discovery to this schema.
            role: Optional — USE ROLE before querying (must be in target user's available roles).
        """
        zone_url = os.getenv("KEYCARD_ZONE_URL", "")
        account = os.getenv("SNOWFLAKE_ACCOUNT", "")
        resource = os.getenv(
            "SNOWFLAKE_OAUTH_RESOURCE",
            f"https://{account}.snowflakecomputing.com" if account else "snowflakecomputing.com",
        )

        token_result = await impersonate_grant(
            zone_url=zone_url,
            user_identifier=user_identifier,
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
