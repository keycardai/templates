"""Platform identity detection: auto-detect Vercel or Fly.io runtime.

Vercel: OIDC token arrives on each request via x-vercel-oidc-token header.
Fly.io: OIDC token fetched from Fly's Machine API via Unix socket at /.fly/api.
Local dev: Handled in exchange.py via KEYCARD_CLIENT_ID/KEYCARD_CLIENT_SECRET
           (injected by `keycard run`). This module is not called for local auth.
"""

from __future__ import annotations

import logging
import os
from contextvars import ContextVar

import httpx
from starlette.types import ASGIApp, Receive, Scope, Send

logger = logging.getLogger(__name__)

vercel_oidc_token: ContextVar[str] = ContextVar("vercel_oidc_token", default="")

FLY_API_SOCKET = "/.fly/api"


class VercelOIDCMiddleware:
    """Starlette middleware that captures Vercel OIDC tokens into ContextVar."""

    def __init__(self, app: ASGIApp):
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] in ("http", "websocket"):
            headers = dict(scope.get("headers", []))
            token = headers.get(b"x-vercel-oidc-token", b"").decode()
            if token:
                vercel_oidc_token.set(token)
        await self.app(scope, receive, send)


def is_vercel() -> bool:
    return bool(os.getenv("VERCEL"))


def is_fly() -> bool:
    return bool(os.getenv("FLY_APP_NAME"))


async def get_vercel_assertion() -> str:
    """Return the Vercel-issued OIDC token from the current request context."""
    token = vercel_oidc_token.get()
    if not token:
        raise RuntimeError(
            "No Vercel OIDC token in context. "
            "Ensure x-vercel-oidc-token header is present."
        )
    return token


async def get_fly_assertion() -> str:
    """Fetch an OIDC token from Fly's Machine API via Unix socket.

    On Fly Machines, a Unix socket at /.fly/api exposes the local machine
    API. POST /v1/tokens/oidc with {"aud": "<audience>"} returns a signed
    OIDC JWT. No secrets needed — identity is derived from the machine.
    """
    zone_url = os.getenv("KEYCARD_ZONE_URL", "")
    if not zone_url:
        raise RuntimeError("KEYCARD_ZONE_URL must be set for Fly OIDC token requests")

    logger.info(f"[PLATFORM] Fetching Fly OIDC token via {FLY_API_SOCKET} (aud={zone_url})")

    try:
        transport = httpx.AsyncHTTPTransport(uds=FLY_API_SOCKET)
        async with httpx.AsyncClient(transport=transport, timeout=10.0) as client:
            resp = await client.post(
                "http://localhost/v1/tokens/oidc",
                json={"aud": zone_url},
            )
    except (httpx.ConnectError, OSError) as e:
        raise RuntimeError(
            f"Cannot reach Fly API socket at {FLY_API_SOCKET}. "
            f"Ensure this is running on a Fly Machine: {e}"
        ) from e

    if resp.status_code != 200:
        raise RuntimeError(
            f"Fly OIDC token request failed: {resp.status_code} {resp.text}. "
            f"Socket: {FLY_API_SOCKET}"
        )

    token = resp.text.strip()
    if not token:
        raise RuntimeError("Fly OIDC token response is empty")

    logger.info("[PLATFORM] Fly OIDC token obtained successfully")
    return token


async def get_client_assertion() -> str:
    """Auto-detect platform and return the appropriate OIDC assertion.

    Priority:
    1. Vercel — request-scoped OIDC token from x-vercel-oidc-token header
    2. Fly.io — OIDC token from Machine API Unix socket (/.fly/api)

    This function is only called when KEYCARD_CLIENT_ID/SECRET are not set
    (i.e. not running under `keycard run` locally). If neither platform is
    detected, raises RuntimeError.
    """
    token = vercel_oidc_token.get()
    if token:
        return token

    if is_fly():
        return await get_fly_assertion()

    raise RuntimeError(
        "No platform identity available and no KEYCARD_CLIENT_ID/SECRET set. "
        "Run locally with `keycard run` to inject credentials, or deploy to "
        "Vercel/Fly.io for automatic platform identity."
    )
