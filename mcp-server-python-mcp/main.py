"""Keycard-protected Hello World MCP server.

A minimal Keycard-protected MCP server. Run with uvicorn:

    uvicorn main:app --host 0.0.0.0 --port 8000

Prerequisites:
    1. A Keycard zone with an STS provider
    2. An Application and Resource registered via SPEC.md
"""

import contextlib
import os
from urllib.parse import urlsplit

from dotenv import find_dotenv, load_dotenv
from keycardai.starlette import AuthProvider, protected_router
from mcp.server.mcpserver import MCPServer
from starlette.applications import Starlette
from starlette.responses import JSONResponse
from starlette.routing import Route

from tools.hello import register_hello_tool

load_dotenv(find_dotenv(usecwd=True))

KEYCARD_URL = os.environ.get("KEYCARD_URL")
PORT = int(os.environ.get("PORT", "8000"))
RESOURCE_ID = os.environ.get("KEYCARD_RESOURCE_ID") or f"http://localhost:{PORT}/mcp"
resource_url = urlsplit(RESOURCE_ID)
if resource_url.scheme not in {"http", "https"} or not resource_url.netloc:
    raise ValueError("KEYCARD_RESOURCE_ID must be an HTTP(S) URL")
MCP_PATH = resource_url.path or "/"
SERVER_NAME = "Hello World Server"

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
register_hello_tool(mcp)


async def healthz(request):
    return JSONResponse({"ok": True, "name": SERVER_NAME})


@contextlib.asynccontextmanager
async def lifespan(app):
    async with mcp.session_manager.run():
        yield


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
