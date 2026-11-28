#!/usr/bin/env bash
set -euo pipefail

PORT="$(node --env-file-if-exists=.env -p 'process.env.PORT || "8000"')"
BASE="http://localhost:$PORT"
RESOURCE_ID="$(node --env-file-if-exists=.env -p 'process.env.KEYCARD_RESOURCE_ID || process.argv[1]' "$BASE/mcp")"
ISSUER="$(node --env-file-if-exists=.env -p 'process.env.KEYCARD_URL || ""')"
METADATA_TARGET="$(node -e 'const url = new URL(process.argv[1]); process.stdout.write("/.well-known/oauth-protected-resource" + url.pathname + url.search)' "$RESOURCE_ID")"
METADATA_ORIGIN="$(node -e 'process.stdout.write(new URL(process.argv[1]).origin)' "$RESOURCE_ID")"

node --env-file-if-exists=.env dist/server.js &
PID=$!
cleanup() {
  kill "$PID" 2>/dev/null || true
  wait "$PID" 2>/dev/null || true
}
trap cleanup EXIT

for attempt in {1..10}; do
  curl -fsS --max-time 2 "$BASE/healthz" >/dev/null 2>&1 && break
  kill -0 "$PID"
  echo "Waiting for server ($attempt/10)"
  sleep 1
done

echo "==> /healthz"
curl -fsS --max-time 5 "$BASE/healthz" | jq -e '.status == "ok"'

echo "==> $METADATA_TARGET"
curl -fsS --max-time 15 "$BASE$METADATA_TARGET" |
  jq -e --arg resource "$RESOURCE_ID" --arg issuer "$ISSUER" \
    '.resource == $resource and .authorization_servers == [$issuer] and .scopes_supported == ["mcp:tools"]'

echo "==> POST /mcp without a token"
response="$(curl -sS --max-time 5 -D - -o /dev/null -w '%{http_code}\n' \
  -H 'Content-Type: application/json' -d '{}' "$BASE/mcp")"
status="${response##*$'\n'}"
challenge="$(printf '%s\n' "$response" | awk 'tolower($1) == "www-authenticate:" { sub(/^[^:]+:[[:blank:]]*/, ""); sub(/\r$/, ""); print }')"
[[ "$status" == "401" && "$challenge" == "Bearer resource_metadata=\"$METADATA_ORIGIN$METADATA_TARGET\"" ]]

for route in broker profile; do
  echo "==> GET /$route without a token"
  [[ "$(curl -sS --max-time 5 -o /dev/null -w '%{http_code}' "$BASE/$route")" == "401" ]]
done

echo "==> /.well-known/oauth-authorization-server"
curl -fsS --max-time 15 "$BASE/.well-known/oauth-authorization-server" |
  jq -e --arg issuer "$ISSUER" '.issuer == $issuer'
