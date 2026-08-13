"""
Google API Tools for MCP Server

This module contains the Google API integration tools, including:
- Data models for calendar events and parameters
- Token exchange logic for Google API access
- Google API interaction functions
- The main get_calendar_events tool implementation
"""

import json
import uuid
from datetime import datetime, timedelta, timezone
from typing import Any, Optional

import httpx
from keycardai.mcp.server.auth import AccessContext
from pydantic import BaseModel, Field


# Data models for Google Drive files
class DriveFile(BaseModel):
    """Structured Google Drive file data."""

    id: str
    name: str
    mimeType: Optional[str] = None
    size: Optional[str] = None
    createdTime: Optional[str] = None
    modifiedTime: Optional[str] = None
    webViewLink: Optional[str] = None
    parents: Optional[list[str]] = None
    trashed: Optional[bool] = False


class GoogleDriveParams(BaseModel):
    """Parameters for Google Drive API requests."""

    maxResults: int = Field(
        default=10, ge=1, le=100, description="Maximum number of files to return"
    )
    query: Optional[str] = Field(default=None, description="Search query using Google Drive API syntax")
    orderBy: str = Field(default="modifiedTime desc", description="Sort order for results")
    trashed: bool = Field(default=False, description="Include trashed files")


# Data models for Google Calendar events
class CalendarEventDateTime(BaseModel):
    """Date/time information for calendar events."""

    dateTime: Optional[str] = None
    date: Optional[str] = None


class CalendarEventAttendee(BaseModel):
    """Attendee information for calendar events."""

    email: str
    responseStatus: str = "needsAction"


class CalendarEvent(BaseModel):
    """Structured calendar event data."""

    id: str
    summary: str
    start: Optional[CalendarEventDateTime] = None
    end: Optional[CalendarEventDateTime] = None
    location: Optional[str] = None
    description: Optional[str] = None
    attendees: Optional[list[CalendarEventAttendee]] = None


class GoogleCalendarParams(BaseModel):
    """Parameters for Google Calendar API requests."""

    maxResults: int = Field(
        default=10, ge=1, le=50, description="Maximum number of events to return"
    )
    timeMin: Optional[str] = Field(default=None, description="Start time filter (ISO 8601)")
    timeMax: Optional[str] = Field(default=None, description="End time filter (ISO 8601)")
    calendarId: str = Field(default="primary", description="Calendar identifier")

async def fetch_google_calendar_events(
    access_token: str,
    calendar_id: str = "primary",
    max_results: int = 10,
    time_min: Optional[str] = None,
    time_max: Optional[str] = None,
    request_id: Optional[str] = None,
) -> list[CalendarEvent]:
    """Fetch events from Google Calendar API.

    Args:
        access_token: Google Calendar access token
        calendar_id: Calendar identifier (default: "primary")
        max_results: Maximum number of events to return
        time_min: Start time filter (ISO 8601)
        time_max: End time filter (ISO 8601)
        request_id: Request ID for logging

    Returns:
        List of calendar events

    Raises:
        ValueError: If API call fails
    """
    # Build Google Calendar API URL
    url = f"https://www.googleapis.com/calendar/v3/calendars/{calendar_id}/events"

    params = {"maxResults": str(max_results), "singleEvents": "true", "orderBy": "startTime"}

    if time_min:
        params["timeMin"] = time_min
    if time_max:
        params["timeMax"] = time_max

    headers = {"Authorization": f"Bearer {access_token}", "Accept": "application/json"}

    # Add request ID for tracing if provided
    if request_id:
        headers["X-Request-ID"] = request_id

    async with httpx.AsyncClient() as client:
        try:
            response = await client.get(url, params=params, headers=headers)
            print(f"Google Calendar API response status: {response.status_code}")
            response.raise_for_status()

        except httpx.HTTPStatusError as e:
            error_body = e.response.text
            raise ValueError(
                f"Google Calendar API error: {e.response.status_code} {e.response.reason_phrase} - {error_body}"
            ) from e
        except httpx.RequestError as e:
            raise ValueError(f"Failed to connect to Google Calendar API: {e}") from e

    try:
        data = response.json()
    except json.JSONDecodeError as e:
        raise ValueError(f"Failed to parse Google Calendar API response: {e}") from e

    # Process and validate event data
    events = []
    for event_data in data.get("items", []):
        try:
            # Map Google Calendar API response to our model
            event = CalendarEvent(
                id=event_data.get("id", ""),
                summary=event_data.get("summary", "Untitled Event"),
                start=CalendarEventDateTime(**event_data["start"])
                if event_data.get("start")
                else None,
                end=CalendarEventDateTime(**event_data["end"]) if event_data.get("end") else None,
                location=event_data.get("location"),
                description=event_data.get("description"),
                attendees=[
                    CalendarEventAttendee(
                        email=attendee.get("email", ""),
                        responseStatus=attendee.get("responseStatus", "needsAction"),
                    )
                    for attendee in event_data.get("attendees", [])
                ]
                if event_data.get("attendees")
                else None,
            )
            events.append(event)

        except Exception as e:
            # Log error but continue processing other events
            print(f"Warning: Failed to process event {event_data.get('id', 'unknown')}: {e}")
            continue

    return events


