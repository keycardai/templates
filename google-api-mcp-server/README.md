# Google API MCP Server

A standalone example demonstrating how to build an MCP (Model Context Protocol) server that uses the Keycard OAuth SDK for delegated token exchange to access Google APIs on behalf of authenticated users.

## Prerequisites

- Python 3.10+
- [uv](https://github.com/astral-sh/uv) installed

> **Note**: This project uses Keycard Python SDK packages (`keycardai-oauth` and `keycardai-mcp-fastmcp`) from the TestPyPI index. These packages are automatically installed during the setup process.

## Setup

1. **Clone this project**:
   ```bash
   git clone https://github.com/keycardai/python-google-api-mcp-server
   cd python-google-api-mcp-server
   ```

2. **Install dependencies**:
   ```bash
   uv sync
   ```

3. **Configure environment**:

   Create a `.env` file in the project root with your Keycard credentials:

   ```bash
   # Keycard Configuration (required)
   KEYCARD_ZONE_URL=https://your-zone.keycard.ai
   KEYCARD_CLIENT_ID=your-client-id
   KEYCARD_CLIENT_SECRET=your-client-secret

   # Server Configuration (optional)
   MCP_HOST=0.0.0.0
   MCP_PORT=7879
   ```

   You can obtain these values from your Keycard dashboard at https://app.keycard.ai.

## Running the Server

```bash
# Run as a mod-m googlule
uv run mcp-google-api-server
```

## Development

```bash
# Install with development dependencies
uv sync --dev

uv run ruff check src/
```

## What This Example Shows

- **Token Exchange**: Uses delegated token exchange to access Google Calendar API
- **MCP Integration**: Implements MCP tools using FastMCP framework
- **Keycard SDK**: Demonstrates usage of `keycardai-oauth` and `keycardai-mcp-fastmcp` packages
- **Error Handling**: Proper error handling and data validation with Pydantic

## Available Tools

- `get_calendar_events_tool`: Fetch Google Calendar events for authenticated users

The server runs on `http://localhost:7879/mcp` by default.