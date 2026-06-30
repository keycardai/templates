#!/usr/bin/env bash
set -euo pipefail

PORT="${PORT:-8000}"
BASE="http://localhost:$PORT"

go build -o ./mcp-server-go .
./mcp-server-go &
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
