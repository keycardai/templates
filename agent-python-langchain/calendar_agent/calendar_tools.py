"""Google Calendar tools with Keycard-brokered credentials.

Each call reads a fresh delegated token from the AccessContext the middleware
built for this tool call. Raw tokens never enter model context.
"""

from __future__ import annotations

import json
import os
from datetime import datetime, timedelta

import httpx
from langchain.tools import tool

CALENDAR_RESOURCE = os.environ.get(
    "KEYCARD_RESOURCE", "https://www.googleapis.com/calendar/v3"
)

from keycardai.langchain import get_access_context


def _bearer() -> tuple[dict[str, str] | None, str | None]:
    """Auth headers for the call, or a message the model can relay verbatim.

    Never raises: a missing grant or expired sign-in is normal operation in a
    brokered setup, and the user should read about it in the chat rather than
    see an internal error.
    """
    access = get_access_context()
    if access.has_error():
        return None, (
            "Cannot call Google Calendar: no Keycard identity for this run. "
            f"Sign in again (login.py) and restart the server. Detail: {access.get_error()}"
        )
    if access.has_resource_error(CALENDAR_RESOURCE):
        return None, (
            "Authorization required for Google Calendar. "
            f"Detail: {access.get_resource_error(CALENDAR_RESOURCE)}"
        )
    token = access.access(CALENDAR_RESOURCE).access_token
    return {"Authorization": f"Bearer {token}"}, None


@tool
def list_calendar_events(days_ahead: int = 0, day_span: int = 1) -> str:
    """List events on the user's primary Google Calendar.

    The window is computed from the system clock, so it is always correct.

    Args:
        days_ahead: 0 for today (the default), 1 for tomorrow, -1 for yesterday.
        day_span: How many days the window covers, starting at `days_ahead`.
    """
    headers, error = _bearer()
    if error:
        return error

    local = datetime.now().astimezone().tzinfo
    start = datetime.now(tz=local).replace(hour=0, minute=0, second=0, microsecond=0)
    start += timedelta(days=days_ahead)
    end = start + timedelta(days=max(1, day_span))

    response = httpx.get(
        f"{CALENDAR_RESOURCE}/calendars/primary/events",
        params={
            "timeMin": start.isoformat(),
            "timeMax": end.isoformat(),
            "singleEvents": "true",
            "orderBy": "startTime",
            "maxResults": 20,
        },
        headers=headers,
        timeout=15,
    )
    if response.status_code != 200:
        return f"Calendar API error {response.status_code}: {response.text[:500]}"
    events = [
        {
            "summary": item.get("summary", "(no title)"),
            "start": item.get("start"),
            "end": item.get("end"),
            "attendees": [a.get("email") for a in item.get("attendees", [])],
        }
        for item in response.json().get("items", [])
    ]
    return json.dumps(
        {
            # Authoritative: describe dates to the user from this window, not
            # from any date the model believes today to be.
            "window": {
                "from": start.isoformat(),
                "to": end.isoformat(),
                "weekday": start.strftime("%A"),
                "date": start.strftime("%Y-%m-%d"),
            },
            "count": len(events),
            "events": events,
        },
        indent=2,
    )


@tool
def create_calendar_event(
    summary: str,
    days_ahead: int,
    start_hour: int,
    duration_minutes: int = 30,
    start_minute: int = 0,
    attendee_emails: list[str] | None = None,
) -> str:
    """Create an event on the user's primary Google Calendar.

    Times are relative to the system clock so the date is always correct.

    Args:
        summary: Event title.
        days_ahead: 0 for today, 1 for tomorrow, and so on.
        start_hour: Local hour, 24h clock (15 = 3pm).
        duration_minutes: Event length; defaults to 30.
        start_minute: Minute within the hour; defaults to 0.
        attendee_emails: Email addresses to invite (may be omitted).
    """
    headers, error = _bearer()
    if error:
        return error

    local = datetime.now().astimezone().tzinfo
    start_dt = datetime.now(tz=local).replace(
        hour=start_hour, minute=start_minute, second=0, microsecond=0
    ) + timedelta(days=days_ahead)
    end_dt = start_dt + timedelta(minutes=duration_minutes)

    response = httpx.post(
        f"{CALENDAR_RESOURCE}/calendars/primary/events",
        json={
            "summary": summary,
            "start": {"dateTime": start_dt.isoformat()},
            "end": {"dateTime": end_dt.isoformat()},
            "attendees": [{"email": e} for e in (attendee_emails or [])],
        },
        headers=headers,
        timeout=15,
    )
    if response.status_code not in (200, 201):
        return f"Calendar API error {response.status_code}: {response.text[:500]}"
    created = response.json()
    return json.dumps(
        {
            "created": created.get("summary"),
            "start": start_dt.isoformat(),
            "weekday": start_dt.strftime("%A"),
            "htmlLink": created.get("htmlLink"),
        }
    )
