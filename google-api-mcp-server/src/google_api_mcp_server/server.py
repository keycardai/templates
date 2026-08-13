"""
Google API MCP Server with Delegated Token Exchange

This example demonstrates how to use the unified KeyCard OAuth client
to perform delegated token exchange and access Google APIs
on behalf of authenticated users.

Key features:
- Token exchange for Google API access
- Direct Google API integration
- Proper error handling and data validation
- Clean, modular tool implementation
"""

import asyncio
import contextlib
from typing import Optional

from mcp.server.transport_security import TransportSecuritySettings
import uvicorn
from keycardai.mcp.server.auth import AccessContext, AuthProvider
from mcp.server.fastmcp import Context, FastMCP
from starlette.applications import Starlette
from starlette.middleware import Middleware
from starlette.middleware.cors import CORSMiddleware
from starlette.types import ASGIApp

from .config import get_config
from .tools import get_calendar_events, get_drive_files

# Load configuration
config = get_config()
print(config)

# Create KeyCard authentication provider
auth = AuthProvider()

# Initialize MCP server with OAuth middleware
mcp = FastMCP(name="GoogleApiMcpServer", transport_security=TransportSecuritySettings(
        enable_dns_rebinding_protection=False,
    ))

# Register Google Calendar tools
@mcp.tool(name="get_meetings", description="Get my meetings from google calendar")
@auth.grant("https://www.googleapis.com/calendar/v3")
async def get_meetings(
    ctx: Context,
    access_context: AccessContext,
    maxResults: int = 10,
    timeMin: Optional[str] = None,
    timeMax: Optional[str] = None,
    calendarId: str = "primary",
):
    """Get Google Calendar events for the authenticated user.

    Uses delegated token exchange to obtain Google Calendar access on behalf
    of the authenticated user, then fetches their calendar events.

    Args:
        ctx: Request context containing user authentication
        maxResults: Maximum number of events to return (1-50, default: 10)
        timeMin: Start time filter in ISO 8601 format (default: now)
        timeMax: End time filter in ISO 8601 format (default: 7 days from now)
        calendarId: Calendar identifier (default: "primary")

    Returns:
        Dictionary containing calendar events and metadata
    """
    if access_context.has_errors():
        print("Error: ", access_context.get_errors())
        return {"error": "❌ Token exchange failed",  "isError": True}
    return await get_calendar_events(access_context=access_context, maxResults=maxResults, timeMin=timeMin, timeMax=timeMax, calendarId=calendarId)

# Register Google Drive tools
@mcp.tool(name="get_files", description="Get my files from google drive")
@auth.grant("https://www.googleapis.com/drive/v3")
async def get_files(
    ctx: Context,
    access_context: AccessContext,
    maxResults: int = 10,
    query: Optional[str] = None,
    orderBy: str = "modifiedTime desc",
    trashed: bool = False,
):
    """Get Google Drive files for the authenticated user.

    Uses delegated token exchange to obtain Google Drive access on behalf
    of the authenticated user, then fetches their files.

    Args:
        ctx: Request context containing user authentication
        maxResults: Maximum number of files to return (1-100, default: 10)
        query: Search query using Google Drive API syntax (optional)
        orderBy: Sort order for results (default: "modifiedTime desc")
        trashed: Include trashed files (default: False)

    Returns:
        Dictionary containing Drive files and metadata
    """
    if access_context.has_errors():
        print("Error: ", access_context.get_errors())
        return {"error": "❌ Token exchange failed",  "isError": True}
    return await get_drive_files(access_context=access_context, maxResults=maxResults, query=query, orderBy=orderBy, trashed=trashed)

middleware = [
    Middleware(CORSMiddleware, allow_methods=['*'], allow_origins=['*'], allow_headers=['*'])
]

def get_app(app, mcp_app: FastMCP, middleware: list[Middleware] = None) -> ASGIApp:
    """Get the MCP app with authentication middleware and metadata endpoints."""
    if middleware is None:
        middleware = []
    @contextlib.asynccontextmanager
    async def lifespan(app: Starlette):
        async with contextlib.AsyncExitStack() as stack:
            await stack.enter_async_context(mcp_app.session_manager.run())
            yield
    return Starlette(
        routes=app.get_mcp_router(mcp_app.streamable_http_app()),
        lifespan=lifespan,
        middleware=middleware,
    )

app = get_app(auth, mcp, middleware=middleware)

def main():
    server_config = uvicorn.Config(app, host=config.host, port=config.port)
    server = uvicorn.Server(server_config)
    asyncio.run(server.serve())

if __name__ == "__main__":
    main()
