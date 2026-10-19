"""Snowflake identity discovery: "who am I and what can I access?"

Queries session-level identity functions and role grants to understand
the agent's capabilities before enumerating schemas. Works immediately
after WIF auth with no pre-set database/schema context.
"""

from __future__ import annotations

import json
import logging
from dataclasses import dataclass, field

from .connection import execute_query

logger = logging.getLogger(__name__)

SYSTEM_DATABASES = frozenset({"SNOWFLAKE", "SNOWFLAKE_SAMPLE_DATA"})
SYSTEM_SCHEMAS = frozenset({"INFORMATION_SCHEMA"})


@dataclass
class IdentityContext:
    """Resolved Snowflake identity and accessible resources."""

    user: str = ""
    active_role: str = ""
    available_roles: list[str] = field(default_factory=list)
    warehouse: str = ""
    granted_databases: list[str] = field(default_factory=list)
    granted_schemas: list[str] = field(default_factory=list)

    def summary(self) -> str:
        """Human-readable identity summary for LLM context."""
        parts = [f"User: {self.user}", f"Role: {self.active_role}"]
        if self.warehouse:
            parts.append(f"Warehouse: {self.warehouse}")
        if self.available_roles:
            parts.append(f"Available roles: {', '.join(self.available_roles)}")
        if self.granted_databases:
            parts.append(f"Accessible databases: {', '.join(self.granted_databases)}")
        if self.granted_schemas:
            parts.append(f"Accessible schemas: {', '.join(self.granted_schemas)}")
        return "\n".join(parts)


def discover_identity(token: str, authenticator: str = "WORKLOAD_IDENTITY") -> IdentityContext:
    """Connect and discover the agent's Snowflake identity and capabilities.

    Performs three steps:
    1. Session identity (CURRENT_USER, CURRENT_ROLE, CURRENT_WAREHOUSE)
    2. Available roles (CURRENT_AVAILABLE_ROLES)
    3. Grants for active role (SHOW GRANTS TO ROLE) to find accessible databases/schemas
    """
    ctx = IdentityContext()

    session = execute_query(
        token,
        "SELECT CURRENT_USER(), CURRENT_ROLE(), CURRENT_WAREHOUSE()",
        authenticator,
    )
    if "error" not in session:
        rows = session.get("rows", [])
        if rows:
            ctx.user = rows[0][0] or ""
            ctx.active_role = rows[0][1] or ""
            ctx.warehouse = rows[0][2] or ""

    logger.info(f"[IDENTITY] user={ctx.user} role={ctx.active_role} warehouse={ctx.warehouse}")

    if not ctx.active_role:
        logger.warning("[IDENTITY] No active role — grant discovery will be skipped")
        return ctx

    roles_result = execute_query(token, "SELECT CURRENT_AVAILABLE_ROLES()", authenticator)
    if "error" not in roles_result:
        rows = roles_result.get("rows", [])
        if rows and rows[0][0]:
            raw = rows[0][0]
            if isinstance(raw, str):
                try:
                    ctx.available_roles = json.loads(raw)
                except (json.JSONDecodeError, TypeError):
                    ctx.available_roles = [raw]
            elif isinstance(raw, list):
                ctx.available_roles = raw

    grants = execute_query(token, f"SHOW GRANTS TO ROLE {ctx.active_role}", authenticator)
    if "error" not in grants:
        columns = [c.upper() for c in grants.get("columns", [])]
        priv_idx = _col_index(columns, "PRIVILEGE")
        type_idx = _col_index(columns, "GRANTED_ON")
        name_idx = _col_index(columns, "NAME")

        for row in grants.get("rows", []):
            privilege = (row[priv_idx] or "").upper() if priv_idx is not None else ""
            granted_on = (row[type_idx] or "").upper() if type_idx is not None else ""
            name = row[name_idx] or "" if name_idx is not None else ""

            if not name:
                continue

            if granted_on == "DATABASE" and privilege == "USAGE":
                if name.upper() not in SYSTEM_DATABASES:
                    ctx.granted_databases.append(name)
            elif granted_on == "SCHEMA" and privilege == "USAGE":
                schema_name = name.split(".")[-1] if "." in name else name
                if schema_name.upper() not in SYSTEM_SCHEMAS:
                    ctx.granted_schemas.append(name)

    logger.info(
        f"[IDENTITY] databases={ctx.granted_databases} schemas={ctx.granted_schemas}"
    )
    return ctx


def _col_index(columns: list[str], name: str) -> int | None:
    """Find column index by name, case-insensitive."""
    target = name.upper()
    for i, col in enumerate(columns):
        if col == target:
            return i
    return None
