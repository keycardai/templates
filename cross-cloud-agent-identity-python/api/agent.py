"""Vercel ASGI entrypoint.

Imports the Starlette app from the agent server module. Vercel's Python
runtime picks this up via the [tool.vercel] entrypoint in pyproject.toml.
"""

import os

os.environ.setdefault("SERVER_URL", os.getenv("VERCEL_URL", "http://localhost:8050"))

from agent.server import app  # noqa: E402
