import os

import httpx
from fastmcp import Context, FastMCP

from keycardai.fastmcp import AccessContext, AuthProvider

DATABRICKS_API_RESOURCE = os.environ.get(
    "DATABRICKS_HOST", "https://<your-workspace>.cloud.databricks.com/api/2.0/clusters/list"
).rstrip("/")


def register_list_clusters_tool(mcp: FastMCP, auth_provider: AuthProvider) -> None:
    @mcp.tool()
    @auth_provider.grant(DATABRICKS_API_RESOURCE)
    async def list_clusters(ctx: Context) -> dict:
        """List all clusters in the configured Databricks workspace.

        Exchanges the caller's Keycard token for a Databricks-scoped OAuth
        token, then calls GET {DATABRICKS_HOST}/api/2.0/clusters/list.
        """
        access_context: AccessContext = await ctx.get_state("keycardai")

        if access_context.has_errors():
            return {
                "error": "Token exchange failed",
                "details": access_context.get_errors(),
            }

        token = access_context.access(DATABRICKS_API_RESOURCE).access_token

        async with httpx.AsyncClient(timeout=30.0) as client:
            resp = await client.get(
                DATABRICKS_API_RESOURCE,
                headers={"Authorization": f"Bearer {token}"},
            )

            if resp.status_code != 200:
                return {
                    "error": f"Databricks API error: {resp.status_code}",
                    "details": resp.text,
                }

            return resp.json()
