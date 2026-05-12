"""Hello World MCP Server — Keycard-protected.

A minimal Keycard-protected MCP server. Run with uvicorn:

    uvicorn main:app --host 0.0.0.0 --port 8000

Prerequisites:
    1. A Keycard zone with an STS provider
    2. An Application and Resource registered via SPEC.md
"""

import contextlib
import os

from dotenv import load_dotenv
load_dotenv()

from mcp.server.fastmcp import FastMCP
from keycardai.mcp.server.auth import AuthProvider
from keycardai.starlette import KeycardAuthBackend, keycard_on_error
from keycardai.starlette.routers.metadata import auth_metadata_mount
from starlette.applications import Starlette
from starlette.middleware import Middleware
from starlette.middleware.authentication import AuthenticationMiddleware
from starlette.responses import JSONResponse
from starlette.routing import Mount, Route

ZONE_ID = os.getenv("KEYCARD_ZONE_ID")
ZONE_URL = os.getenv("KEYCARD_ZONE_URL")
SERVER_URL = os.getenv("MCP_SERVER_URL", "http://localhost:8000/")
PORT = int(os.getenv("PORT", "8000"))
SERVER_NAME = "Hello World Server"

if not (ZONE_ID or ZONE_URL):
    raise RuntimeError(
        "Either KEYCARD_ZONE_ID or KEYCARD_ZONE_URL is required. "
        "Set one in .env or run via `keycard run -- uvicorn main:app`."
    )

auth_provider = AuthProvider(
    zone_id=ZONE_ID,
    zone_url=ZONE_URL,
    mcp_server_name=SERVER_NAME,
    mcp_server_url=SERVER_URL,
)

mcp = FastMCP(SERVER_NAME)


@mcp.tool()
def hello_world(name: str) -> str:
    """Say hello to an authenticated user."""
    return f"Hello, {name}! You are authenticated."


async def healthz(request):
    return JSONResponse({"ok": True, "name": SERVER_NAME})


@contextlib.asynccontextmanager
async def lifespan(app):
    async with mcp.session_manager.run():
        yield


# Build the ASGI app explicitly so we can use require_authentication=True
# on the /mcp mount. auth_provider.app() uses the soft backend by default
# (sets request.user but doesn't reject). Strict enforcement returns 401
# before the MCP session is created, which is the correct behavior for
# a production server.
verifier = auth_provider.get_token_verifier()
strict_auth = Middleware(
    AuthenticationMiddleware,
    backend=KeycardAuthBackend(verifier, require_authentication=True),
    on_error=keycard_on_error,
)

app = Starlette(
    routes=[
        Route("/healthz", healthz, methods=["GET"]),
        auth_metadata_mount(auth_provider.issuer),   # public .well-known routes
        Mount("/mcp", app=mcp.streamable_http_app(), middleware=[strict_auth]),
    ],
    lifespan=lifespan,
)

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=PORT)
