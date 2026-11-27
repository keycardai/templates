"""Linear MCP proxy with Keycard-brokered credentials.

Proxies Linear's official MCP server at https://mcp.linear.app/mcp.
Exchanges the user's Keycard bearer token for a Linear-scoped OAuth token
via RFC 8693 on every tool call. No API keys stored anywhere.

Run with:
    uvicorn main:app --host 0.0.0.0 --port 8000
Or via keycard run:
    keycard run -- uvicorn main:app --host 0.0.0.0 --port 8000
"""

import contextlib
import os
from urllib.parse import unquote, urlsplit

from dotenv import find_dotenv, load_dotenv
from keycardai.oauth import AsyncClient
from keycardai.oauth.types.models import ClientConfig
from keycardai.starlette import AuthProvider, protected_router
from mcp.server.mcpserver import MCPServer
from starlette.applications import Starlette
from starlette.responses import JSONResponse
from starlette.routing import Route

from tools.execute import register_execute_tool
from tools.search import register_search_tool

load_dotenv(find_dotenv(usecwd=True))

KEYCARD_URL = os.environ.get("KEYCARD_URL")
PORT = int(os.environ.get("PORT", "8000"))
RESOURCE_ID = os.environ.get("KEYCARD_RESOURCE_ID")
if not RESOURCE_ID:
    if os.environ.get("MCP_SERVER_URL"):
        raise RuntimeError(
            "MCP_SERVER_URL is no longer read. "
            "Set KEYCARD_RESOURCE_ID to the registered resource URL (e.g. <base>/mcp)."
        )
    RESOURCE_ID = f"http://localhost:{PORT}/mcp"
resource_url = urlsplit(RESOURCE_ID)
if resource_url.scheme not in {"http", "https"} or not resource_url.netloc:
    raise ValueError("KEYCARD_RESOURCE_ID must be an HTTP(S) URL")
MCP_PATH = unquote(resource_url.path) or "/"
SERVER_NAME = "mcp-brokered-credentials-python"

if not KEYCARD_URL:
    raise RuntimeError(
        "KEYCARD_URL is required. "
        "Set it in .env or run via `keycard run -- uvicorn main:app`."
    )

auth_provider = AuthProvider(
    zone_url=KEYCARD_URL,
    resource_identifier=RESOURCE_ID,
    server_name=SERVER_NAME,
)

mcp = MCPServer(SERVER_NAME)
oauth_client = AsyncClient(
    issuer=auth_provider.issuer,
    credential=auth_provider.application_credential,
    config=ClientConfig(
        client_name=SERVER_NAME,
        auto_register_client=auth_provider.application_credential is None,
    ),
)
register_search_tool(mcp, oauth_client)
register_execute_tool(mcp, oauth_client)


async def healthz(request):
    return JSONResponse({"ok": True, "name": SERVER_NAME})


@contextlib.asynccontextmanager
async def lifespan(app):
    try:
        async with mcp.session_manager.run():
            yield
    finally:
        await oauth_client.aclose()


app = Starlette(
    routes=[
        Route("/healthz", healthz, methods=["GET"]),
        *protected_router(
            issuer=auth_provider.issuer,
            app=mcp.streamable_http_app(streamable_http_path=MCP_PATH),
            verifier=auth_provider.get_token_verifier(),
            resource_binding=auth_provider.resource_binding,
            require_authentication=True,
        ),
    ],
    lifespan=lifespan,
)

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=PORT)
