"""Webhook impersonation bridge — Keycard + Linear MCP.

Receives HMAC-signed webhook events, impersonates the named user via
Keycard's OAuth 2.0 token exchange, and creates a Linear issue on their
behalf. No user secrets stored; credentials are vault-brokered by
`keycard run`.

Run with:
    keycard run -- uvicorn main:app --host 0.0.0.0 --port 8000
"""

import json
import logging

from starlette.applications import Starlette
from starlette.requests import Request
from starlette.responses import JSONResponse
from starlette.routing import Route

from config import SERVER_NAME, settings
from signing import verify as verify_signature
from upstream import create_linear_issue_for_user

logger = logging.getLogger(SERVER_NAME)
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(levelname)s %(message)s")


# Single source of truth for error responses returned by this service.
# Each entry: (http_status, default_message). The key doubles as the
# machine-readable `error` code in the JSON response.
ERRORS: dict[str, tuple[int, str]] = {
    "invalid_signature": (401, "HMAC verification failed"),
    "invalid_body": (400, "Request body is not valid JSON"),
    "missing_user_identifier": (400, "user_identifier is required"),
    "missing_title": (400, "data.title is required"),
    "missing_team": (400, "data.team is required"),
    "access_denied": (403, "Impersonation denied"),
    "upstream_failed": (502, "Upstream request failed"),
}


def error_response(code: str, message: str | None = None) -> JSONResponse:
    status, default = ERRORS[code]
    return JSONResponse({"error": code, "message": message or default}, status_code=status)


async def handle_webhook(request: Request) -> JSONResponse:
    body = await request.body()

    event_id = request.headers.get("X-Event-Id", "unknown")
    signature = request.headers.get("X-Signature")

    if not verify_signature(settings.webhook_secret, body, signature):
        logger.warning("webhook rejected: invalid signature (event_id=%s)", event_id)
        return error_response("invalid_signature")

    try:
        payload = json.loads(body)
    except (json.JSONDecodeError, UnicodeDecodeError):
        return error_response("invalid_body")

    user_identifier = payload.get("user_identifier")
    if not user_identifier:
        return error_response("missing_user_identifier")

    data = payload.get("data", {})
    title = data.get("title")
    if not title:
        return error_response("missing_title")

    team = data.get("team")
    if not team:
        return error_response("missing_team")

    description = data.get("description", "")

    logger.info(
        "webhook verified: event_id=%s user=%s team=%s title=%r",
        event_id, user_identifier, team, title,
    )

    try:
        issue_id = await create_linear_issue_for_user(
            user_identifier=user_identifier,
            title=title,
            description=description,
            team=team,
        )
    except PermissionError as exc:
        logger.error("impersonation denied for %s: %s", user_identifier, exc)
        return error_response("access_denied", str(exc))
    except RuntimeError as exc:
        logger.error("upstream error for %s: %s", user_identifier, exc)
        return error_response("upstream_failed", str(exc))

    logger.info("issue created: issue_id=%s user=%s", issue_id, user_identifier)
    return JSONResponse({"ok": True, "issue_id": issue_id})


async def healthz(request: Request) -> JSONResponse:
    return JSONResponse({"ok": True, "name": SERVER_NAME})


app = Starlette(
    routes=[
        Route("/webhooks/events", handle_webhook, methods=["POST"]),
        Route("/healthz", healthz, methods=["GET"]),
    ],
)

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=settings.port)
