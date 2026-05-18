"""Per-tool scope enforcement for MCP tools.

Uses the Starlette auth state already populated by KeycardAuthBackend
(via keycardai-mcp's AuthProvider). Reads request.auth.scopes from the
MCP RequestContext — the same mechanism as keycardai.starlette.requires()
but adapted for MCP tool handlers.
"""

from __future__ import annotations

from functools import wraps
from typing import Any, Callable

from starlette.authentication import has_required_scope

from .result import Error, Result

SCOPE_DELEGATE = "snowflake:delegate"
SCOPE_IMPERSONATE = "snowflake:impersonate"
SCOPE_AGENT_IDENTITY = "snowflake:agent-identity"


def require_scope(scope: str) -> Callable:
    """Decorator that enforces a scope requirement on an MCP tool handler.

    The decorated function must accept a `ctx` parameter (MCP Context or
    RequestContext) from which the Starlette request is extracted. If the
    caller's token lacks the required scope, a structured error is returned
    instead of raising — keeping the MCP protocol clean.
    """

    def decorator(func: Callable) -> Callable:
        @wraps(func)
        async def wrapper(*args: Any, **kwargs: Any) -> str:
            from mcp.server.fastmcp import Context

            ctx = kwargs.get("ctx")
            if ctx is None:
                for arg in args:
                    if isinstance(arg, Context):
                        ctx = arg
                        break

            if ctx is None:
                return Result.failure(
                    Error.INTERNAL, "No MCP context available for scope check"
                ).to_json()

            try:
                request = ctx.request_context.request
                if not has_required_scope(request, [scope]):
                    return Result.failure(
                        Error.INSUFFICIENT_SCOPE,
                        f"Insufficient scope: requires '{scope}'",
                        details={
                            "required_scope": scope,
                            "hint": "Request a token with this scope from your authorization server",
                        },
                    ).to_json()
            except AttributeError:
                return Result.failure(
                    Error.INTERNAL,
                    "Unable to access auth state from request context",
                ).to_json()

            return await func(*args, **kwargs)

        return wrapper

    return decorator
