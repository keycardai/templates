#!/usr/bin/env bash
set -euo pipefail

PORT="${PORT:-8000}"
BASE="http://localhost:$PORT"

bundle exec rackup --host 0.0.0.0 --port "$PORT" &
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

echo "==> /mcp without a token (expect 401 + WWW-Authenticate)"
code=$(curl -s -o /dev/null -w "%{http_code}" -X POST --data '' "$BASE/mcp")
challenge=$(curl -s -o /dev/null -D - -X POST --data '' "$BASE/mcp" | grep -i '^www-authenticate:' || true)
echo "$code $challenge"
[ "$code" = "401" ] || { echo "expected 401 from /mcp, got $code"; exit 1; }
echo "$challenge" | grep -qi "resource_metadata" || { echo "401 is missing the resource_metadata challenge"; exit 1; }
