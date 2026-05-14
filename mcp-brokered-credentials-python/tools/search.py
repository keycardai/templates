import json
import re

from mcp.server.fastmcp import Context, FastMCP
from keycardai.mcp.server.auth import AuthProvider

from upstream import linear_client_for_user


def register_search_tool(mcp: FastMCP, auth_provider: AuthProvider) -> None:
    @mcp.tool(
        description=(
            "Search the upstream Linear MCP server's tool catalog by regex. "
            "Returns name, description, and input schema for tools whose name "
            "or description matches the pattern."
        )
    )
    async def search(ctx: Context, pattern: str) -> str:
        try:
            regex = re.compile(pattern, re.IGNORECASE)
        except re.error as exc:
            raise Exception(f"Invalid regex pattern: {exc}") from exc

        async with linear_client_for_user(auth_provider, ctx) as client:
            result = await client.list_tools()
            matched = [
                {
                    "name": t.name,
                    "description": t.description or "",
                    "inputSchema": t.inputSchema,
                }
                for t in result.tools
                if regex.search(t.name)
                or (t.description and regex.search(t.description))
            ]
            return json.dumps({"matches": matched}, indent=2)
