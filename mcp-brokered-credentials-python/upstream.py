"""Linear MCP client factory.

Opens a fresh, authenticated MCP session to the upstream Linear server using a
token brokered from the user's Keycard bearer token. A new session is opened per
call; the volume of search/execute traffic does not justify a session pool, and
per-call connections keep the brokered token's lifetime tight.
"""

import contextlib

import httpx
from mcp import ClientSession
from mcp.client.streamable_http import streamable_http_client

LINEAR_MCP_URL = "https://mcp.linear.app/mcp"


@contextlib.asynccontextmanager
async def linear_client(token: str):
    async with httpx.AsyncClient(
        headers={"Authorization": f"Bearer {token}"},
        timeout=30.0,
    ) as http_client:
        async with streamable_http_client(
            LINEAR_MCP_URL, http_client=http_client
        ) as (read, write, _):
            async with ClientSession(read, write) as session:
                await session.initialize()
                yield session
