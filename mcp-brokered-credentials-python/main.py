"""Linear MCP proxy — Keycard-brokered credentials.

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

from dotenv import find_dotenv, load_dotenv

load_dotenv(find_dotenv(usecwd=True))

KEYCARD_URL = os.environ.get("KEYCARD_URL")
SERVER_URL = os.environ.get("MCP_SERVER_URL", "http://localhost:8000/")
PORT = int(os.environ.get("PORT", "8000"))
SERVER_NAME = "mcp-brokered-credentials-python"

if not KEYCARD_URL:
    raise RuntimeError(
        "KEYCARD_URL is required. "
        "Set it in .env or run via `keycard run -- uvicorn main:app`."
    )

from mcp.server.fastmcp import FastMCP
from keycardai.mcp.server.auth import AuthProvider
from keycardai.starlette import KeycardAuthBackend, keycard_on_error
from keycardai.starlette.routers.metadata import auth_metadata_mount
from starlette.applications import Starlette
from starlette.middleware import Middleware
from starlette.middleware.authentication import AuthenticationMiddleware
from starlette.responses import JSONResponse
from starlette.routing import Mount, Route

from tools.search import register_search_tool
from tools.execute import register_execute_tool

auth_provider = AuthProvider(
    zone_url=KEYCARD_URL,
    mcp_server_name=SERVER_NAME,
    mcp_server_url=SERVER_URL,
)

mcp = FastMCP(SERVER_NAME, streamable_http_path="/")
register_search_tool(mcp, auth_provider)
register_execute_tool(mcp, auth_provider)


async def healthz(request):
    return JSONResponse({"ok": True, "name": SERVER_NAME})


@contextlib.asynccontextmanager
async def lifespan(app):
    async with mcp.session_manager.run():
        yield


verifier = auth_provider.get_token_verifier()
strict_auth = Middleware(
    AuthenticationMiddleware,
    backend=KeycardAuthBackend(verifier, require_authentication=True),
    on_error=keycard_on_error,
)

app = Starlette(
    routes=[
        Route("/healthz", healthz, methods=["GET"]),
        auth_metadata_mount(auth_provider.issuer),
        Mount("/mcp", app=mcp.streamable_http_app(), middleware=[strict_auth]),
    ],
    lifespan=lifespan,
)

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=PORT)
