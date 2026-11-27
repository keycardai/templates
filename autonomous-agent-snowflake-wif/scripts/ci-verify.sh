#!/usr/bin/env bash
set -euo pipefail

PORT="${PORT:-8000}"
BASE="http://localhost:$PORT"
export AGENT_BASE_URL="$BASE"
RESOURCE_ID="${KEYCARD_RESOURCE_ID:-$AGENT_BASE_URL}"
METADATA_TARGET="$(node -e 'const url = new URL(process.argv[1]); process.stdout.write("/.well-known/oauth-protected-resource" + (url.pathname === "/" ? "" : url.pathname) + url.search)' "$RESOURCE_ID")"

node dist/index.js &
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
  'select(.resource == $resource and .authorization_servers == [$issuer])'

echo "==> Unauthenticated POST /a2a/jsonrpc"
response="$(curl -sS -D - -o /dev/null -w '%{http_code}\n' \
  -H 'Content-Type: application/json' -H 'A2A-Version: 1.0' -d '{}' "$BASE/a2a/jsonrpc")"
status="${response##*$'\n'}"
challenge="$(printf '%s\n' "$response" | awk 'tolower($1) == "www-authenticate:" { sub(/^[^:]+:[[:blank:]]*/, ""); sub(/\r$/, ""); print }')"
printf '%s\n%s\n' "$status" "$challenge"
[[ "$status" == "401" ]]
if [[ "$METADATA_TARGET" == "/.well-known/oauth-protected-resource/a2a/jsonrpc" ]]; then
  METADATA_ORIGIN="$(node -e 'process.stdout.write(new URL(process.argv[1]).origin)' "$RESOURCE_ID")"
  [[ "$challenge" == "Bearer resource_metadata=\"$METADATA_ORIGIN$METADATA_TARGET\"" ]]
else
  [[ "$challenge" == "Bearer" ]]
fi
