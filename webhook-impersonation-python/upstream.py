"""Linear MCP client with Keycard impersonation token exchange.

Uses the async OAuth client to impersonate a user, then calls Linear's
MCP server to create an issue on their behalf.
"""

import json
import logging
from uuid import UUID

import httpx
from mcp import ClientSession
from mcp.client.streamable_http import streamable_http_client

from config import SERVER_NAME, settings
from keycardai.oauth import AsyncClient, BasicAuth, ClientConfig
from keycardai.oauth.exceptions import OAuthProtocolError

logger = logging.getLogger(SERVER_NAME)

LINEAR_MCP_URL = settings.linear_mcp_url


async def impersonate_user_token(user_identifier: str, resource: str) -> str:
    """Exchange Keycard client credentials for an impersonation access token.

    Returns the access token string for *user_identifier* scoped to *resource*.

    Raises:
        PermissionError: Keycard denied the impersonation (no grant or policy).
        RuntimeError: Token exchange failed for any other protocol reason.
    """
    try:
        async with AsyncClient(
            base_url=settings.keycard_url,
            auth=BasicAuth(settings.keycard_client_id, settings.keycard_client_secret),
            config=ClientConfig(
                enable_metadata_discovery=True,
                auto_register_client=False,
            ),
        ) as kc:
            token_resp = await kc.impersonate(
                user_identifier=user_identifier,
                resource=resource,
            )
    except OAuthProtocolError as exc:
        if exc.error == "access_denied":
            raise PermissionError(
                f"Impersonation denied for {user_identifier}. "
                f"Ensure the user has run `keycard auth resource {resource}` "
                f"and the Cedar policy permits impersonation."
            ) from exc
        raise RuntimeError(f"Token exchange failed: {exc.error} — {exc.error_description}") from exc

    return token_resp.access_token


def _is_uuid(value: str) -> bool:
    try:
        UUID(value)
    except (ValueError, AttributeError, TypeError):
        return False
    return True


def _extract_text(content_list) -> str:
    return "\n".join(c.text for c in (content_list or []) if hasattr(c, "text") and c.text)


async def _resolve_team_id(session: ClientSession, team: str) -> str:
    """Resolve a Linear team name to its UUID via the MCP `list_teams` tool.

    Accepts a UUID and returns it unchanged. For names, performs a case-insensitive
    exact match against `list_teams` results. Raises RuntimeError with a
    user-actionable message when no match or multiple matches are found.
    """
    if _is_uuid(team):
        return team

    result = await session.call_tool("list_teams", {})
    if result.isError:
        raise RuntimeError(f"Linear list_teams failed: {_extract_text(result.content)}")

    teams: list[dict] = []
    for content in result.content or []:
        text = getattr(content, "text", None)
        if not text:
            continue
        try:
            parsed = json.loads(text)
        except json.JSONDecodeError:
            continue
        if isinstance(parsed, list):
            teams.extend(t for t in parsed if isinstance(t, dict))
        elif isinstance(parsed, dict):
            for key in ("teams", "items", "nodes", "data"):
                value = parsed.get(key)
                if isinstance(value, list):
                    teams.extend(t for t in value if isinstance(t, dict))
                    break
            else:
                if "id" in parsed and "name" in parsed:
                    teams.append(parsed)

    needle = team.casefold()
    exact = [t for t in teams if str(t.get("name", "")).casefold() == needle]
    if len(exact) == 1:
        return str(exact[0]["id"])
    if len(exact) > 1:
        raise RuntimeError(
            f"Team name {team!r} is ambiguous in Linear ({len(exact)} matches). "
            f"Pass the team's UUID instead."
        )
    if not teams:
        raise RuntimeError(
            f"Team {team!r} not found in Linear. "
            f"Check the name in Linear → Settings → Teams, or pass the team's UUID."
        )
    available = ", ".join(sorted({str(t.get("name", "?")) for t in teams}))
    raise RuntimeError(
        f"Team {team!r} not found in Linear. "
        f"Closest matches: {available}. Pass the exact name or the team's UUID."
    )


async def create_linear_issue_for_user(
    *,
    user_identifier: str,
    title: str,
    team: str,
    description: str = "",
) -> str:
    """Impersonate *user_identifier* and create a Linear issue via MCP.

    *team* may be a Linear team name (resolved via `list_teams`) or a team UUID.

    Returns the issue identifier extracted from the tool-call response.

    Raises:
        PermissionError: Keycard denied the impersonation (no grant or policy).
        RuntimeError: Upstream MCP call failed (including team resolution errors).
    """
    access_token = await impersonate_user_token(
        user_identifier=user_identifier,
        resource=LINEAR_MCP_URL,
    )

    logger.info("impersonating %s → calling Linear save_issue", user_identifier)

    result = None
    captured_error: BaseException | None = None

    async with httpx.AsyncClient(
        headers={"Authorization": f"Bearer {access_token}"},
        timeout=30.0,
    ) as http:
        async with streamable_http_client(LINEAR_MCP_URL, http_client=http) as (read, write, _):
            async with ClientSession(read, write) as session:
                try:
                    await session.initialize()

                    team_id = await _resolve_team_id(session, team)
                    logger.info("resolved team %r → %s", team, team_id)

                    arguments: dict = {
                        "team": team_id,
                        "title": title,
                        "description": description,
                    }
                    result = await session.call_tool("save_issue", arguments)
                except BaseException as exc:
                    captured_error = exc

    if captured_error is not None:
        if isinstance(captured_error, (PermissionError, RuntimeError)):
            raise captured_error
        raise RuntimeError(f"Linear MCP call failed: {captured_error}") from captured_error
    if result is None or result.isError:
        detail = _extract_text(result.content) if result else "no response"
        raise RuntimeError(f"Linear save_issue failed: {detail}")

    text = _extract_text(result.content)
    return text or "created (no id returned)"
