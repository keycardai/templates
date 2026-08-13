"""
Google API MCP Server with Delegated Token Exchange

This package demonstrates how to build a real-world MCP server that uses the
KeyCard OAuth SDK for delegated token exchange to access Google APIs
on behalf of authenticated users.

Example Usage:
    python -m google_api_mcp_server

    Or using the installed script:
    mcp-google-api-server
"""

__version__ = "0.1.0"
__author__ = "KeyCard AI"
__email__ = "hello@keycard.ai"

from .server import main

__all__ = ["main"]
