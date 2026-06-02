"""Databricks SQL Warehouse tools — Keycard-brokered credentials.

Each tool exchanges the caller's Keycard token for a Databricks-scoped OAuth
token via `@auth_provider.grant`, then calls the Databricks SQL REST API. Each
tool is gated by its own scope via `@require_scope`.
"""

import os

import httpx
from fastmcp import Context, FastMCP

from keycardai.fastmcp import AccessContext, AuthProvider

from .scope import (
    SCOPE_SQL_EXECUTE,
    SCOPE_SQL_READ,
    SCOPE_SQL_WAREHOUSES_READ,
    require_scope,
)

DATABRICKS_HOST = os.environ.get(
    "DATABRICKS_HOST", "https://<your-workspace>.cloud.databricks.com"
).rstrip("/")

# Databricks SQL REST endpoints used by this module. Parameterized endpoints
# expose `.format(...)` placeholders for the path segments they need.
WAREHOUSES_URL = f"{DATABRICKS_HOST}/api/2.0/sql/warehouses"
STATEMENTS_URL = f"{DATABRICKS_HOST}/api/2.0/sql/statements"
STATEMENT_URL = f"{DATABRICKS_HOST}/api/2.0/sql/statements/{{statement_id}}"

# Default warehouse for `execute_statement` when the caller omits one.
DEFAULT_WAREHOUSE_ID = os.environ.get("DATABRICKS_WAREHOUSE_ID", "")


async def _databricks_token(ctx: Context) -> tuple[str | None, dict | None]:
    """Read the brokered Databricks token from the access context.

    Returns (token, error). Exactly one is non-None.
    """
    access_context: AccessContext = await ctx.get_state("keycardai")
    if access_context.has_errors():
        return None, {
            "error": "Token exchange failed",
            "details": access_context.get_errors(),
        }
    return access_context.access(DATABRICKS_HOST).access_token, None


def register_sql_tools(mcp: FastMCP, auth_provider: AuthProvider) -> None:
    """Register the SQL Warehouse tools on the MCP server."""

    @mcp.tool()
    @require_scope(SCOPE_SQL_WAREHOUSES_READ)
    @auth_provider.grant(DATABRICKS_HOST, request_scopes=SCOPE_SQL_WAREHOUSES_READ)
    async def list_warehouses(ctx: Context) -> dict:
        """List the SQL warehouses in the configured Databricks workspace.

        Calls GET {DATABRICKS_HOST}/api/2.0/sql/warehouses.
        Requires scope: databricks:sql:warehouses:read
        """
        token, error = await _databricks_token(ctx)
        if error:
            return error

        async with httpx.AsyncClient(timeout=30.0) as client:
            resp = await client.get(
                WAREHOUSES_URL,
                headers={"Authorization": f"Bearer {token}"},
            )
            if resp.status_code != 200:
                return {
                    "error": f"Databricks API error: {resp.status_code}",
                    "details": resp.text,
                }
            return resp.json()

    @mcp.tool()
    @require_scope(SCOPE_SQL_EXECUTE)
    @auth_provider.grant(DATABRICKS_HOST, request_scopes=SCOPE_SQL_EXECUTE)
    async def execute_statement(
        ctx: Context,
        statement: str,
        warehouse_id: str | None = None,
        catalog: str | None = None,
        schema: str | None = None,
        wait_timeout: str = "30s",
    ) -> dict:
        """Run a SQL statement on a Databricks SQL warehouse.

        Calls POST {DATABRICKS_HOST}/api/2.0/sql/statements. Small queries
        return inline within `wait_timeout`; longer ones return a
        `statement_id` to poll with `get_statement`.
        Requires scope: databricks:sql:execute

        Args:
            statement: The SQL text to execute.
            warehouse_id: Warehouse to run on (defaults to DATABRICKS_WAREHOUSE_ID).
            catalog: Optional default catalog for the statement.
            schema: Optional default schema for the statement.
            wait_timeout: How long to wait inline before returning a statement_id.
        """
        token, error = await _databricks_token(ctx)
        if error:
            return error

        resolved_warehouse = warehouse_id or DEFAULT_WAREHOUSE_ID
        if not resolved_warehouse:
            return {
                "error": "missing_warehouse_id",
                "details": (
                    "Provide warehouse_id or set DATABRICKS_WAREHOUSE_ID. "
                    "Use list_warehouses to discover available IDs."
                ),
            }

        body: dict = {
            "statement": statement,
            "warehouse_id": resolved_warehouse,
            "wait_timeout": wait_timeout,
        }
        if catalog:
            body["catalog"] = catalog
        if schema:
            body["schema"] = schema

        async with httpx.AsyncClient(timeout=60.0) as client:
            resp = await client.post(
                STATEMENTS_URL,
                headers={"Authorization": f"Bearer {token}"},
                json=body,
            )
            if resp.status_code != 200:
                return {
                    "error": f"Databricks API error: {resp.status_code}",
                    "details": resp.text,
                }
            return resp.json()

    @mcp.tool()
    @require_scope(SCOPE_SQL_READ)
    @auth_provider.grant(DATABRICKS_HOST, request_scopes=SCOPE_SQL_READ)
    async def get_statement(ctx: Context, statement_id: str) -> dict:
        """Fetch the status and result of a previously submitted SQL statement.

        Calls GET {DATABRICKS_HOST}/api/2.0/sql/statements/{statement_id}.
        Requires scope: databricks:sql:read

        Args:
            statement_id: The ID returned by execute_statement.
        """
        token, error = await _databricks_token(ctx)
        if error:
            return error

        async with httpx.AsyncClient(timeout=30.0) as client:
            resp = await client.get(
                STATEMENT_URL.format(statement_id=statement_id),
                headers={"Authorization": f"Bearer {token}"},
            )
            if resp.status_code != 200:
                return {
                    "error": f"Databricks API error: {resp.status_code}",
                    "details": resp.text,
                }
            return resp.json()