async def fetch_google_drive_files(
    access_token: str,
    max_results: int = 10,
    query: Optional[str] = None,
    order_by: str = "modifiedTime desc",
    trashed: bool = False,
    request_id: Optional[str] = None,
) -> list[DriveFile]:
    """Fetch files from Google Drive API.

    Args:
        access_token: Google Drive access token
        max_results: Maximum number of files to return
        query: Search query using Google Drive API syntax
        order_by: Sort order for results
        trashed: Include trashed files
        request_id: Request ID for logging

    Returns:
        List of Drive files

    Raises:
        ValueError: If API call fails
    """
    # Build Google Drive API URL
    url = "https://www.googleapis.com/drive/v3/files"

    # Build search query
    search_query = "trashed = false" if not trashed else ""

    # Add user's custom query if provided
    if query:
        if search_query:
            search_query += f" and ({query})"
        else:
            search_query = query

    params = {
        "pageSize": str(max_results),
        "fields": "files(id,name,mimeType,size,createdTime,modifiedTime,webViewLink,parents,trashed)",
        "orderBy": order_by,
        "q": search_query,
    }

    headers = {"Authorization": f"Bearer {access_token}", "Accept": "application/json"}

    # Add request ID for tracing if provided
    if request_id:
        headers["X-Request-ID"] = request_id

    async with httpx.AsyncClient() as client:
        try:
            response = await client.get(url, params=params, headers=headers)
            print(f"Google Drive API response status: {response.status_code}")
            response.raise_for_status()

        except httpx.HTTPStatusError as e:
            error_body = e.response.text
            raise ValueError(
                f"Google Drive API error: {e.response.status_code} {e.response.reason_phrase} - {error_body}"
            ) from e
        except httpx.RequestError as e:
            raise ValueError(f"Failed to connect to Google Drive API: {e}") from e

    try:
        data = response.json()
    except json.JSONDecodeError as e:
        raise ValueError(f"Failed to parse Google Drive API response: {e}") from e

    # Process and validate file data
    files = []
    for file_data in data.get("files", []):
        try:
            # Map Google Drive API response to our model
            file = DriveFile(
                id=file_data.get("id", ""),
                name=file_data.get("name", "Untitled File"),
                mimeType=file_data.get("mimeType"),
                size=file_data.get("size"),
                createdTime=file_data.get("createdTime"),
                modifiedTime=file_data.get("modifiedTime"),
                webViewLink=file_data.get("webViewLink"),
                parents=file_data.get("parents"),
                trashed=file_data.get("trashed", False),
            )
            files.append(file)

        except Exception as e:
            # Log error but continue processing other files
            print(f"Warning: Failed to process file {file_data.get('id', 'unknown')}: {e}")
            continue

    return files


