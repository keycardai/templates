from mcp.server.mcpserver import MCPServer


def register_hello_tool(mcp: MCPServer) -> None:
    @mcp.tool()
    def hello_world(name: str) -> str:
        """Say hello to an authenticated user."""
        return f"Hello, {name}! You are authenticated."
