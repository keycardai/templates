#!/usr/bin/env bash
set -euo pipefail

# MCP_SERVER_URL is the single source of truth; main.py binds to its port.
export MCP_SERVER_URL="${MCP_SERVER_URL:-http://localhost:8000/}"
BASE="${MCP_SERVER_URL%/}"

# A KEYCARD_URL is required for the server to boot. CI can point this at any
# reachable zone issuer; the smoke test only checks that OAuth metadata is served.
: "${KEYCARD_URL:?KEYCARD_URL must be set for ci-verify}"

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
