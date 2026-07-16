"""On-demand authorization-code flow for Databricks scope-resources.

This is the server-driven "native client" pattern. When a tool's RFC 8693 token
exchange fails because the user has no delegated grant for a Databricks resource,
the tool returns an `authorization_required` error pointing at the `authorize`
tool. `authorize` mints a Keycard `/authorize` link (authorization code + PKCE,
RFC 8707 `resource` param) for a single resource and returns it. The user opens
the link, signs in, and approves; Keycard stores the delegated `(user, resource)`
grant and redirects to this server's `/oauth/callback`, which completes the code
exchange. The user's next tool call then exchanges successfully via `@grant`.

The OAuth client used here is the agent's *own confidential client* — the same
`KEYCARD_CLIENT_ID` / `KEYCARD_CLIENT_SECRET` that `keycard run` brokers into the
environment and that `@grant` already uses. No dynamic client registration and no
separate public client are created.

The whole flow is gated by `ENABLE_AUTHORIZATION_FLOW` (see `scope.py`); when the
flag is off this module's tool and route are not registered and tool errors stay
as before.

Note: the pending-state store is in-process, keyed by the CSRF `state` value. It
supports concurrent users but is not shared across processes — fine for the
single-process demo server.
"""

from __future__ import annotations

import asyncio
import logging
import os
import secrets

from fastmcp import Context, FastMCP
from starlette.requests import Request
from starlette.responses import HTMLResponse

from keycardai.fastmcp import AccessContext, AuthProvider
from keycardai.oauth import AsyncClient, ClientConfig, build_authorize_url
from keycardai.oauth.utils.pkce import PKCEGenerator

from .scope import (
    DATABRICKS_GENIE_RESOURCE,
    DATABRICKS_HOST,
    DATABRICKS_SQL_RESOURCE,
    authorization_flow_enabled,
)

logger = logging.getLogger("databricks-agent")

KEYCARD_URL = os.environ.get("KEYCARD_URL")
# Single source of truth for the server's own base URL (same default as main.py).
MCP_SERVER_URL = os.environ.get("MCP_SERVER_URL", "http://localhost:8000/")
CLIENT_ID = os.environ.get("KEYCARD_CLIENT_ID")

# Path the FastMCP server hosts to receive the authorization-code redirect, and
# the absolute URL the authorize request advertises as `redirect_uri`. The URL is
# fixed (the server runs on a known port), so a single exact-match redirect URI
# registered on the application is enough.
CALLBACK_PATH = "/oauth/callback"
CALLBACK_URL = f"{MCP_SERVER_URL.rstrip('/')}{CALLBACK_PATH}"

# The Databricks scope-resources a caller may authorize, one per `authorize` call.
DATABRICKS_RESOURCES = {
    DATABRICKS_HOST,
    DATABRICKS_SQL_RESOURCE,
    DATABRICKS_GENIE_RESOURCE,
}

# state -> (code_verifier, resource) for in-flight authorization-code flows.
_PENDING: dict[str, tuple[str, str]] = {}

# Errors STS returns when access needs (re)authorization: no delegated grant,
# consent required, or a delegation/consent policy denied the exchange.
_AUTHZ_REQUIRED_CODES = (
    "insufficient_authorization",
    "interaction_required",
    "access_denied",
)


def authorization_required_error(
    resource: str,
    code: str | None = None,
    description: str | None = None,
) -> dict:
    """Build the structured error that points the caller at the authorize tool.

    The payload is machine-actionable: `next_step` tells an agent exactly which
    tool to call with which arguments, so it can route to `authorize`
    automatically instead of stopping. The upstream OAuth `code`/`description`
    are included for transparency when present.
    """
    err: dict = {
        "error": "authorization_required",
        "resource": resource,
        "next_step": {"tool": "authorize", "arguments": {"resource": resource}},
        "action_required": (
            f'Access to "{resource}" is not authorized yet. Call the `authorize` '
            f'tool with resource="{resource}", give the returned link to the user '
            "to approve, then retry this tool."
        ),
    }
    if code:
        err["upstream_code"] = code
    if description:
        err["upstream_description"] = description
    return err


async def databricks_token(ctx: Context, resource: str) -> tuple[str | None, dict | None]:
    """Read the brokered Databricks token for `resource` from the access context.

    Returns (token, error). Exactly one is non-None. When the on-demand
    authorization flow is enabled and the token exchange failed because the user
    has no delegated grant yet, the error is an `authorization_required` payload
    instead of the raw token-exchange error.
    """
    access_context: AccessContext = await ctx.get_state("keycardai")
    if access_context.has_errors():
        err = access_context.get_resource_error(resource) or access_context.get_error() or {}
        if authorization_flow_enabled() and err.get("code") in _AUTHZ_REQUIRED_CODES:
            return None, authorization_required_error(
                resource,
                code=err.get("code"),
                description=err.get("description"),
            )
        return None, {
            "error": "Token exchange failed",
            "details": access_context.get_errors(),
        }
    return access_context.access(resource).access_token, None


_client: AsyncClient | None = None
_client_lock = asyncio.Lock()


