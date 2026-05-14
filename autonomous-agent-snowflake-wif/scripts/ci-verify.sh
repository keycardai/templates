#!/usr/bin/env bash
set -euo pipefail

PORT="${PORT:-8000}"
BASE="http://localhost:$PORT"
export AGENT_BASE_URL="$BASE"

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
