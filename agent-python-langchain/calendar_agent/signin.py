"""Sign-in and consent page for the demo. Keep this running.

Runs a localhost authorization-code + PKCE flow against KEYCARD_ZONE_URL and
writes the access token to `.env` as KEYCARD_SUBJECT_TOKEN.

It stays up after the first sign-in on purpose: the agent's
`authorization_required` interrupt links back here with `?resource=...` when a
tool hits a resource the user has not granted yet, so this page has to be
listening for the whole demo. Grant access here, then resume the run in the
chat; the existing subject token exchanges successfully once the grant exists.

`--serve` listens without signing in, which is how you start it for a demo:
the agent's `sign_in_required` interrupt provides the link, so nobody is signed
in until the audience watches it happen.

`--once` exits after a single sign-in (for scripted use).

By default it signs in as the **agent application** (KEYCARD_CLIENT_ID, a
confidential client), so the token is addressed to the agent and carries the
user's grant to it. That is what lets the agent exchange it for resource
tokens: a zone will not let one application exchange another application's
user token.

`--as-login-app` uses the public login application instead
(KEYCARD_LOGIN_CLIENT_ID). That token establishes the user's grant for the
impersonation flow, but the agent cannot exchange it directly.

Run: uv run python login.py [--serve] [--as-login-app] [--once]
"""

from __future__ import annotations

import http.server
import os
import pathlib
import secrets
import sys
import threading
import urllib.parse
import webbrowser

from dotenv import load_dotenv

from keycardai.oauth import Client, build_authorize_url
from keycardai.oauth.http.auth import BasicAuth, NoneAuth
from keycardai.oauth.types.models import ClientConfig
from keycardai.oauth.utils.pkce import PKCEGenerator

load_dotenv()

PORT = 8765

# The resource the agent application owns. A user token must be addressed here
# for the agent to be allowed to exchange it (svc-sts validates that the
# subject token's first audience is a resource owned by the exchanging client).
KEYCARD_AGENT_RESOURCE = os.environ.get(
    "KEYCARD_AGENT_RESOURCE", "http://localhost:2024"
)


def _write_subject_token(token: str) -> None:
    """Persist the token to .env so demo.py and the server both pick it up."""
    env_path = pathlib.Path(__file__).parent / ".env"
    lines = env_path.read_text().splitlines() if env_path.exists() else []
    lines = [line for line in lines if not line.startswith("KEYCARD_SUBJECT_TOKEN=")]
    lines.append(f"KEYCARD_SUBJECT_TOKEN={token}")
    env_path.write_text("\n".join(lines) + "\n")


def main() -> None:
    zone_url = os.environ.get("KEYCARD_ZONE_URL")
    if not zone_url:
        sys.exit("Missing KEYCARD_ZONE_URL (see .env.example)")

    as_login_app = "--as-login-app" in sys.argv
    once = "--once" in sys.argv
    serve_only = "--serve" in sys.argv
    if as_login_app:
        client_id = os.environ.get("KEYCARD_LOGIN_CLIENT_ID", "langchain-demo-login")
        auth = NoneAuth()
    else:
        client_id = os.environ.get("KEYCARD_CLIENT_ID")
        client_secret = os.environ.get("KEYCARD_CLIENT_SECRET")
        if not (client_id and client_secret):
            sys.exit("Missing KEYCARD_CLIENT_ID / KEYCARD_CLIENT_SECRET (see .env.example)")
        auth = BasicAuth(client_id, client_secret)
    redirect_uri = f"http://localhost:{PORT}/callback"

    oauth_client = Client(
        issuer=zone_url,
        auth=auth,
        config=ClientConfig(enable_metadata_discovery=True, auto_register_client=False),
    )
    print(f"Signing in as {'login app' if as_login_app else 'agent app'}: {client_id}")
    authorize_endpoint = oauth_client.endpoints.authorize

    pkce_store: dict[str, str] = {}
    done = threading.Event()

    class Handler(http.server.BaseHTTPRequestHandler):
        def do_GET(self):
            parsed = urllib.parse.urlparse(self.path)
            qs = urllib.parse.parse_qs(parsed.query)

            if parsed.path == "/":
                pkce = PKCEGenerator().generate_pkce_pair()
                state = secrets.token_urlsafe(32)
                pkce_store[state] = pkce.code_verifier
                # The token must be addressed to a resource the agent owns:
                # svc-sts only lets a client exchange a subject token whose
                # first audience is the client's own resource. Downstream
                # resources (Calendar) come from ?resource= on the interrupt
                # link and ride along as additional targets.
                requested = qs.get("resource", [])
                resources = [KEYCARD_AGENT_RESOURCE, *requested]
                if requested:
                    pkce_store[f"res:{state}"] = requested[0]
                url = build_authorize_url(
                    authorize_endpoint,
                    client_id=client_id,
                    redirect_uri=redirect_uri,
                    pkce=pkce,
                    resources=resources,
                    scope="openid email",
                    state=state,
                )
                self.send_response(302)
                self.send_header("Location", url.replace("\r", "").replace("\n", ""))
                self.end_headers()
            elif parsed.path == "/callback":
                self._handle_callback(qs)
            else:
                self.send_response(404)
                self.end_headers()

        def _handle_callback(self, qs: dict):
            if "error" in qs:
                self._html(400, f"Authorization failed: {qs['error'][0]}")
                done.set()
                return
            code = qs.get("code", [None])[0]
            state = qs.get("state", [None])[0]
            code_verifier = pkce_store.pop(state or "", None)
            if not code or not code_verifier:
                self._html(400, "Missing code or unknown state.")
                return
            try:
                token_response = oauth_client.exchange_authorization_code(
                    code=code,
                    redirect_uri=redirect_uri,
                    code_verifier=code_verifier,
                    client_id=client_id,
                )
            except Exception as exc:
                self._html(502, f"Token exchange failed: {exc}")
                done.set()
                return
            granted = pkce_store.pop(f"res:{state}", None)
            self._html(
                200,
                "<h2>Access granted</h2>"
                + (f"<p><code>{granted}</code></p>" if granted else "")
                + "<p>Return to the chat and resume the run.</p>",
            )
            _write_subject_token(token_response.access_token)
            print("\nSigned in. KEYCARD_SUBJECT_TOKEN written to .env")
            print("  demo.py and a freshly started `langgraph dev` pick it up.")
            if once:
                done.set()
            else:
                print("  Consent page still listening on "
                      f"http://localhost:{PORT} (Ctrl-C to stop).")

        def _html(self, status: int, message: str):
            self.send_response(status)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.end_headers()
            self.wfile.write(f"<html><body style='font-family:sans-serif'><p>{message}</p></body></html>".encode())

        def log_message(self, fmt, *a):
            pass

    server = http.server.HTTPServer(("localhost", PORT), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    if serve_only:
        print(f"Consent page listening on http://localhost:{PORT} ({zone_url}).")
        print("Nobody is signed in: the agent's interrupt links provide sign-in.")
    else:
        print(f"Opening http://localhost:{PORT} to sign in via {zone_url} ...")
        if not once:
            print("This page stays up to serve the agent's authorization links.")
        webbrowser.open(f"http://localhost:{PORT}/")
    try:
        done.wait()
    except KeyboardInterrupt:
        pass
    server.shutdown()


if __name__ == "__main__":
    main()
