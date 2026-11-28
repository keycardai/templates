#!/usr/bin/env bash
set -euo pipefail

export PORT="${PORT:-8000}"
BASE="http://localhost:$PORT"
RESOURCE="${KEYCARD_RESOURCE_ID:-$BASE/mcp}"

./build/install/mcp-delegated-access-java/bin/mcp-delegated-access-java &
pid=$!
trap 'kill "$pid" 2>/dev/null || true; wait "$pid" 2>/dev/null || true' EXIT

for ((i = 0; i < 20; i++)); do
  curl -fsS --max-time 2 "$BASE/healthz" >/dev/null 2>&1 && break
  kill -0 "$pid" 2>/dev/null || { echo "Server exited before becoming ready" >&2; exit 1; }
  sleep 1
done

curl -fsS --max-time 5 "$BASE/healthz" >/dev/null
curl -fsS --max-time 5 "$BASE/.well-known/oauth-protected-resource/mcp" |
  jq -e --arg resource "$RESOURCE" '.resource == $resource and (.scopes_supported | index("mcp:tools") != null)' >/dev/null
curl -fsS --max-time 15 "$BASE/.well-known/oauth-authorization-server" |
  jq -e '.issuer | strings | length > 0' >/dev/null

auth_response=$(curl -sS --max-time 5 -o /dev/null -D - -w '%{http_code}' \
  -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
  --data '{}' "$BASE/mcp")
[[ "$auth_response" == *$'\n401' ]]
challenge=$(grep -i '^www-authenticate: Bearer' <<<"$auth_response")
resource_origin=${RESOURCE%/mcp}
grep -Fq "resource_metadata=\"$resource_origin/.well-known/oauth-protected-resource/mcp\"" <<<"$challenge"

broker_response=$(curl -sS --max-time 5 -o /dev/null -D - -w '%{http_code}' "$BASE/broker")
[[ "$broker_response" == *$'\n401' ]]
grep -qi '^www-authenticate: Bearer' <<<"$broker_response"

echo "Health, OAuth metadata and Bearer challenges passed."
