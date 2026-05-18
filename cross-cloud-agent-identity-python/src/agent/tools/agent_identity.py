"""Agent-identity tool: connects to Snowflake as the application itself.

Uses the agent's own platform credential (client_credentials grant) to
obtain a Snowflake session. No user delegation or impersonation — the
connection reflects the agent application's own identity and permissions.

Requires scope: snowflake:agent-identity
"""

from __future__ import annotations

import logging
import os

from mcp.server.fastmcp import Context, FastMCP

from keycardai.mcp.server.auth import AuthProvider

from ..agent_loop import run_agent_loop
from ..scope import SCOPE_AGENT_IDENTITY, require_scope
from ..tokens.exchange import client_credentials_grant
from ..tokens.platform import get_client_assertion

logger = logging.getLogger(__name__)


def register_agent_identity_tool(mcp: FastMCP, auth_provider: AuthProvider) -> None:
    """Register the agent-identity tool on the MCP server."""

    @mcp.tool()
    @require_scope(SCOPE_AGENT_IDENTITY)
    async def agent_identity(
        query: str,
        ctx: Context,
        database: str | None = None,
        schema: str | None = None,
        role: str | None = None,
    ) -> str:
        """Query Snowflake using the agent's own identity.

        The agent authenticates directly to Snowflake using its platform
        credential (Vercel OIDC or Fly OIDC). The connection reflects the
        agent application's own permissions — not any user's.

        Requires scope: snowflake:agent-identity

        Args:
            query: Natural-language question to answer using Snowflake data.
            database: Optional — narrow discovery to this database.
            schema: Optional — narrow discovery to this schema.
            role: Optional — USE ROLE before querying (must be in agent's available roles).
        """
        zone_url = os.getenv("KEYCARD_ZONE_URL", "")
        resource = os.getenv("SNOWFLAKE_RESOURCE", "snowflakecomputing.com")

        token_result = await client_credentials_grant(
            zone_url=zone_url,
            resource=resource,
            get_client_assertion=get_client_assertion,
        )

        if not token_result.ok:
            return token_result.to_json()

        result = await run_agent_loop(
            token_result.data, query, database=database, schema=schema, role=role
        )
        return result.to_json()
