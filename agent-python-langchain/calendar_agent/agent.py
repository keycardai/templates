"""A LangChain calendar agent whose access is brokered by Keycard.

Serves the calendar agent over HTTP with checkpointing, which is what makes
the interrupt-consent-resume flow work in the chat UI and over curl alike.

Identity: each run carries a `KeycardIdentity` context built by an `Access`
factory, e.g. `Access.on_behalf_of(caller_token)` (the chat UI and SDK pass it
per run). KEYCARD_SUBJECT_TOKEN is the fallback identity for runs that carry
none.

Model access is brokered too when the Anthropic federation ids are set; see
`calendar_agent/anthropic_wif.py`.

The agent's own credential follows the platform: the machine's OIDC token on
Fly, a client secret locally.
"""

from __future__ import annotations

import os

from dotenv import load_dotenv
from langchain.agents import create_agent

from calendar_agent.anthropic_wif import build_model
from calendar_agent.calendar_tools import (
    CALENDAR_RESOURCE,
    create_calendar_event,
    list_calendar_events,
)
from keycardai.langchain import Access, KeycardGrantMiddleware, KeycardIdentity
from keycardai.oauth.server import (
    ApplicationCredential,
    ClientSecret,
    FlyTokenSource,
    WorkloadIdentity,
)

load_dotenv()

AUTHORIZATION_PAGE = os.environ.get("KEYCARD_AUTHORIZATION_PAGE", "http://localhost:8765/")


def _authorization_url(failed_resources: list[str]) -> str:
    params = "&".join(f"resource={r}" for r in failed_resources)
    separator = "&" if "?" in AUTHORIZATION_PAGE else "?"
    return f"{AUTHORIZATION_PAGE}{separator}{params}" if params else AUTHORIZATION_PAGE


def _application_credential() -> ApplicationCredential | None:
    """How the agent authenticates to the zone, chosen by platform.

    On Fly (`FLY_APP_NAME` is set by the platform) the assertion is the
    machine's own OIDC token, so the deployment holds no client secret. Locally
    it is the client id and secret from `.env`.
    """
    client_id = os.environ.get("KEYCARD_CLIENT_ID")
    if os.environ.get("FLY_APP_NAME"):
        return WorkloadIdentity(FlyTokenSource(), client_id=client_id)
    client_secret = os.environ.get("KEYCARD_CLIENT_SECRET")
    if client_id and client_secret:
        return ClientSecret((client_id, client_secret))
    return None


def _current_identity() -> KeycardIdentity | None:
    """Re-read the signed-in user's token on every tool call.

    Resolved per call, not at startup, so signing in mid-conversation (via the
    `sign_in_required` interrupt) takes effect on resume with no restart. The
    whole demo therefore runs from the chat window.
    """
    load_dotenv(override=True)
    token = os.environ.get("KEYCARD_SUBJECT_TOKEN")
    return Access.on_behalf_of(token) if token else None


keycard = KeycardGrantMiddleware(
    zone_url=os.environ.get("KEYCARD_ZONE_URL", "https://unconfigured.keycard.cloud"),
    resources=[CALENDAR_RESOURCE],
    application_credential=_application_credential(),
    authorization_url=_authorization_url,
    sign_in_url=AUTHORIZATION_PAGE,
    fallback_identity=_current_identity,
)

agent = create_agent(
    model=build_model(
        keycard,
        model=os.environ.get("ANTHROPIC_MODEL", "claude-opus-5"),
        max_tokens=4096,
    ),
    tools=[list_calendar_events, create_calendar_event],
    system_prompt=(
        "You are a calendar assistant whose access to Google Calendar is brokered "
        "by Keycard: every tool call uses a fresh, short-lived delegated credential "
        "scoped to the signed-in user, and every call is audited. If a tool reports "
        "that authorization is required, relay the authorization link to the user "
        "plainly. If asked about your access, explain that each tool call uses a "
        "fresh credential Keycard mints for the signed-in user, and that you never "
        "hold the credential yourself. "
        "You do not know today's date. Never state or infer a date from memory: the calendar tools compute their window from the system clock and echo it back, so take the weekday and date from the tool result. For relative requests use days_ahead (0 = today, 1 = tomorrow)."
    ),
    middleware=[keycard],
    context_schema=KeycardIdentity,
)
