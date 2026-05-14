import json
from typing import Any

from mcp.server.fastmcp import Context, FastMCP
from keycardai.mcp.server.auth import AuthProvider

from upstream import linear_client_for_user


def register_execute_tool(mcp: FastMCP, auth_provider: AuthProvider) -> None:
    @mcp.tool(
        description=(
            "Execute a tool on the upstream Linear MCP server. "
            "Use `search` first to discover available tool names and their input schemas."
        )
    )
    async def execute(
        ctx: Context,
        name: str,
        arguments: dict[str, Any] | None = None,
    ) -> str:
        """name: Tool name exactly as returned by search. arguments: Input matching the tool's inputSchema."""
        async with linear_client_for_user(auth_provider, ctx) as client:
            result = await client.call_tool(name, arguments=arguments or {})

            content = [
                {"type": c.type, "text": c.text if hasattr(c, "text") else str(c)}
                for c in (result.content or [])
            ]
            payload: dict[str, Any] = {"content": content}
            if result.isError:
                payload["isError"] = True
            return json.dumps(payload, indent=2)
