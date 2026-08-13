"""Configuration management for the MCP token exchange server."""

import os
from dataclasses import dataclass

from dotenv import load_dotenv

# Load environment variables from .env file
load_dotenv()


@dataclass
class ServerConfig:
    """Configuration for the MCP server and STS integration."""
    # Server Configuration (optional with defaults)
    host: str = "0.0.0.0"
    port: int = 7878

def get_config() -> ServerConfig:
    """Load configuration from environment variables.

    Returns:
        ServerConfig with all necessary configuration values

    Raises:
        ValueError: If required environment variables are missing
    """
    config_values = {}

    # Optional configuration with defaults
    host = os.getenv("MCP_HOST", "0.0.0.0")
    port = int(os.getenv("MCP_PORT", "7878"))

    config_values.update(
        {
            "host": host,
            "port": port,
        }
    )

    return ServerConfig(**config_values)
