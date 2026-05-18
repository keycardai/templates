"""CLI helper to send test webhook events to the bridge server.

Reads the webhook secret from the vault via `keycard credential read`,
computes the HMAC-SHA256 signature, and POSTs to the local server.

Registered as `send-webhook` in pyproject.toml:

    uv run send-webhook --user alice@example.com --team Engineering --title "Fix flaky test"
    uv run send-webhook --user alice@example.com --team Engineering --title "..." --tamper
"""

import argparse
import json
import os
import subprocess
import sys
from datetime import datetime, timezone

import httpx
from dotenv import find_dotenv, load_dotenv

from signing import sign

PROJECT_NAME = "webhook-impersonation-python"
WEBHOOK_SECRET_URN = f"urn:{PROJECT_NAME}:webhook_secret"


def _read_webhook_secret() -> str:
    """Read the webhook secret from the vault via keycard CLI."""
    try:
        result = subprocess.run(
            ["keycard", "credential", "read", WEBHOOK_SECRET_URN],
            capture_output=True, text=True, check=True,
        )
        secret = result.stdout.strip()
        if not secret:
            print("Error: keycard credential read returned empty output.", file=sys.stderr)
            print(f"Ensure the vault resource '{WEBHOOK_SECRET_URN}' exists.", file=sys.stderr)
            sys.exit(1)
        return secret
    except FileNotFoundError:
        print("Error: 'keycard' is not on PATH.", file=sys.stderr)
        sys.exit(1)
    except subprocess.CalledProcessError as exc:
        print(f"Error reading webhook secret: {exc.stderr.strip()}", file=sys.stderr)
        sys.exit(1)


def _sign(secret: str, body: bytes, *, tamper: bool = False) -> str:
    """Wrap shared signer, optionally flipping a byte to test the 401 path."""
    header = sign(secret, body)
    if tamper:
        scheme, _, digest = header.partition("=")
        if digest:
            digest = chr(ord(digest[0]) ^ 1) + digest[1:]
        header = f"{scheme}={digest}"
    return header


def main() -> None:
    load_dotenv(find_dotenv(usecwd=True))

    port = os.environ.get("PORT", "8000")
    default_url = f"http://localhost:{port}/webhooks/events"

    parser = argparse.ArgumentParser(
        prog="send-webhook",
        description="Send a test webhook event to the impersonation bridge",
    )
    parser.add_argument(
        "--user", required=True,
        help="User identifier to impersonate (e.g. alice@example.com)",
    )
    parser.add_argument(
        "--title", default="Test from webhook bridge",
        help="Issue title (default: 'Test from webhook bridge')",
    )
    parser.add_argument(
        "--description",
        default=None,
        help="Issue description (default: auto-generated with timestamp)",
    )
    parser.add_argument(
        "--team", required=True,
        help="Linear team name or ID (required by Linear's save_issue tool)",
    )
    parser.add_argument(
        "--url", default=default_url,
        help=f"Webhook endpoint URL (default: {default_url})",
    )
    parser.add_argument(
        "--tamper", action="store_true",
        help="Flip one byte of the HMAC signature to test the 401 rejection path",
    )

    args = parser.parse_args()

    if args.description is None:
        args.description = f"Sent at {datetime.now(timezone.utc).isoformat()} via send-webhook CLI"

    print("Reading webhook secret from vault...")
    secret = _read_webhook_secret()

    payload = {
        "event": "issue.create_requested",
        "user_identifier": args.user,
        "data": {
            "title": args.title,
            "description": args.description,
            "team": args.team,
        },
    }

    body = json.dumps(payload).encode()
    signature = _sign(secret, body, tamper=args.tamper)

    if args.tamper:
        print("(signature tampered — expecting 401)")

    print(f"POST {args.url}")
    print(f"  user_identifier: {args.user}")
    print(f"  team: {args.team}")
    print(f"  title: {args.title}")
    print()

    resp = httpx.post(
        args.url,
        content=body,
        headers={
            "Content-Type": "application/json",
            "X-Signature": signature,
            "X-Event-Id": f"test-{datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%S')}",
        },
        timeout=30.0,
    )

    print(f"HTTP {resp.status_code}")
    try:
        print(json.dumps(resp.json(), indent=2))
    except Exception:
        print(resp.text)


if __name__ == "__main__":
    main()
