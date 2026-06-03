import os

import httpx
from fastmcp import Context, FastMCP

from keycardai.fastmcp import AccessContext, AuthProvider

from .scope import SCOPE_CLUSTERS_READ, require_scope

DATABRICKS_HOST = os.environ.get(
    "DATABRICKS_HOST", "https://<your-workspace>.cloud.databricks.com"
).rstrip("/")

# Databricks REST endpoints used by this module.
CLUSTERS_LIST_URL = f"{DATABRICKS_HOST}/api/2.0/clusters/list"


async def _databricks_token(ctx: Context) -> tuple[str | None, dict | None]:
    """Read the brokered Databricks token from the access context.

    Returns (token, error). Exactly one is non-None.
    """
    access_context: AccessContext = await ctx.get_state("keycardai")
    if access_context.has_errors():
        return None, {
            "error": "Token exchange failed",
            "details": access_context.get_errors(),
        }
    return access_context.access(DATABRICKS_HOST).access_token, None


def register_list_clusters_tool(mcp: FastMCP, auth_provider: AuthProvider) -> None:
    @mcp.tool()
    @require_scope(SCOPE_CLUSTERS_READ)
    @auth_provider.grant(DATABRICKS_HOST)
    async def list_clusters(ctx: Context) -> dict:
        """List all clusters in the configured Databricks workspace.

        Exchanges the caller's Keycard token for a Databricks-scoped OAuth
        token, then calls GET {DATABRICKS_HOST}/api/2.0/clusters/list.
        Requires scope: databricks:clusters:read
        """
        token, error = await _databricks_token(ctx)
        if error:
            return error

        async with httpx.AsyncClient(timeout=30.0) as client:
            resp = await client.get(
                CLUSTERS_LIST_URL,
                headers={"Authorization": f"Bearer {token}"},
            )

            if resp.status_code != 200:
                return {
                    "error": f"Databricks API error: {resp.status_code}",
                    "details": resp.text,
                }

            return resp.json()
