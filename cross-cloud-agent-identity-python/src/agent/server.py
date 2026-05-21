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
from starlette.responses import JSONResponse
from starlette.routing import Mount, Route

from keycardai.mcp.server.auth import AuthProvider
from keycardai.mcp.server.middleware.bearer import BearerAuthMiddleware
from keycardai.mcp.server.routers.metadata import (
    well_known_authorization_server_route,
    well_known_jwks_route,
)
from mcp.server.transport_security import TransportSecuritySettings

from .scope import SCOPE_AGENT_IDENTITY, SCOPE_DELEGATE, SCOPE_IMPERSONATE
from .tokens.platform import VercelOIDCMiddleware
from .tokens.bootstrap import bootstrap_api_key
from .tools.delegate import register_delegate_tool
from .tools.impersonate import register_impersonate_tool
from .tools.agent_identity import register_agent_identity_tool

SUPPORTED_SCOPES = [SCOPE_DELEGATE, SCOPE_IMPERSONATE, SCOPE_AGENT_IDENTITY]

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
    stateless_http=True,
    transport_security=TransportSecuritySettings(
        enable_dns_rebinding_protection=False,
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


def _build_routes():
    """Rebuild the keycardai-mcp router with `scopes_supported` advertised
    on the protected-resource metadata endpoint. The library's built-in
    metadata route hardcodes only `authorization_servers`, so we override
    it here and reuse BearerAuthMiddleware + the other library routes."""
    issuer = auth_provider.issuer
    verifier = auth_provider.get_token_verifier()
    jwks = auth_provider.jwks

    async def protected_resource_metadata(request):
        path = request.url.path.removeprefix("/.well-known/oauth-protected-resource")
        base = f"{request.url.scheme}://{request.url.netloc}"
        resource = f"{base}{path}".rstrip("/")
        body = {
            "resource": resource,
            "authorization_servers": [issuer],
            "jwks_uri": f"{base}/.well-known/jwks.json",
            "scopes_supported": SUPPORTED_SCOPES,
            "bearer_methods_supported": ["header"],
            "client_id": resource,
            "client_name": "MCP Server",
            "token_endpoint_auth_method": "private_key_jwt",
            "grant_types": ["client_credentials"],
        }
        return JSONResponse(body)

    well_known_routes = [
        Route(
            "/oauth-protected-resource/{resource_path:path}",
            protected_resource_metadata,
            name="oauth-protected-resource",
        ),
        well_known_authorization_server_route(issuer),
    ]
    if jwks:
        well_known_routes.append(well_known_jwks_route(jwks))

    return [
        Mount("/.well-known", routes=well_known_routes),
        Mount(
            "/",
            app=mcp.streamable_http_app(),
            middleware=[Middleware(BearerAuthMiddleware, verifier)],
        ),
    ]


app = Starlette(
    routes=_build_routes(),
    lifespan=lifespan,
    middleware=[Middleware(VercelOIDCMiddleware)],
)


def main():
    host = os.getenv("SERVER_HOST", "localhost")
    port = int(os.getenv("SERVER_PORT", "8050"))
    logger.info(f"Starting MCP server on {host}:{port}")
    uvicorn.run(app, host=host, port=port, proxy_headers=True, forwarded_allow_ips="*")


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    main()