async def get_calendar_events(
    access_context: AccessContext,
    maxResults: int = 10,
    timeMin: Optional[str] = None,
    timeMax: Optional[str] = None,
    calendarId: str = "primary",
) -> dict[str, Any]:
    """Get Google Calendar events for the authenticated user.

    Uses delegated token exchange to obtain Google Calendar access on behalf
    of the authenticated user, then fetches their calendar events.

    Args:
        oauth_client: Configured OAuth client instance
        ctx: Request context containing user authentication
        maxResults: Maximum number of events to return (1-50, default: 10)
        timeMin: Start time filter in ISO 8601 format (default: now)
        timeMax: End time filter in ISO 8601 format (default: 7 days from now)
        calendarId: Calendar identifier (default: "primary")

    Returns:
        Dictionary containing calendar events and metadata

    Example:
        {
            "events": [
                {
                    "id": "event123",
                    "summary": "Team Meeting",
                    "start": {"dateTime": "2024-01-15T10:00:00-08:00"},
                    "end": {"dateTime": "2024-01-15T11:00:00-08:00"},
                    "location": "Conference Room A",
                    "attendees": [{"email": "user@company.com", "responseStatus": "accepted"}]
                }
            ],
            "requestId": "abc12345",
            "totalEvents": 1
        }
    """
    # Generate unique request ID for tracing
    request_id = str(uuid.uuid4())[:8]

    try:
        # Validate parameters
        try:
            params = GoogleCalendarParams(
                maxResults=maxResults, timeMin=timeMin, timeMax=timeMax, calendarId=calendarId
            )
        except Exception as e:
            return {
                "error": f"❌ Invalid parameters: {e}",
                "requestId": request_id,
                "isError": True,
            }

        # Set default time range if not provided (with proper timezone format for Google API)
        if not params.timeMin:
            params.timeMin = datetime.now(timezone.utc).isoformat()  # Proper UTC timezone
        if not params.timeMax:
            params.timeMax = (datetime.now(timezone.utc) + timedelta(days=7)).isoformat()  # Proper UTC timezone

        # Fetch calendar events
        try:
            events = await fetch_google_calendar_events(
                access_token=access_context.access("https://www.googleapis.com/calendar/v3").access_token,
                calendar_id=params.calendarId,
                max_results=params.maxResults,
                time_min=params.timeMin,
                time_max=params.timeMax,
                request_id=request_id,
            )
        except ValueError as e:
            return {
                "error": f"❌ Failed to fetch calendar events: {e}",
                "requestId": request_id,
                "isError": True,
            }

        # Return structured response
        return {
            "events": [event.dict() for event in events],
            "requestId": request_id,
            "totalEvents": len(events),
            "parameters": {
                "calendarId": params.calendarId,
                "maxResults": params.maxResults,
                "timeMin": params.timeMin,
                "timeMax": params.timeMax,
            },
            "isError": False,
        }

    except Exception as e:
        return {"error": f"❌ Unexpected error: {e}", "requestId": request_id, "isError": True}


async def get_drive_files(
    access_context: AccessContext,
    maxResults: int = 10,
    query: Optional[str] = None,
    orderBy: str = "modifiedTime desc",
    trashed: bool = False,
) -> dict[str, Any]:
    """Get Google Drive files for the authenticated user.

    Uses delegated token exchange to obtain Google Drive access on behalf
    of the authenticated user, then fetches their files.

    Args:
        ctx: Request context containing user authentication
        maxResults: Maximum number of files to return (1-100, default: 10)
        query: Search query using Google Drive API syntax (optional)
        orderBy: Sort order for results (default: "modifiedTime desc")
        trashed: Include trashed files (default: False)

    Returns:
        Dictionary containing Drive files and metadata

    Example:
        {
            "files": [
                {
                    "id": "file123",
                    "name": "Document.pdf",
                    "mimeType": "application/pdf",
                    "size": "1024",
                    "createdTime": "2024-01-15T10:00:00.000Z",
                    "modifiedTime": "2024-01-15T11:00:00.000Z",
                    "webViewLink": "https://drive.google.com/file/d/file123/view",
                    "parents": ["folder456"],
                    "trashed": false
                }
            ],
            "requestId": "abc12345",
            "totalFiles": 1
        }
    """
    # Generate unique request ID for tracing
    request_id = str(uuid.uuid4())[:8]

    try:
        # Validate parameters
        try:
            params = GoogleDriveParams(
                maxResults=maxResults, query=query, orderBy=orderBy, trashed=trashed
            )
        except Exception as e:
            return {
                "error": f"❌ Invalid parameters: {e}",
                "requestId": request_id,
                "isError": True,
            }

        # Fetch Drive files
        try:
            files = await fetch_google_drive_files(
                access_token=access_context.access("https://www.googleapis.com/drive/v3").access_token,
                max_results=params.maxResults,
                query=params.query,
                order_by=params.orderBy,
                trashed=params.trashed,
                request_id=request_id,
            )
        except ValueError as e:
            return {
                "error": f"❌ Failed to fetch Drive files: {e}",
                "requestId": request_id,
                "isError": True,
            }

        # Return structured response
        return {
            "files": [file.dict() for file in files],
            "requestId": request_id,
            "totalFiles": len(files),
            "parameters": {
                "maxResults": params.maxResults,
                "query": params.query,
                "orderBy": params.orderBy,
                "trashed": params.trashed,
            },
            "isError": False,
        }

    except Exception as e:
        return {"error": f"❌ Unexpected error: {e}", "requestId": request_id, "isError": True}
