"""Per-tool scope enforcement for the Databricks MCP server.

The caller obtains an MCP token whose `scope` claim is filtered by Keycard's PDP
at issuance, and each tool verifies its required scope is present before running.

Enforcement is gated by the `ENFORCE_TOOL_SCOPES` env flag:
- `true`  (default) — the server verifies the tool's scope; a missing scope
  returns an `insufficient_scope` error before any token exchange happens.
- `false`           — the check is a pass-through; authorization is enforced
  later, at token-exchange time, by Keycard's delegation policy.

The token is already verified cryptographically by the FastMCP JWT verifier;
here we only read its claims to inspect the granted scopes.
"""

from __future__ import annotations

import os
from collections.abc import Callable
from functools import wraps
from typing import Any

from fastmcp.server.dependencies import get_access_token

from keycardai.oauth.utils.jwt import extract_scopes, get_claims

# Per-tool scopes. Each MCP tool requires exactly one of these; Keycard's PDP
# decides at issuance which of them a given user may obtain.
SCOPE_CLUSTERS_READ = "databricks:clusters:read"
SCOPE_SQL_WAREHOUSES_READ = "databricks:sql:warehouses:read"
SCOPE_SQL_EXECUTE = "databricks:sql:execute"
SCOPE_SQL_READ = "databricks:sql:read"
SCOPE_GENIE_SPACES_READ = "databricks:genie:spaces:read"
SCOPE_GENIE_CONVERSE = "databricks:genie:converse"
SCOPE_GENIE_READ = "databricks:genie:read"

SUPPORTED_SCOPES = [
    SCOPE_CLUSTERS_READ,
    SCOPE_SQL_WAREHOUSES_READ,
    SCOPE_SQL_EXECUTE,
    SCOPE_SQL_READ,
    SCOPE_GENIE_SPACES_READ,
    SCOPE_GENIE_CONVERSE,
    SCOPE_GENIE_READ,
]


def scope_enforcement_enabled() -> bool:
    """Return True when server-side per-tool scope checks are active."""
    return os.getenv("ENFORCE_TOOL_SCOPES", "true").strip().lower() in (
        "1",
        "true",
        "yes",
        "on",
    )


def _granted_scopes() -> list[str]:
    """Read the granted scopes from the verified caller token."""
    access_token = get_access_token()
    if access_token is None or not getattr(access_token, "token", None):
        return []
    claims = get_claims(access_token.token)
    return extract_scopes(claims)


def require_scope(scope: str) -> Callable:
    """Decorator enforcing that the caller's token carries `scope`.

    When `ENFORCE_TOOL_SCOPES` is disabled the decorator is a pass-through, so
    the same tool code runs whether or not scope enforcement is on. On a missing
    scope it returns a structured error dict instead of raising, keeping the
    MCP protocol response clean.
    """

    def decorator(func: Callable) -> Callable:
        @wraps(func)
        async def wrapper(*args: Any, **kwargs: Any) -> Any:
            if not scope_enforcement_enabled():
                return await func(*args, **kwargs)

            try:
                granted = _granted_scopes()
            except Exception as exc:
                return {
                    "error": "scope_check_failed",
                    "details": f"Unable to read scopes from token: {exc}",
                }

            if scope not in granted:
                return {
                    "error": "insufficient_scope",
                    "required_scope": scope,
                    "granted_scopes": granted,
                    "hint": (
                        "Request a token carrying this scope from Keycard "
                        "(e.g. mcp-client --scopes "
                        f"{scope})."
                    ),
                }

            return await func(*args, **kwargs)

        return wrapper

    return decorator
