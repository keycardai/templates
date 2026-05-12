"""Hello World MCP Server — Keycard-protected.

A minimal Keycard-protected MCP server. Run with uvicorn:

    uvicorn main:app --host 0.0.0.0 --port 8000

Prerequisites:
    1. A Keycard zone with an STS provider
    2. An Application and Resource registered via SPEC.md
"""

import os

from dotenv import load_dotenv
load_dotenv()

from mcp.server.fastmcp import FastMCP
from keycardai.mcp.server.auth import AuthProvider
from starlette.responses import JSONResponse
from starlette.routing import Route

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


# auth_provider.app(mcp) returns a Starlette app that handles auth middleware,
# .well-known discovery routes, and the MCP transport with its own task group
# lifecycle. We insert /healthz directly into its route list before the first
# request — wrapping in another Starlette app would prevent FastMCP's task
# group from initialising and cause 500 errors on POST /mcp.
app = auth_provider.app(mcp)
app.router.routes.insert(0, Route("/healthz", healthz, methods=["GET"]))

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=PORT)
