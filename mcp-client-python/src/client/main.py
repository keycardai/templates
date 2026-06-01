"""MCP client with controllable OAuth scopes.

Connects to a protected MCP server using the RFC 9728 / RFC 7591 / RFC 7636
flow (protected-resource discovery → authorization-server discovery → dynamic
client registration → PKCE authorization with caller-specified scopes → token
exchange) and then lists or calls tools over streamable HTTP.

Usage:
    mcp-client --server-url http://localhost:8000/mcp \
               --scopes databricks:sql:read databricks:sql:execute \
               --tool execute_statement \
               --tool-args '{"statement": "SELECT 1"}'
"""

from __future__ import annotations

import argparse
import asyncio
import hashlib
import json
import logging
import secrets
import sys
import webbrowser
from base64 import urlsafe_b64decode, urlsafe_b64encode
from urllib.parse import parse_qs, urlencode, urlparse

import httpx
from mcp import ClientSession
from mcp.client.streamable_http import streamablehttp_client

logger = logging.getLogger(__name__)

CALLBACK_PORT = 9876
CALLBACK_PATH = "/callback"


# ---------------------------------------------------------------------------
# PKCE helpers
# ---------------------------------------------------------------------------

def _decode_jwt_claims(token: str) -> dict:
    """Decode JWT payload without signature verification (for display only)."""
    parts = token.split(".")
    if len(parts) != 3:
        return {}
    payload = parts[1]
    payload += "=" * (-len(payload) % 4)
    return json.loads(urlsafe_b64decode(payload))


def _generate_pkce() -> tuple[str, str]:
    """Return (code_verifier, code_challenge) using S256."""
    verifier = secrets.token_urlsafe(64)
    digest = hashlib.sha256(verifier.encode("ascii")).digest()
    challenge = urlsafe_b64encode(digest).rstrip(b"=").decode("ascii")
    return verifier, challenge


# ---------------------------------------------------------------------------
# OAuth dance
# ---------------------------------------------------------------------------

async def discover_resource(server_url: str) -> dict:
    """GET /.well-known/oauth-protected-resource/<path> from the MCP server."""
    parsed = urlparse(server_url)
    path = parsed.path.lstrip("/")
    discovery_url = f"{parsed.scheme}://{parsed.netloc}/.well-known/oauth-protected-resource/{path}"

    async with httpx.AsyncClient() as client:
        resp = await client.get(discovery_url)
        resp.raise_for_status()
        data = resp.json()

    if "authorization_servers" not in data:
        raise RuntimeError(f"No authorization_servers in resource metadata: {discovery_url}")

    logger.info("Discovered resource: %s", data.get("resource"))
    logger.info("Authorization servers: %s", data["authorization_servers"])
    if data.get("scopes_supported"):
        logger.info("Scopes supported by server: %s", data["scopes_supported"])
    return data


async def discover_auth_server(resource_meta: dict) -> dict:
    """GET /.well-known/oauth-authorization-server from the first AS."""
    as_url = resource_meta["authorization_servers"][0]
    metadata_url = f"{as_url}/.well-known/oauth-authorization-server"

    async with httpx.AsyncClient() as client:
        resp = await client.get(metadata_url)
        resp.raise_for_status()
        data = resp.json()

    if "registration_endpoint" not in data:
        raise RuntimeError("Authorization server does not advertise registration_endpoint")

    logger.info("Authorization endpoint: %s", data["authorization_endpoint"])
    logger.info("Token endpoint:         %s", data["token_endpoint"])
    logger.info("Registration endpoint:  %s", data["registration_endpoint"])
    return data


async def register_client(
    as_meta: dict,
    redirect_uri: str,
) -> dict:
    """RFC 7591 dynamic client registration (public client)."""
    payload = {
        "client_name": "mcp-scope-test-client",
        "redirect_uris": [redirect_uri],
        "grant_types": ["authorization_code", "refresh_token"],
        "response_types": ["code"],
        "token_endpoint_auth_method": "none",
    }

    async with httpx.AsyncClient() as client:
        resp = await client.post(
            as_meta["registration_endpoint"],
            json=payload,
            headers={"Content-Type": "application/json"},
        )
        resp.raise_for_status()
        data = resp.json()

    logger.info("Registered client: %s", data.get("client_id"))
    return data


