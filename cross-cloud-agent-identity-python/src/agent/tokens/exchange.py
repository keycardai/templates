"""Token exchange and client credentials grants against Keycard's STS.

`exchange_token` — RFC 8693 token exchange: swaps a user's bearer token for
a resource-scoped token (used for delegation).

`client_credentials_grant` — OAuth 2.0 client credentials: the agent
authenticates on its own behalf (used for agent-identity and bootstrap).

`impersonate_grant` — RFC 8693 token exchange with substitute-user semantics:
the agent acts as a specified user identity.

All three support local dev via KEYCARD_CLIENT_ID/KEYCARD_CLIENT_SECRET
(injected by `keycard run`) as a fallback when no platform OIDC assertion
is available.
"""

from __future__ import annotations

import base64
import json
import logging
import os
import re
import time
from collections.abc import Awaitable, Callable

import httpx

from ..result import Error, Result

logger = logging.getLogger(__name__)


def _parse_oauth_error(error_str: str) -> dict | None:
    details: dict = {}
    policy_set_match = re.search(r'policy[_\s]?set["\s:]+([^\s,"]+)', error_str, re.IGNORECASE)
    if policy_set_match:
        details["policy_set"] = policy_set_match.group(1)
    reason_match = re.search(r'reason["\s:]+([^"]+)"', error_str, re.IGNORECASE)
    if reason_match:
        details["reason"] = reason_match.group(1)
    return details if details else None


def _build_substitute_user_token(identifier: str) -> str:
    """Build an unsigned JWT for impersonation (vnd.kc.su+jwt).

    Keycard expects subject_token to be a JWT with header
    {"typ": "vnd.kc.su+jwt", "alg": "none"} and payload {"sub": identifier}.
    The token is intentionally unsigned — security relies on client
    authentication and prior user consent (delegated grant).
    """
    header = json.dumps({"typ": "vnd.kc.su+jwt", "alg": "none"}, separators=(",", ":"))
    payload = json.dumps({"sub": identifier}, separators=(",", ":"))
    h = base64.urlsafe_b64encode(header.encode()).decode().rstrip("=")
    p = base64.urlsafe_b64encode(payload.encode()).decode().rstrip("=")
    return f"{h}.{p}."


def _get_local_client_auth() -> tuple[str, str] | None:
    """Return (client_id, client_secret) if available for local dev, else None."""
    client_id = os.getenv("KEYCARD_CLIENT_ID")
    client_secret = os.getenv("KEYCARD_CLIENT_SECRET")
    if client_id and client_secret:
        return (client_id, client_secret)
    return None


async def exchange_token(
    zone_url: str,
    user_token: str,
    resource: str,
    get_client_assertion: Callable[[], Awaitable[str]],
    scope: str | None = None,
) -> Result:
    """RFC 8693 token exchange: swap caller's token for a resource-scoped token.

    On local dev (KEYCARD_CLIENT_ID/SECRET set via keycard run), uses
    client_secret_post instead of a platform OIDC assertion.
    """
    if not zone_url:
        return Result.failure(
            Error.KEYCARD_NOT_CONFIGURED,
            "KEYCARD_ZONE_URL not configured",
            details={"resource": resource},
        )

    token_endpoint = f"{zone_url.rstrip('/')}/oauth/2/token"
    logger.info(f"[TOKEN_EXCHANGE] START resource={resource} scope={scope}")
    t0 = time.time()

    try:
        data: dict[str, str] = {
            "grant_type": "urn:ietf:params:oauth:grant-type:token-exchange",
            "subject_token": user_token,
            "subject_token_type": "urn:ietf:params:oauth:token-type:access_token",
            "resource": resource,
        }
        if scope:
            data["scope"] = scope

        local_auth = _get_local_client_auth()
        if local_auth:
            data["client_id"] = local_auth[0]
            data["client_secret"] = local_auth[1]
        else:
            client_assertion = await get_client_assertion()
            data["client_assertion_type"] = (
                "urn:ietf:params:oauth:client-assertion-type:jwt-bearer"
            )
            data["client_assertion"] = client_assertion

        async with httpx.AsyncClient(timeout=30.0) as client:
            resp = await client.post(token_endpoint, data=data)

        elapsed = time.time() - t0

        if resp.status_code != 200:
            error_body = resp.text
            logger.error(f"[TOKEN_EXCHANGE] FAILED in {elapsed:.2f}s: {resp.status_code} {error_body}")
            details: dict = {"resource": resource}
            if scope:
                details["scope"] = scope
            policy_info = _parse_oauth_error(error_body)
            if policy_info:
                details.update(policy_info)
            return Result.failure(
                Error.KEYCARD_DENIED,
                f"Token exchange failed: {resp.status_code} {error_body}",
                details=details,
            )

        access_token = resp.json().get("access_token")
        if not access_token:
            return Result.failure(Error.INTERNAL, "Token exchange response missing access_token")

        logger.info(f"[TOKEN_EXCHANGE] SUCCESS in {elapsed:.2f}s resource={resource}")
        return Result.success(access_token)

    except Exception as e:
        elapsed = time.time() - t0
        logger.error(f"[TOKEN_EXCHANGE] FAILED in {elapsed:.2f}s: {type(e).__name__}: {e}")
        details = {"resource": resource}
        if scope:
            details["scope"] = scope
        return Result.failure(
            Error.KEYCARD_DENIED,
            f"Token exchange failed: {type(e).__name__}: {e}",
            details=details,
        )


