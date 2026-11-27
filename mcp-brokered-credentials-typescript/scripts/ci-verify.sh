#!/usr/bin/env bash
set -euo pipefail

PORT="${PORT:-8000}"
BASE="http://localhost:$PORT"
RESOURCE_ID="${KEYCARD_RESOURCE_ID:-$BASE/mcp}"
RESOURCE_TARGET="$(node -e 'const url = new URL(process.argv[1]); process.stdout.write(url.pathname + url.search)' "$RESOURCE_ID")"
METADATA_TARGET="$(node -e 'const url = new URL(process.argv[1]); process.stdout.write("/.well-known/oauth-protected-resource" + (url.pathname === "/" ? "" : url.pathname) + url.search)' "$RESOURCE_ID")"
METADATA_ORIGIN="$(node -e 'process.stdout.write(new URL(process.argv[1]).origin)' "$RESOURCE_ID")"

node dist/server.js &
PID=$!
trap 'kill $PID 2>/dev/null' EXIT

for i in $(seq 1 10); do
  curl -sf "$BASE/healthz" >/dev/null 2>&1 && break
  echo "Waiting... ($i/10)"
  sleep 2
done

echo "==> /healthz"
curl -sf "$BASE/healthz" | jq .

echo "==> $METADATA_TARGET"
curl -fsS "$BASE$METADATA_TARGET" | jq -e --arg resource "$RESOURCE_ID" --arg issuer "$KEYCARD_URL" \
  'select(.resource == $resource and .authorization_servers == [$issuer] and .scopes_supported == ["mcp:tools"])'

echo "==> Unauthenticated POST $RESOURCE_TARGET"
response="$(curl -sS -D - -o /dev/null -w '%{http_code}\n' \
  -H 'Content-Type: application/json' -d '{}' "$BASE$RESOURCE_TARGET")"
status="${response##*$'\n'}"
challenge="$(printf '%s\n' "$response" | awk 'tolower($1) == "www-authenticate:" { sub(/^[^:]+:[[:blank:]]*/, ""); sub(/\r$/, ""); print }')"
printf '%s\n%s\n' "$status" "$challenge"
[[ "$status" == "401" && "$challenge" == "Bearer resource_metadata=\"$METADATA_ORIGIN$METADATA_TARGET\"" ]]

echo "==> /.well-known/oauth-authorization-server"
curl -fsS "$BASE/.well-known/oauth-authorization-server" | jq -e --arg issuer "$KEYCARD_URL" 'select(.issuer == $issuer)'
