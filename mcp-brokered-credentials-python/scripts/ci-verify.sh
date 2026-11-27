#!/usr/bin/env bash
set -euo pipefail

export PORT="${PORT:-8000}"
BASE="http://localhost:$PORT"
RESOURCE_ID="${KEYCARD_RESOURCE_ID:-$BASE/mcp}"
resource_path=$(python3 -c '
import sys
from urllib.parse import urlsplit

identifier = sys.argv[1]
url = urlsplit(identifier)
print((url.path or "/") + ("?" + url.query if "?" in identifier else ""))
' "$RESOURCE_ID")

uv run uvicorn main:app --host 0.0.0.0 --port "$PORT" &
PID=$!
trap 'kill $PID 2>/dev/null' EXIT

for i in $(seq 1 10); do
  curl -sf "$BASE/healthz" >/dev/null 2>&1 && break
  echo "Waiting... ($i/10)"
  sleep 2
done

echo "==> /healthz"
curl -sf "$BASE/healthz" | python3 -m json.tool

echo "==> unauthenticated POST $resource_path returns 401"
headers=$(curl -sS -D - -o /dev/null -X POST "$BASE$resource_path" \
  -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' -d '{}')
printf '%s\n' "$headers"
metadata_path=$(printf '%s\n' "$headers" | python3 -c '
import re
import sys
from urllib.parse import urlsplit

headers = sys.stdin.read()
if headers.splitlines()[0].split()[1] != "401":
    sys.exit("Expected HTTP 401")
match = re.search(r"^www-authenticate: Bearer\b[^\r\n]*resource_metadata=\"([^\"]+)\"", headers, re.I | re.M)
identifier = sys.argv[1]
resource = urlsplit(identifier)
path = "/.well-known/oauth-protected-resource" + ("" if resource.path == "/" else resource.path)
if "?" in identifier:
    path += "?" + resource.query
scheme = identifier.split("://", 1)[0]
if not match or match[1] != f"{scheme}://{resource.netloc}{path}":
    sys.exit("Expected a Bearer challenge advertising the bound metadata URL")
print(path)
' "$RESOURCE_ID")

echo "==> $metadata_path"
curl -sf "$BASE$metadata_path" | jq -e --arg resource "$RESOURCE_ID" 'select(.resource == $resource)'

echo "==> /.well-known/oauth-authorization-server"
curl -sf "$BASE/.well-known/oauth-authorization-server" | jq -e 'select(.issuer)'

echo "==> percent-encoded MCP path reaches the dispatcher"
MCP_SERVER_URL="$BASE" KEYCARD_RESOURCE_ID="$BASE/my%20mcp" uv run python - <<'PY'
from unittest.mock import patch

from keycardai.starlette import KeycardAuthBackend
from starlette.testclient import TestClient

from main import app

with (
    patch.object(KeycardAuthBackend, "authenticate", return_value=None),
    TestClient(app, base_url="http://localhost:8000") as client,
):
    response = client.post(
        "/my%20mcp",
        headers={"Accept": "application/json, text/event-stream"},
        json={
            "jsonrpc": "2.0", "id": 1, "method": "initialize",
            "params": {
                "protocolVersion": "2025-11-25", "capabilities": {},
                "clientInfo": {"name": "ci", "version": "1"},
            },
        },
    )
    assert response.status_code == 200, response.text
PY

echo "==> legacy MCP_SERVER_URL without KEYCARD_RESOURCE_ID fails at startup"
if startup_output=$(MCP_SERVER_URL="$BASE" KEYCARD_RESOURCE_ID= uv run python -c 'import main' 2>&1); then
  echo "Expected startup to fail when only MCP_SERVER_URL is configured" >&2
  exit 1
fi
printf '%s\n' "$startup_output" | grep -F 'MCP_SERVER_URL is no longer read. Set KEYCARD_RESOURCE_ID'
