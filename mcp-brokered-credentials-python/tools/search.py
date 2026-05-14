import json
import re

from mcp.server.fastmcp import Context, FastMCP
from keycardai.mcp.server.auth import AccessContext, AuthProvider

from upstream import LINEAR_MCP_URL, linear_client


def register_search_tool(mcp: FastMCP, auth_provider: AuthProvider) -> None:
    @mcp.tool(
        description=(
            "Search the upstream Linear MCP server's tool catalog by regex. "
            "Returns name, description, and input schema for tools whose name "
            "or description matches the pattern."
        )
    )
    @auth_provider.grant(LINEAR_MCP_URL)
    async def search(access_ctx: AccessContext, ctx: Context, pattern: str) -> str:
        """pattern: Regex matched case-insensitively against each tool's name and description."""
        if access_ctx.has_errors():
            raise Exception(f"Token exchange failed: {access_ctx.get_errors()}")

        try:
            regex = re.compile(pattern, re.IGNORECASE)
        except re.error as exc:
            raise Exception(f"Invalid regex pattern: {exc}") from exc

        token = access_ctx.access(LINEAR_MCP_URL).access_token
        async with linear_client(token) as client:
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
