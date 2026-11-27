#!/usr/bin/env bash
set -euo pipefail

PORT="${PORT:-8000}"
BASE="http://localhost:$PORT"
RESOURCE_ID="${KEYCARD_RESOURCE_ID:-$BASE/mcp}"
METADATA_PATH="/.well-known/oauth-protected-resource/mcp"
METADATA_URL="${RESOURCE_ID%/mcp}/.well-known/oauth-protected-resource/mcp"

WORK_DIR="$(mktemp -d)"
PID=""
cleanup() {
  if [[ -n "$PID" ]]; then
    kill "$PID" 2>/dev/null || true
    wait "$PID" 2>/dev/null || true
  fi
  rm -rf "$WORK_DIR"
}
trap cleanup EXIT

go build -o "$WORK_DIR/server" .
"$WORK_DIR/server" >"$WORK_DIR/server.log" 2>&1 &
PID=$!

for i in $(seq 1 10); do
  curl -sf "$BASE/healthz" >/dev/null 2>&1 && break
  echo "Waiting... ($i/10)"
  sleep 2
done
cat "$WORK_DIR/server.log"
kill -0 "$PID"

echo "==> /healthz"
curl -sf "$BASE/healthz" | jq .

echo "==> $METADATA_PATH"
curl -fsS "$BASE$METADATA_PATH" |
  jq -e --arg resource "$RESOURCE_ID" 'select(.resource == $resource)'

echo "==> POST /mcp without a token"
STATUS="$(curl -sS -o /dev/null -D "$WORK_DIR/headers" -w '%{http_code}' -X POST "$BASE/mcp")"
echo "HTTP $STATUS"
[[ "$STATUS" == 401 ]]
grep -i '^WWW-Authenticate: Bearer ' "$WORK_DIR/headers" |
  grep -F "resource_metadata=\"$METADATA_URL\""


echo "==> /.well-known/oauth-authorization-server"
curl -sf "$BASE/.well-known/oauth-authorization-server" | jq .

if grep -i 'deprecat' "$WORK_DIR/server.log"; then
  echo "Unexpected deprecation warning in server output" >&2
  exit 1
fi