def build_authorize_url(
    as_meta: dict,
    client_info: dict,
    redirect_uri: str,
    code_challenge: str,
    state: str,
    resource_url: str,
    scopes: list[str],
) -> str:
    """Build the authorization URL with caller-chosen scopes."""
    params: dict[str, str] = {
        "response_type": "code",
        "client_id": client_info["client_id"],
        "redirect_uri": redirect_uri,
        "state": state,
        "code_challenge": code_challenge,
        "code_challenge_method": "S256",
        "resource": resource_url,
    }
    if scopes:
        params["scope"] = " ".join(scopes)

    return f"{as_meta['authorization_endpoint']}?{urlencode(params)}"


async def wait_for_callback(state: str) -> str:
    """Start a one-shot HTTP server, wait for the OAuth callback, return the auth code."""
    code_future: asyncio.Future[str] = asyncio.get_event_loop().create_future()

    async def handle_request(reader: asyncio.StreamReader, writer: asyncio.StreamWriter):
        raw = await reader.readuntil(b"\r\n\r\n")
        request_line = raw.split(b"\r\n")[0].decode()
        path = request_line.split(" ")[1]
        qs = parse_qs(urlparse(path).query)

        returned_state = qs.get("state", [None])[0]
        code = qs.get("code", [None])[0]
        error = qs.get("error", [None])[0]

        if error:
            body = f"Authorization error: {error}\n{qs.get('error_description', [''])[0]}"
            status = "400 Bad Request"
        elif returned_state != state:
            body = "State mismatch"
            status = "400 Bad Request"
        elif not code:
            body = "Missing authorization code"
            status = "400 Bad Request"
        else:
            body = "Authorization successful — you can close this tab."
            status = "200 OK"

        response = (
            f"HTTP/1.1 {status}\r\n"
            f"Content-Type: text/plain\r\n"
            f"Content-Length: {len(body)}\r\n"
            f"Connection: close\r\n"
            f"\r\n"
            f"{body}"
        )
        writer.write(response.encode())
        await writer.drain()
        writer.close()

        if code and returned_state == state and not code_future.done():
            code_future.set_result(code)
        elif not code_future.done():
            code_future.set_exception(RuntimeError(body))

    server = await asyncio.start_server(handle_request, "localhost", CALLBACK_PORT)
    try:
        return await code_future
    finally:
        server.close()
        await server.wait_closed()


async def exchange_code(
    as_meta: dict,
    client_info: dict,
    code: str,
    redirect_uri: str,
    code_verifier: str,
    resource_url: str,
) -> dict:
    """Exchange authorization code for tokens."""
    payload = {
        "grant_type": "authorization_code",
        "code": code,
        "redirect_uri": redirect_uri,
        "client_id": client_info["client_id"],
        "code_verifier": code_verifier,
        "resource": resource_url,
    }

    async with httpx.AsyncClient() as client:
        resp = await client.post(
            as_meta["token_endpoint"],
            data=payload,
            headers={"Content-Type": "application/x-www-form-urlencoded"},
        )
        resp.raise_for_status()
        tokens = resp.json()

    logger.info("Token exchange successful — scopes granted: %s", tokens.get("scope", "(none)"))
    return tokens


# ---------------------------------------------------------------------------
# MCP session
# ---------------------------------------------------------------------------

async def run_mcp_session(
    server_url: str,
    access_token: str,
    tool_name: str | None,
    tool_args: dict | None,
) -> None:
    """Connect to the MCP server with the bearer token and list/call tools."""
    headers = {"Authorization": f"Bearer {access_token}"}

    async with streamablehttp_client(server_url, headers=headers) as (
        read_stream,
        write_stream,
        _,
    ):
        async with ClientSession(read_stream, write_stream) as session:
            await session.initialize()

            tools_result = await session.list_tools()
            print("\n=== Available tools ===")
            for tool in tools_result.tools:
                print(f"  • {tool.name}: {tool.description or '(no description)'}")

            if tool_name:
                print(f"\n=== Calling tool: {tool_name} ===")
                result = await session.call_tool(tool_name, tool_args or {})
                for content in result.content:
                    if hasattr(content, "text"):
                        try:
                            parsed = json.loads(content.text)
                            print(json.dumps(parsed, indent=2))
                        except json.JSONDecodeError:
                            print(content.text)
                    else:
                        print(content)


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

