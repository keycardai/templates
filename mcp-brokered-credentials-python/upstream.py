"""Linear MCP client factory with Keycard token exchange."""

import contextlib

import httpx
from keycardai.oauth import AsyncClient
from mcp import ClientSession
from mcp.client.streamable_http import streamable_http_client
from mcp.server.mcpserver import Context

LINEAR_MCP_URL = "https://mcp.linear.app/mcp"


@contextlib.asynccontextmanager
async def linear_client_for_user(oauth_client: AsyncClient, ctx: Context):
    token = await oauth_client.exchange_token(
        subject_token=ctx.request_context.request.user.access_token,
        resource=LINEAR_MCP_URL,
    )

    async with httpx.AsyncClient(
        headers={"Authorization": f"Bearer {token.access_token}"},
        timeout=30.0,
    ) as http_client:
        async with streamable_http_client(
            LINEAR_MCP_URL, http_client=http_client
        ) as (read, write, _):
            async with ClientSession(read, write) as session:
                await session.initialize()
                yield session
