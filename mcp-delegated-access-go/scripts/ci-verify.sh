#!/usr/bin/env bash
set -euo pipefail

PORT="${PORT:-8000}"
BASE="http://localhost:$PORT"

# The smoke test only probes /healthz and the .well-known endpoints (no user token), so it
# does not exercise the broker. Supply placeholders for the values the server requires at
# startup when CI does not inject them; the real values are used in the full eval.
export KEYCARD_URL="${KEYCARD_URL:-https://example.keycard.cloud}"
export KEYCARD_RESOURCE_ID="${KEYCARD_RESOURCE_ID:-$BASE/mcp}"
export KEYCARD_CLIENT_ID="${KEYCARD_CLIENT_ID:-smoke-test-client}"
export KEYCARD_CLIENT_SECRET="${KEYCARD_CLIENT_SECRET:-smoke-test-secret}"

go build -o ./mcp-delegated-access-go .
./mcp-delegated-access-go &
PID=$!
trap 'kill $PID 2>/dev/null' EXIT

for i in $(seq 1 10); do
  curl -sf "$BASE/healthz" >/dev/null 2>&1 && break
  echo "Waiting... ($i/10)"
  sleep 2
done

echo "==> /healthz"
curl -sf "$BASE/healthz" | jq .

echo "==> /.well-known/oauth-protected-resource"
curl -sf "$BASE/.well-known/oauth-protected-resource" | jq .

echo "==> /.well-known/oauth-authorization-server"
curl -sf "$BASE/.well-known/oauth-authorization-server" | jq .
