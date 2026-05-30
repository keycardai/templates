#!/usr/bin/env bash
set -euo pipefail

PORT="${PORT:-8000}"
BASE="http://localhost:$PORT"

# A KEYCARD_URL is required for the server to boot. CI can point this at any
# reachable zone issuer; the smoke test only checks that OAuth metadata is served.
: "${KEYCARD_URL:?KEYCARD_URL must be set for ci-verify}"
export MCP_SERVER_URL="${MCP_SERVER_URL:-http://localhost:$PORT/}"

uv run python main.py &
PID=$!
trap 'kill $PID 2>/dev/null' EXIT

for i in $(seq 1 10); do
  curl -sf "$BASE/.well-known/oauth-authorization-server" >/dev/null 2>&1 && break
  echo "Waiting... ($i/10)"
  sleep 2
done

echo "==> /.well-known/oauth-protected-resource"
curl -sf "$BASE/.well-known/oauth-protected-resource" | python3 -m json.tool

echo "==> /.well-known/oauth-authorization-server"
curl -sf "$BASE/.well-known/oauth-authorization-server" | python3 -m json.tool
