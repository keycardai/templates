"""Snowflake introspection: identity-first dynamic schema discovery.

Discovers accessible tables using a three-phase approach:
1. Identity resolution (who am I, what role, what grants)
2. Scope determination (caller hints > env vars > grant-based discovery)
3. Targeted enumeration (only schemas the role can actually access)
"""

from __future__ import annotations

import logging
import os

from .connection import execute_query
from .identity import IdentityContext, discover_identity, SYSTEM_SCHEMAS

logger = logging.getLogger(__name__)

MAX_TABLES = 50


def discover_schema(
    token: str,
    database: str | None = None,
    schema: str | None = None,
    role: str | None = None,
    authenticator: str = "WORKLOAD_IDENTITY",
) -> tuple[IdentityContext, list[dict]]:
    """Discover identity and accessible schema, optionally scoped by caller hints.

    Priority for scope resolution:
    1. Caller-provided parameters (database, schema, role)
    2. Environment variables (SNOWFLAKE_DATABASE, SNOWFLAKE_SCHEMA, SNOWFLAKE_ROLE)
    3. Dynamic discovery from role grants

    Returns:
        Tuple of (IdentityContext, list of table descriptors).
        Table descriptor: {"name": "DB.SCHEMA.TABLE", "columns": [...]}
    """
    effective_role = role or os.getenv("SNOWFLAKE_ROLE", "")
    effective_db = database or os.getenv("SNOWFLAKE_DATABASE", "")
    effective_schema = schema or os.getenv("SNOWFLAKE_SCHEMA", "")

    if effective_role:
        result = execute_query(token, f"USE ROLE {effective_role}", authenticator)
        if "error" in result:
            logger.warning(f"[INTROSPECT] USE ROLE {effective_role} failed: {result['error']}")

    identity = discover_identity(token, authenticator)

    target_schemas = _resolve_target_schemas(identity, effective_db, effective_schema)

    if not target_schemas:
        logger.warning("[INTROSPECT] No target schemas resolved — no tables discoverable")
        return identity, []

    tables = _enumerate_tables(token, target_schemas, authenticator)
    logger.info(f"[INTROSPECT] Discovered {len(tables)} tables across {len(target_schemas)} schemas")
    return identity, tables


def _resolve_target_schemas(
    identity: IdentityContext,
    database: str,
    schema: str,
) -> list[str]:
    """Resolve which schemas to enumerate.

    Returns fully-qualified schema references as "DB.SCHEMA" strings.
    """
    if database and schema:
        return [f"{database}.{schema}"]

    if database:
        return [f"{database}.{s}" for s in _schemas_in_db(identity, database)]

    # Fall back to grant-based discovery
    if identity.granted_schemas:
        return identity.granted_schemas

    if identity.granted_databases:
        schemas = []
        for db in identity.granted_databases:
            schemas.extend(f"{db}.{s}" for s in _schemas_in_db(identity, db))
        return schemas

    return []


def _schemas_in_db(identity: IdentityContext, database: str) -> list[str]:
    """Extract schema names for a given database from granted_schemas, or default to PUBLIC."""
    prefix = f"{database}."
    matching = [
        s.split(".", 1)[1] for s in identity.granted_schemas
        if s.upper().startswith(prefix.upper()) and s.split(".", 1)[1].upper() not in SYSTEM_SCHEMAS
    ]
    return matching if matching else ["PUBLIC"]


def discover_tables_in_schema(token: str, fq_schema: str, authenticator: str) -> list[str]:
    """List table names in a fully-qualified schema using SHOW TABLES."""
    result = execute_query(token, f"SHOW TABLES IN SCHEMA {fq_schema}", authenticator)
    if "error" in result:
        logger.warning(f"[INTROSPECT] SHOW TABLES IN {fq_schema} failed: {result['error']}")
        return []

    columns = [c.upper() for c in result.get("columns", [])]
    name_idx = None
    for i, col in enumerate(columns):
        if col == "NAME":
            name_idx = i
            break

    if name_idx is None:
        name_idx = 1  # SHOW TABLES typically has name in position 1

    return [row[name_idx] for row in result.get("rows", []) if row[name_idx]]


def _enumerate_tables(token: str, target_schemas: list[str], authenticator: str) -> list[dict]:
    """Enumerate tables and their columns across target schemas, capped at MAX_TABLES."""
    tables: list[dict] = []

    for fq_schema in target_schemas:
        if len(tables) >= MAX_TABLES:
            break

        parts = fq_schema.split(".", 1)
        if len(parts) != 2:
            continue
        db, schema_name = parts

        table_names = discover_tables_in_schema(token, fq_schema, authenticator)

        for table in table_names:
            if len(tables) >= MAX_TABLES:
                break

            fqn = f"{db}.{schema_name}.{table}"
            cols_result = execute_query(
                token,
                f"SELECT COLUMN_NAME, DATA_TYPE, COMMENT "
                f"FROM {db}.INFORMATION_SCHEMA.COLUMNS "
                f"WHERE TABLE_SCHEMA = '{schema_name}' AND TABLE_NAME = '{table}' "
                f"ORDER BY ORDINAL_POSITION",
                authenticator,
            )

            columns = []
            if "error" not in cols_result:
                for col_row in cols_result.get("rows", []):
                    columns.append({
                        "name": col_row[0],
                        "type": col_row[1],
                        "comment": col_row[2] if len(col_row) > 2 else None,
                    })

            tables.append({"name": fqn, "columns": columns})

    return tables


def format_schema_for_llm(schema: list[dict]) -> str:
    """Format discovered schema as a concise string for the LLM context."""
    if not schema:
        return "No tables accessible with current credentials."

    lines = []
    for table in schema:
        col_defs = ", ".join(
            f"{c['name']} ({c['type']})" for c in table["columns"]
        )
        lines.append(f"- {table['name']}: [{col_defs}]")

    return "Available tables:\n" + "\n".join(lines)