async def async_main(args: argparse.Namespace) -> None:
    server_url = args.server_url.rstrip("/")
    scopes: list[str] = args.scopes or []

    print(f"Server URL:       {server_url}")
    print(f"Requested scopes: {' '.join(scopes) if scopes else '(none)'}")
    print()

    # 1. Protected resource discovery
    resource_meta = await discover_resource(server_url)
    resource_url = resource_meta.get("resource", server_url)

    # 2. Authorization server discovery
    as_meta = await discover_auth_server(resource_meta)

    # 3. Dynamic client registration
    redirect_uri = f"http://localhost:{CALLBACK_PORT}{CALLBACK_PATH}"
    client_info = await register_client(as_meta, redirect_uri)

    # 4. PKCE + authorization URL with requested scopes
    code_verifier, code_challenge = _generate_pkce()
    state = secrets.token_urlsafe(32)
    authorize_url = build_authorize_url(
        as_meta, client_info, redirect_uri, code_challenge, state, resource_url, scopes,
    )

    print(f"Opening browser for authorization...")
    print(f"  URL: {authorize_url}\n")
    webbrowser.open(authorize_url)

    # 5. Wait for callback
    code = await wait_for_callback(state)
    print("Authorization code received.\n")

    # 6. Exchange code for tokens
    tokens = await exchange_code(
        as_meta, client_info, code, redirect_uri, code_verifier, resource_url,
    )

    claims = _decode_jwt_claims(tokens["access_token"])
    granted = claims.get("scope", "")
    print(f"Access token received.")
    print(f"  Granted scopes: {granted if granted else '(none)'}")
    print(f"\n=== JWT claims ===")
    print(json.dumps(claims, indent=2))
    print()

    # 7. Connect to MCP and list/call tools
    tool_args = json.loads(args.tool_args) if args.tool_args else None
    await run_mcp_session(server_url, tokens["access_token"], args.tool, tool_args)


def main():
    parser = argparse.ArgumentParser(
        description="MCP client with controllable OAuth scopes",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""\
examples:
  # List tools, requesting only the SQL read scope
  mcp-client --server-url http://localhost:8000/mcp \\
             --scopes databricks:sql:read

  # Run a SQL statement (needs the execute scope)
  mcp-client --server-url http://localhost:8000/mcp \\
             --scopes databricks:sql:execute \\
             --tool execute_statement \\
             --tool-args '{"statement": "SELECT 1"}'

  # Request several per-tool scopes at once
  mcp-client --server-url http://localhost:8000/mcp \\
             --scopes databricks:sql:read databricks:sql:execute databricks:genie:converse
""",
    )
    parser.add_argument(
        "--server-url",
        required=True,
        help="MCP server URL (e.g. http://localhost:8050/mcp)",
    )
    parser.add_argument(
        "--scopes",
        nargs="*",
        default=[],
        help="OAuth scopes to request (space-separated)",
    )
    parser.add_argument(
        "--tool",
        help="Tool name to call after connecting (omit to just list tools)",
    )
    parser.add_argument(
        "--tool-args",
        help="JSON object of tool arguments",
    )
    parser.add_argument(
        "-v", "--verbose",
        action="store_true",
        help="Enable verbose logging",
    )
    args = parser.parse_args()

    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.WARNING,
        format="%(levelname)s %(name)s: %(message)s",
    )

    try:
        asyncio.run(async_main(args))
    except KeyboardInterrupt:
        print("\nInterrupted.")
        sys.exit(130)
    except Exception as e:
        print(f"\nError: {e}", file=sys.stderr)
        if args.verbose:
            import traceback
            traceback.print_exc()
        sys.exit(1)


if __name__ == "__main__":
    main()
