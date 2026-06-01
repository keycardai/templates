"""Databricks Genie tools — Keycard-brokered credentials.

Genie's Conversation API is asynchronous: start (or continue) a conversation,
poll the message until its `status` is `COMPLETED`, then fetch the SQL result
behind an answer's attachment. Each tool exchanges the caller's Keycard token
for a Databricks-scoped OAuth token via `@auth_provider.grant` and is gated by
its own scope via `@require_scope`.
"""

import os

import httpx
from fastmcp import Context, FastMCP

from keycardai.fastmcp import AccessContext, AuthProvider

from .scope import (
    SCOPE_GENIE_CONVERSE,
    SCOPE_GENIE_READ,
    SCOPE_GENIE_SPACES_READ,
    require_scope,
)

DATABRICKS_HOST = os.environ.get(
    "DATABRICKS_HOST", "https://<your-workspace>.cloud.databricks.com"
).rstrip("/")

# Default Genie space for conversation tools when the caller omits one.
DEFAULT_GENIE_SPACE_ID = os.environ.get("DATABRICKS_GENIE_SPACE_ID", "")


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


def _resolve_space(space_id: str | None) -> tuple[str | None, dict | None]:
    resolved = space_id or DEFAULT_GENIE_SPACE_ID
    if not resolved:
        return None, {
            "error": "missing_space_id",
            "details": (
                "Provide space_id or set DATABRICKS_GENIE_SPACE_ID. "
                "Use list_genie_spaces to discover available IDs."
            ),
        }
    return resolved, None


def register_genie_tools(mcp: FastMCP, auth_provider: AuthProvider) -> None:
    """Register the Genie tools on the MCP server."""

    @mcp.tool()
    @require_scope(SCOPE_GENIE_SPACES_READ)
    @auth_provider.grant(DATABRICKS_HOST)
    async def list_genie_spaces(ctx: Context) -> dict:
        """List the Genie spaces available in the Databricks workspace.

        Calls GET {DATABRICKS_HOST}/api/2.0/genie/spaces.
        Requires scope: databricks:genie:spaces:read
        """
        token, error = await _databricks_token(ctx)
        if error:
            return error

        async with httpx.AsyncClient(timeout=30.0) as client:
            resp = await client.get(
                f"{DATABRICKS_HOST}/api/2.0/genie/spaces",
                headers={"Authorization": f"Bearer {token}"},
            )
            if resp.status_code != 200:
                return {
                    "error": f"Databricks API error: {resp.status_code}",
                    "details": resp.text,
                }
            return resp.json()

    @mcp.tool()
    @require_scope(SCOPE_GENIE_CONVERSE)
    @auth_provider.grant(DATABRICKS_HOST)
    async def start_genie_conversation(
        ctx: Context,
        content: str,
        space_id: str | None = None,
    ) -> dict:
        """Start a Genie conversation by asking a natural-language question.

        Calls POST {DATABRICKS_HOST}/api/2.0/genie/spaces/{space_id}/start-conversation.
        Returns `conversation_id` and `message_id`; the response is generated
        asynchronously, so poll with `get_genie_message` until COMPLETED.
        Requires scope: databricks:genie:converse

        Args:
            content: The natural-language question to ask Genie.
            space_id: Genie space to use (defaults to DATABRICKS_GENIE_SPACE_ID).
        """
        token, error = await _databricks_token(ctx)
        if error:
            return error
        space, space_error = _resolve_space(space_id)
        if space_error:
            return space_error

        async with httpx.AsyncClient(timeout=60.0) as client:
            resp = await client.post(
                f"{DATABRICKS_HOST}/api/2.0/genie/spaces/{space}/start-conversation",
                headers={"Authorization": f"Bearer {token}"},
                json={"content": content},
            )
            if resp.status_code != 200:
                return {
                    "error": f"Databricks API error: {resp.status_code}",
                    "details": resp.text,
                }
            return resp.json()

    @mcp.tool()
    @require_scope(SCOPE_GENIE_READ)
    @auth_provider.grant(DATABRICKS_HOST)
    async def get_genie_message(
        ctx: Context,
        conversation_id: str,
        message_id: str,
        space_id: str | None = None,
    ) -> dict:
        """Fetch a Genie message to check its status and read the answer.

        Calls GET {DATABRICKS_HOST}/api/2.0/genie/spaces/{space_id}/conversations/
        {conversation_id}/messages/{message_id}. Poll until `status` is
        `COMPLETED`, then read `attachments` (use `get_genie_query_result` for
        the SQL result behind a query attachment).
        Requires scope: databricks:genie:read

        Args:
            conversation_id: Conversation returned by start_genie_conversation.
            message_id: Message returned by start_genie_conversation.
            space_id: Genie space to use (defaults to DATABRICKS_GENIE_SPACE_ID).
        """
        token, error = await _databricks_token(ctx)
        if error:
            return error
        space, space_error = _resolve_space(space_id)
        if space_error:
            return space_error

        async with httpx.AsyncClient(timeout=30.0) as client:
            resp = await client.get(
                f"{DATABRICKS_HOST}/api/2.0/genie/spaces/{space}"
                f"/conversations/{conversation_id}/messages/{message_id}",
                headers={"Authorization": f"Bearer {token}"},
            )
            if resp.status_code != 200:
                return {
                    "error": f"Databricks API error: {resp.status_code}",
                    "details": resp.text,
                }
            return resp.json()

    @mcp.tool()
    @require_scope(SCOPE_GENIE_READ)
    @auth_provider.grant(DATABRICKS_HOST)
    async def get_genie_query_result(
        ctx: Context,
        conversation_id: str,
        message_id: str,
        attachment_id: str,
        space_id: str | None = None,
    ) -> dict:
        """Fetch the SQL result behind a Genie answer's query attachment.

        Calls GET {DATABRICKS_HOST}/api/2.0/genie/spaces/{space_id}/conversations/
        {conversation_id}/messages/{message_id}/attachments/{attachment_id}/query-result.
        Requires scope: databricks:genie:read

        Args:
            conversation_id: Conversation returned by start_genie_conversation.
            message_id: Message that contains the query attachment.
            attachment_id: Attachment ID from the completed message's `attachments`.
            space_id: Genie space to use (defaults to DATABRICKS_GENIE_SPACE_ID).
        """
        token, error = await _databricks_token(ctx)
        if error:
            return error
        space, space_error = _resolve_space(space_id)
        if space_error:
            return space_error

        async with httpx.AsyncClient(timeout=30.0) as client:
            resp = await client.get(
                f"{DATABRICKS_HOST}/api/2.0/genie/spaces/{space}"
                f"/conversations/{conversation_id}/messages/{message_id}"
                f"/attachments/{attachment_id}/query-result",
                headers={"Authorization": f"Bearer {token}"},
            )
            if resp.status_code != 200:
                return {
                    "error": f"Databricks API error: {resp.status_code}",
                    "details": resp.text,
                }
            return resp.json()