async def _get_client(auth_provider: AuthProvider) -> AsyncClient:
    """Lazily create the confidential-client AsyncClient used to drive authorize.

    Reuses the auth strategy (BasicAuth) derived from the agent's existing
    application credential, so the authorize flow runs as the same confidential
    client identity that `@grant` already uses. Metadata discovery is enabled to
    resolve the `/authorize` and `/token` endpoints; no client registration.
    """
    global _client
    if _client is not None:
        return _client
    async with _client_lock:
        if _client is None:
            _client = AsyncClient(
                issuer=auth_provider.zone_url,
                auth=auth_provider.auth,
                config=ClientConfig(
                    enable_metadata_discovery=True,
                    auto_register_client=False,
                ),
            )
            await _client._get_current_endpoints()
    return _client


def register_authorization_flow(mcp: FastMCP, auth_provider: AuthProvider) -> None:
    """Register the `authorize` tool and `/oauth/callback` route.

    No-op unless `ENABLE_AUTHORIZATION_FLOW` is set, so the server behaves exactly
    as before when the flag is off.
    """
    if not authorization_flow_enabled():
        return

    @mcp.tool()
    async def authorize(ctx: Context, resource: str) -> dict:
        """Mint a Keycard authorization link for a single Databricks resource.

        Call this when a tool returns `authorization_required`. Pass the exact
        `resource` from that error. Open the returned `authorization_url` in a
        browser, sign in, and approve access; then retry the original tool.

        Args:
            resource: The Databricks scope-resource to authorize, e.g.
                `{DATABRICKS_HOST}`, `{DATABRICKS_HOST}/sql`, or
                `{DATABRICKS_HOST}/genie`.
        """
        if resource not in DATABRICKS_RESOURCES:
            return {
                "error": "unknown_resource",
                "resource": resource,
                "valid_resources": sorted(DATABRICKS_RESOURCES),
            }
        if not CLIENT_ID:
            return {
                "error": "missing_client_id",
                "details": (
                    "KEYCARD_CLIENT_ID is not set. Start the server via "
                    "`keycard run` so the application credentials are brokered "
                    "into the environment."
                ),
            }

        client = await _get_client(auth_provider)
        endpoints = await client._get_current_endpoints()
        if not endpoints.authorize:
            return {
                "error": "authorize_endpoint_unavailable",
                "details": "Keycard zone metadata did not advertise an authorization endpoint.",
            }

        pkce = PKCEGenerator().generate_pkce_pair()
        state = secrets.token_urlsafe(32)
        url = build_authorize_url(
            endpoints.authorize,
            client_id=CLIENT_ID,
            redirect_uri=CALLBACK_URL,
            pkce=pkce,
            resources=[resource],
            state=state,
        )
        _PENDING[state] = (pkce.code_verifier, resource)
        logger.debug("Authorization link minted for resource %s", resource)
        return {
            "action": "authorize",
            "resource": resource,
            "authorization_url": url,
            "instructions": (
                "Open this URL in your browser, sign in, and approve access. "
                "Then retry the tool that returned authorization_required."
            ),
        }

    @mcp.custom_route(CALLBACK_PATH, methods=["GET"])
    async def oauth_callback(request: Request) -> HTMLResponse:
        """Receive the authorization-code redirect and complete the code exchange.

        The delegated grant is created by Keycard during `/authorize`, so the
        code exchange here is confirmatory: it validates the flow and surfaces
        any error before the user retries the tool.
        """
        params = request.query_params
        error = params.get("error")
        if error:
            description = params.get("error_description", "")
            return _callback_page(
                "Authorization failed",
                f"{error}: {description}" if description else error,
                is_error=True,
                status_code=400,
            )

        state = params.get("state")
        code = params.get("code")
        if not state or not code:
            return _callback_page(
                "Authorization failed",
                "The callback was missing the code or state parameter.",
                is_error=True,
                status_code=400,
            )

        pending = _PENDING.pop(state, None)
        if pending is None:
            return _callback_page(
                "Authorization failed",
                "Unknown or expired authorization request (state mismatch).",
                is_error=True,
                status_code=400,
            )

        code_verifier, resource = pending
        try:
            client = await _get_client(auth_provider)
            await client.exchange_authorization_code(
                code=code,
                redirect_uri=CALLBACK_URL,
                code_verifier=code_verifier,
                client_id=CLIENT_ID,
            )
        except Exception as exc:  # noqa: BLE001 - surfaced to the browser only
            logger.error("Authorization code exchange failed for %s", resource)
            return _callback_page(
                "Authorization failed",
                f"Could not complete the authorization for {resource}: {exc}",
                is_error=True,
                status_code=500,
            )

        logger.debug("Authorization completed for resource %s", resource)
        return _callback_page(
            "Authorization successful",
            f"Access to {resource} is authorized. You can close this tab and "
            "retry the tool.",
        )


def _callback_page(
    title: str,
    message: str,
    *,
    is_error: bool = False,
    status_code: int = 200,
) -> HTMLResponse:
    """Render a minimal HTML page for the OAuth callback result."""
    color = "#b00020" if is_error else "#0a7d33"
    html = f"""<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>{title}</title>
    <meta name="viewport" content="width=device-width, initial-scale=1" />
  </head>
  <body style="font-family: system-ui, sans-serif; max-width: 32rem; margin: 4rem auto; padding: 0 1rem;">
    <h1 style="color: {color};">{title}</h1>
    <p>{message}</p>
  </body>
</html>"""
    return HTMLResponse(content=html, status_code=status_code)
