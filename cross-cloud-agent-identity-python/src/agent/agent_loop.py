"""LLM agent loop for Snowflake query resolution.

Given a Snowflake connection token and a natural-language query, this module:
1. Discovers identity and accessible schema (identity-first)
2. Determines if the query can be answered with available data
3. Generates and executes SQL if a match is found
4. Returns structured diagnostics (including identity context) if no match

Uses Claude via the Anthropic SDK with a Keycard-brokered API key.
"""

from __future__ import annotations

import json
import logging
import os

from anthropic import AsyncAnthropic

from .snowflake.connection import execute_query
from .snowflake.introspect import discover_schema, format_schema_for_llm
from .tokens.bootstrap import get_api_key_async
from .result import Error, Result

logger = logging.getLogger(__name__)

SYSTEM_PROMPT = """You are a data analyst agent with access to a Snowflake database.
Your job is to answer natural-language questions by querying Snowflake.

You will be given:
1. The user's question
2. Your Snowflake identity context (user, role, accessible resources)
3. A schema of available tables and their columns

Your task:
- Determine if the question can be answered and generate the appropriate SQL
- If YES: return JSON: {"can_answer": true, "sql": "<SQL>", "explanation": "..."}
- If NO: explain why not, return as JSON: {"can_answer": false, "reason": "...", "available_tables": [...], "suggestion": "..."}

Rules:
- Respond with ONLY raw JSON — no markdown fences, no extra text
- For data queries, use SELECT with fully qualified table/column names from the schema
- For metadata queries (warehouses, roles, users, grants, databases, schemas, integrations), use SHOW or DESCRIBE commands
- You may use any SQL statement the connected identity has permission to execute — the identity's role controls the blast radius
- Be precise with table and column names (use fully qualified names for data queries)
- If the question is ambiguous, pick the most likely interpretation
"""


async def run_agent_loop(
    token: str,
    query: str,
    database: str | None = None,
    schema: str | None = None,
    role: str | None = None,
    authenticator: str = "WORKLOAD_IDENTITY",
) -> Result:
    """Run the agent loop: discover identity/schema, determine answerability, execute."""
    try:
        api_key = await get_api_key_async()
    except RuntimeError as e:
        return Result.failure(Error.INTERNAL, str(e))

    logger.info(f"[AGENT_LOOP] Starting for query: {query[:100]}")

    identity, tables = discover_schema(
        token, database=database, schema=schema, role=role, authenticator=authenticator
    )
    schema_text = format_schema_for_llm(tables)

    client = AsyncAnthropic(api_key=api_key)
    model = os.getenv("ANTHROPIC_MODEL", "claude-sonnet-4-20250514")

    identity_text = identity.summary()
    user_message = (
        f"Question: {query}\n\n"
        f"Identity Context:\n{identity_text}\n\n"
        f"Database Schema:\n{schema_text}"
    )

    try:
        message = await client.messages.create(
            model=model,
            max_tokens=1024,
            system=SYSTEM_PROMPT,
            messages=[{"role": "user", "content": user_message}],
            temperature=0,
        )

        content = message.content[0].text if message.content else ""
        if not content:
            return Result.failure(Error.INTERNAL, "LLM returned empty response")

        decision = json.loads(_extract_json(content))

    except Exception as e:
        logger.error(f"[AGENT_LOOP] LLM call failed: {type(e).__name__}: {e}")
        return Result.failure(Error.INTERNAL, f"Agent reasoning failed: {e}")

    if not decision.get("can_answer"):
        return Result.failure(
            Error.NO_MATCHING_DATA,
            decision.get("reason", "Cannot answer this question with available data"),
            details={
                "available_tables": [t["name"] for t in tables],
                "suggestion": decision.get("suggestion", "Try rephrasing or check access policies"),
                "identity": {"user": identity.user, "role": identity.active_role},
            },
        )

    sql = decision.get("sql", "")
    if not sql:
        return Result.failure(Error.INTERNAL, "Agent produced no SQL query")

    logger.info(f"[AGENT_LOOP] Executing SQL: {sql[:200]}")
    query_result = execute_query(token, sql, authenticator)

    if "error" in query_result:
        return Result.failure(
            Error.SNOWFLAKE,
            query_result["error"],
            details={"sql": sql, "explanation": decision.get("explanation", "")},
        )

    columns = query_result.get("columns", [])
    rows = query_result.get("rows", [])

    if not rows:
        return Result.success(json.dumps({
            "answer": "Query returned no results.",
            "sql": sql,
            "explanation": decision.get("explanation", ""),
        }))

    result_data = {
        "answer": _format_results(columns, rows),
        "sql": sql,
        "explanation": decision.get("explanation", ""),
        "row_count": len(rows),
    }

    return Result.success(json.dumps(result_data))


def _extract_json(text: str) -> str:
    """Strip markdown code fences if the model wrapped its JSON response."""
    stripped = text.strip()
    if stripped.startswith("```"):
        lines = stripped.split("\n")
        lines = lines[1:]
        if lines and lines[-1].strip() == "```":
            lines = lines[:-1]
        return "\n".join(lines)
    return stripped


def _format_results(columns: list[str], rows: list[list]) -> str:
    """Format query results as a readable table."""
    lines = [" | ".join(columns), "-" * (len(" | ".join(columns)))]
    for row in rows[:50]:
        lines.append(" | ".join(str(v) for v in row))
    if len(rows) > 50:
        lines.append(f"... and {len(rows) - 50} more rows")
    return "\n".join(lines)
