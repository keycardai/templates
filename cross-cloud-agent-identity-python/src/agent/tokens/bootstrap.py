"""Bootstrap: obtain Anthropic API key from Keycard on startup.

Uses the agent-identity flow (client_credentials grant) to fetch an
Anthropic API key from Keycard. Works on all platforms:
- Fly: uses platform OIDC assertion via /.fly/api socket
- Vercel: lazy bootstrap on first request (OIDC token not available at startup)
- Local dev (keycard run): uses KEYCARD_CLIENT_ID/KEYCARD_CLIENT_SECRET

The key is cached for reuse across tool invocations.
"""

from __future__ import annotations

import logging
import os

from .exchange import client_credentials_grant
from .platform import get_client_assertion

logger = logging.getLogger(__name__)

_api_key: str | None = None


async def bootstrap_api_key() -> None:
    """Fetch Anthropic API key via agent-identity and cache it.

    Gates on KEYCARD_ZONE_URL — if set, attempts the exchange (works on Fly
    and under `keycard run` locally). On Vercel, this may fail at startup
    since the OIDC token is only available per-request; the lazy fallback
    in get_api_key_async() handles that case.
    """
    global _api_key

    zone_url = os.getenv("KEYCARD_ZONE_URL", "")
    resource = os.getenv("ANTHROPIC_RESOURCE", "https://api.anthropic.com")

    if not zone_url:
        _api_key = os.getenv("ANTHROPIC_API_KEY")
        if _api_key:
            logger.info("[BOOTSTRAP] Using ANTHROPIC_API_KEY from environment (no KEYCARD_ZONE_URL)")
        else:
            logger.warning("[BOOTSTRAP] No KEYCARD_ZONE_URL and no ANTHROPIC_API_KEY set")
        return

    logger.info(f"[BOOTSTRAP] Fetching API key via agent-identity for resource={resource}")

    result = await client_credentials_grant(
        zone_url=zone_url,
        resource=resource,
        get_client_assertion=get_client_assertion,
    )

    if result.ok:
        _api_key = result.data
        logger.info("[BOOTSTRAP] API key obtained successfully")
    else:
        logger.warning(f"[BOOTSTRAP] Eager bootstrap failed: {result.message}")
        _api_key = os.getenv("ANTHROPIC_API_KEY")
        if _api_key:
            logger.info("[BOOTSTRAP] Falling back to ANTHROPIC_API_KEY from environment")


async def get_api_key_async() -> str:
    """Return cached API key, or attempt lazy bootstrap if eager failed.

    On Vercel, the OIDC token is only available per-request (not at startup).
    This lazy path retries the exchange when called from a request context.
    """
    global _api_key
    if _api_key:
        return _api_key

    zone_url = os.getenv("KEYCARD_ZONE_URL", "")
    resource = os.getenv("ANTHROPIC_RESOURCE", "https://api.anthropic.com")

    if zone_url:
        result = await client_credentials_grant(
            zone_url=zone_url,
            resource=resource,
            get_client_assertion=get_client_assertion,
        )
        if result.ok:
            _api_key = result.data
            logger.info("[BOOTSTRAP] Lazy bootstrap: API key obtained on first request")
            return result.data
        logger.error(f"[BOOTSTRAP] Lazy bootstrap failed: {result.message}")

    raise RuntimeError(
        "Anthropic API key not available. Bootstrap failed and "
        "ANTHROPIC_API_KEY is not set."
    )
