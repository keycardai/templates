"""MCP server with scope-gated identity tools.

Deploys identically to Vercel and Fly.io. Uses keycardai-mcp's AuthProvider
which produces a Starlette app with KeycardAuthBackend — request.auth.scopes
is populated after JWT verification, enabling per-tool scope enforcement.
"""

from __future__ import annotations

import contextlib
import logging
import os

import uvicorn
from dotenv import load_dotenv
from mcp.server.fastmcp import FastMCP
from starlette.applications import Starlette
from starlette.middleware import Middleware

from keycardai.mcp.server.auth import AuthProvider

from .tokens.platform import VercelOIDCMiddleware
from .tokens.bootstrap import bootstrap_api_key
from .tools.delegate import register_delegate_tool
from .tools.impersonate import register_impersonate_tool
from .tools.agent_identity import register_agent_identity_tool

load_dotenv()

logger = logging.getLogger(__name__)

mcp = FastMCP(
    "Cross-Cloud Agent Identity",
    instructions=(
        "This MCP server demonstrates three Snowflake connection patterns "
        "using Keycard identity: delegation (act as the caller), "
        "impersonation (act as a specified user), and agent-identity "
        "(act as the application itself). Each tool requires a specific "
        "scope on your access token."
    ),
)

zone_url = os.getenv("KEYCARD_ZONE_URL", "")
server_url = os.getenv("SERVER_URL", "http://localhost:8050")

auth_provider = AuthProvider(
    zone_url=zone_url,
    mcp_server_url=server_url,
    mcp_server_name="cross-cloud-agent-identity",
)

register_delegate_tool(mcp, auth_provider)
register_impersonate_tool(mcp, auth_provider)
register_agent_identity_tool(mcp, auth_provider)


@contextlib.asynccontextmanager
async def lifespan(application: Starlette):
    await bootstrap_api_key()
    async with contextlib.AsyncExitStack() as stack:
        await stack.enter_async_context(mcp.session_manager.run())
        yield


app = Starlette(
    routes=auth_provider.get_mcp_router(mcp.streamable_http_app()),
    lifespan=lifespan,
    middleware=[Middleware(VercelOIDCMiddleware)],
)


def main():
    host = os.getenv("SERVER_HOST", "127.0.0.1")
    port = int(os.getenv("SERVER_PORT", "8050"))
    logger.info(f"Starting MCP server on {host}:{port}")
    uvicorn.run(app, host=host, port=port)


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    main()