async def client_credentials_grant(
    zone_url: str,
    resource: str,
    get_client_assertion: Callable[[], Awaitable[str]],
) -> Result:
    """Client credentials grant: agent authenticates on its own behalf.

    On local dev (KEYCARD_CLIENT_ID/SECRET set via keycard run), uses
    client_secret_post instead of a platform OIDC assertion.
    """
    if not zone_url:
        return Result.failure(
            Error.KEYCARD_NOT_CONFIGURED,
            "KEYCARD_ZONE_URL not configured",
            details={"resource": resource},
        )

    token_endpoint = f"{zone_url.rstrip('/')}/oauth/2/token"
    logger.info(f"[CLIENT_CREDS] START resource={resource}")
    t0 = time.time()

    try:
        data: dict[str, str] = {
            "grant_type": "client_credentials",
            "resource": resource,
        }

        local_auth = _get_local_client_auth()
        if local_auth:
            data["client_id"] = local_auth[0]
            data["client_secret"] = local_auth[1]
        else:
            client_assertion = await get_client_assertion()
            data["client_assertion_type"] = (
                "urn:ietf:params:oauth:client-assertion-type:jwt-bearer"
            )
            data["client_assertion"] = client_assertion

        async with httpx.AsyncClient(timeout=30.0) as client:
            resp = await client.post(token_endpoint, data=data)

        elapsed = time.time() - t0

        if resp.status_code != 200:
            error_body = resp.text
            logger.error(f"[CLIENT_CREDS] FAILED in {elapsed:.2f}s: {resp.status_code} {error_body}")
            details: dict = {"resource": resource}
            policy_info = _parse_oauth_error(error_body)
            if policy_info:
                details.update(policy_info)
            return Result.failure(
                Error.KEYCARD_DENIED,
                f"Client credentials grant failed: {resp.status_code} {error_body}",
                details=details,
            )

        access_token = resp.json().get("access_token")
        if not access_token:
            return Result.failure(Error.INTERNAL, "Client credentials response missing access_token")

        logger.info(f"[CLIENT_CREDS] SUCCESS in {elapsed:.2f}s resource={resource}")
        return Result.success(access_token)

    except Exception as e:
        elapsed = time.time() - t0
        logger.error(f"[CLIENT_CREDS] FAILED in {elapsed:.2f}s: {type(e).__name__}: {e}")
        return Result.failure(
            Error.KEYCARD_DENIED,
            f"Client credentials grant failed: {type(e).__name__}: {e}",
            details={"resource": resource},
        )


async def impersonate_grant(
    zone_url: str,
    user_identifier: str,
    resource: str,
    get_client_assertion: Callable[[], Awaitable[str]],
) -> Result:
    """Impersonation: exchange a substitute-user token for a resource-scoped token.

    The agent uses its own identity (client assertion) but requests a token
    scoped to another user (user_identifier). Requires appropriate policy.

    On local dev (KEYCARD_CLIENT_ID/SECRET set via keycard run), uses
    client_secret_post instead of a platform OIDC assertion.
    """
    if not zone_url:
        return Result.failure(
            Error.KEYCARD_NOT_CONFIGURED,
            "KEYCARD_ZONE_URL not configured",
            details={"resource": resource, "user_identifier": user_identifier},
        )

    token_endpoint = f"{zone_url.rstrip('/')}/oauth/2/token"
    logger.info(f"[IMPERSONATE] START resource={resource} user={user_identifier}")
    t0 = time.time()

    try:
        data: dict[str, str] = {
            "grant_type": "urn:ietf:params:oauth:grant-type:token-exchange",
            "subject_token": _build_substitute_user_token(user_identifier),
            "subject_token_type": "urn:keycard:params:oauth:token-type:substitute-user",
            "resource": resource,
        }

        local_auth = _get_local_client_auth()
        if local_auth:
            data["client_id"] = local_auth[0]
            data["client_secret"] = local_auth[1]
        else:
            client_assertion = await get_client_assertion()
            data["client_assertion_type"] = (
                "urn:ietf:params:oauth:client-assertion-type:jwt-bearer"
            )
            data["client_assertion"] = client_assertion

        async with httpx.AsyncClient(timeout=30.0) as client:
            resp = await client.post(token_endpoint, data=data)

        elapsed = time.time() - t0

        if resp.status_code != 200:
            error_body = resp.text
            logger.error(f"[IMPERSONATE] FAILED in {elapsed:.2f}s: {resp.status_code} {error_body}")
            details: dict = {"resource": resource, "user_identifier": user_identifier}
            policy_info = _parse_oauth_error(error_body)
            if policy_info:
                details.update(policy_info)
            return Result.failure(
                Error.KEYCARD_DENIED,
                f"Impersonation grant failed: {resp.status_code} {error_body}",
                details=details,
            )

        access_token = resp.json().get("access_token")
        if not access_token:
            return Result.failure(Error.INTERNAL, "Impersonation response missing access_token")

        logger.info(f"[IMPERSONATE] SUCCESS in {elapsed:.2f}s resource={resource} user={user_identifier}")
        return Result.success(access_token)

    except Exception as e:
        elapsed = time.time() - t0
        logger.error(f"[IMPERSONATE] FAILED in {elapsed:.2f}s: {type(e).__name__}: {e}")
        return Result.failure(
            Error.KEYCARD_DENIED,
            f"Impersonation grant failed: {type(e).__name__}: {e}",
            details={"resource": resource, "user_identifier": user_identifier},
        )
