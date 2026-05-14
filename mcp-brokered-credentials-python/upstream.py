"""Linear MCP client factory with Keycard token exchange.

Mirrors the TypeScript template's withLinearClient pattern: exchange the
user's Keycard bearer token for a Linear-scoped token via RFC 8693, then
open a fresh MCP session to the upstream Linear server.
"""

import contextlib

import httpx
from mcp import ClientSession
from mcp.client.streamable_http import streamable_http_client
from mcp.server.fastmcp import Context
from keycardai.mcp.server.auth import AuthProvider
from keycardai.oauth.server import AccessContext, exchange_tokens_for_resources

LINEAR_MCP_URL = "https://mcp.linear.app/mcp"


@contextlib.asynccontextmanager
async def linear_client_for_user(auth_provider: AuthProvider, ctx: Context):
    """Exchange the user's Keycard token for a Linear token and open an MCP session.

    Equivalent to the TypeScript template's withLinearClient. Reads the bearer
    token from ctx.request_context.request.user (set by KeycardAuthBackend after
    validation) and exchanges it for a Linear-scoped token via RFC 8693.

    Note: uses auth_provider._get_or_create_client() because the Python SDK does
    not yet expose a public exchange_tokens() method equivalent to the TypeScript
    one. This should be updated once that surface is added to keycardai-mcp.
    """
    user = ctx.request_context.request.user
    bearer_token: str = user.access_token
    auth_info = {
        "access_token": bearer_token,
        "zone_id": getattr(user, "zone_id", None),
        "client_id": getattr(user, "client_id", None),
    }

    oauth_client = await auth_provider._get_or_create_client(auth_info)
    if oauth_client is None:
        raise RuntimeError("Keycard OAuth client not initialized — check KEYCARD_URL and credentials")

    access_ctx = await exchange_tokens_for_resources(
        client=oauth_client,
        resources=[LINEAR_MCP_URL],
        subject_token=bearer_token,
        access_context=AccessContext(),
        application_credential=auth_provider.application_credential,
        auth_info=auth_info,
    )

    if access_ctx.has_errors():
        raise RuntimeError(f"Token exchange for {LINEAR_MCP_URL} failed: {access_ctx.get_errors()}")

    linear_token = access_ctx.access(LINEAR_MCP_URL).access_token

    async with httpx.AsyncClient(
        headers={"Authorization": f"Bearer {linear_token}"},
        timeout=30.0,
    ) as http_client:
        async with streamable_http_client(
            LINEAR_MCP_URL, http_client=http_client
        ) as (read, write, _):
            async with ClientSession(read, write) as session:
                await session.initialize()
                yield session
