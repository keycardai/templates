from mcp.server.fastmcp import FastMCP


def register_hello_tool(mcp: FastMCP) -> None:
    @mcp.tool()
    def hello_world(name: str) -> str:
        """Say hello to an authenticated user."""
        return f"Hello, {name}! You are authenticated."
