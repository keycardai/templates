"""Snowflake connection helper.

Connects to Snowflake using either:
- Workload Identity Federation (OIDC) for agent-identity and impersonation flows
- External OAuth for delegation flow (Snowflake session token)

Connection is minimal — account, token, authenticator, warehouse. Database/schema/role
context is set dynamically by the introspection layer via USE commands after connect.
"""

from __future__ import annotations

import logging
import os
import time

import snowflake.connector

logger = logging.getLogger(__name__)


def execute_query(token: str, sql: str, authenticator: str = "WORKLOAD_IDENTITY") -> dict:
    """Execute SQL against Snowflake.

    Args:
        token: Access token — a Keycard-issued JWT (for WIF) or a Snowflake
               session token (for External OAuth delegation).
        sql: SQL statement to execute.
        authenticator: "WORKLOAD_IDENTITY" for WIF flows (agent-identity,
                       impersonate) or "oauth" for delegation flow.

    Returns a dict with either 'columns' + 'rows' on success,
    or 'error' on failure.
    """
    account = os.getenv("SNOWFLAKE_ACCOUNT", "")
    warehouse = os.getenv("SNOWFLAKE_WAREHOUSE", "COMPUTE_WH")
    user = os.getenv("SNOWFLAKE_USER", "")

    if not account:
        return {"error": "SNOWFLAKE_ACCOUNT not configured"}

    t0 = time.time()

    try:
        opts: dict = {
            "account": account,
            "token": token,
            "authenticator": authenticator,
            "warehouse": warehouse,
        }
        if authenticator == "WORKLOAD_IDENTITY":
            opts["workload_identity_provider"] = "OIDC"
        if user:
            opts["user"] = user

        conn = snowflake.connector.connect(**opts)
        try:
            cursor = conn.cursor()
            cursor.execute(sql)
            columns = [desc[0] for desc in cursor.description]
            rows = [list(row) for row in cursor.fetchall()]
            elapsed = time.time() - t0

            logger.debug(f"[SNOWFLAKE] {len(rows)} rows, {len(columns)} cols in {elapsed:.2f}s")
            return {"columns": columns, "rows": rows}
        finally:
            conn.close()

    except Exception as e:
        elapsed = time.time() - t0
        logger.error(f"[SNOWFLAKE] Failed after {elapsed:.2f}s: {type(e).__name__}: {e}")
        return {"error": f"Snowflake query failed: {e}", "sql": sql}
