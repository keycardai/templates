import json
from typing import Any

from mcp.server.fastmcp import Context, FastMCP
from keycardai.mcp.server.auth import AccessContext, AuthProvider

from upstream import LINEAR_MCP_URL, linear_client


def register_execute_tool(mcp: FastMCP, auth_provider: AuthProvider) -> None:
    @mcp.tool(
        description=(
            "Execute a tool on the upstream Linear MCP server. "
            "Use `search` first to discover available tool names and their input schemas."
        )
    )
    @auth_provider.grant(LINEAR_MCP_URL)
    async def execute(
        access_ctx: AccessContext,
        ctx: Context,
        name: str,
        arguments: dict[str, Any] | None = None,
    ) -> str:
        """name: Tool name exactly as returned by search. arguments: Input matching the tool's inputSchema."""
        if access_ctx.has_errors():
            raise Exception(f"Token exchange failed: {access_ctx.get_errors()}")

        token = access_ctx.access(LINEAR_MCP_URL).access_token
        async with linear_client(token) as client:
            result = await client.call_tool(name, arguments=arguments or {})

            content = [
                {"type": c.type, "text": c.text if hasattr(c, "text") else str(c)}
                for c in (result.content or [])
            ]
            payload: dict[str, Any] = {"content": content}
            if result.isError:
                payload["isError"] = True
            return json.dumps(payload, indent=2)
