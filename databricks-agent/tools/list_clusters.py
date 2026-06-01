import os

import httpx
from fastmcp import Context, FastMCP
from fastmcp.server.dependencies import get_access_token

from keycardai.fastmcp import AuthProvider
from keycardai.oauth.types.models import TokenExchangeRequest

from .scope import SCOPE_CLUSTERS_READ, require_scope

DATABRICKS_HOST = os.environ.get(
    "DATABRICKS_HOST", "https://<your-workspace>.cloud.databricks.com"
).rstrip("/")

# Databricks REST endpoints used by this module.
CLUSTERS_LIST_URL = f"{DATABRICKS_HOST}/api/2.0/clusters/list"


async def _exchange_token_with_scope(
    auth_provider: AuthProvider, resource: str, scope: str
) -> tuple[str | None, dict | None]:
    """Exchange the caller's Keycard token for a resource token carrying `scope`.

    This mirrors `auth_provider.grant(...)`, but sets `scope` on the RFC 8693
    request so Keycard's PDP sees `context.scopes` and can match a scope-gated
    delegation policy. Returns (access_token, error); exactly one is non-None.
    """
    user_token = get_access_token()
    if user_token is None or not getattr(user_token, "token", None):
        return None, {
            "error": "unauthenticated",
            "details": "No caller token available for token exchange.",
        }

    if auth_provider.application_credential is not None:
        request = await auth_provider.application_credential.prepare_token_exchange_request(
            client=auth_provider.client,
            subject_token=user_token.token,
            resource=resource,
            auth_info={
                "resource_server_url": auth_provider.mcp_base_url,
                "zone_id": "",
            },
        )
        request.scope = scope
    else:
        request = TokenExchangeRequest(
            subject_token=user_token.token,
            resource=resource,
            subject_token_type="urn:ietf:params:oauth:token-type:access_token",
            scope=scope,
        )

    try:
        token_response = await auth_provider.client.exchange_token(request)
    except Exception as exc:
        return None, {
            "error": "Token exchange failed",
            "details": str(exc),
        }

    return token_response.access_token, None


def register_list_clusters_tool(mcp: FastMCP, auth_provider: AuthProvider) -> None:
    @mcp.tool()
    @require_scope(SCOPE_CLUSTERS_READ)
    async def list_clusters(ctx: Context) -> dict:
        """List all clusters in the configured Databricks workspace.

        Exchanges the caller's Keycard token for a Databricks-scoped OAuth
        token, then calls GET {DATABRICKS_HOST}/api/2.0/clusters/list.
        Requires scope: databricks:clusters:read
        """
        token, error = await _exchange_token_with_scope(
            auth_provider, DATABRICKS_HOST, SCOPE_CLUSTERS_READ
        )
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
