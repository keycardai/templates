#!/usr/bin/env bash
set -euo pipefail

CALLER_PORT="${CALLER_PORT:-9100}"
TARGET_PORT="${TARGET_PORT:-9101}"
export CALLER_BASE_URL="http://localhost:$CALLER_PORT"
export TARGET_BASE_URL="http://localhost:$TARGET_PORT"

uv run uvicorn target_agent:app --host 0.0.0.0 --port "$TARGET_PORT" &
TARGET_PID=$!
uv run uvicorn caller_agent:app --host 0.0.0.0 --port "$CALLER_PORT" &
CALLER_PID=$!
trap 'kill $TARGET_PID $CALLER_PID 2>/dev/null' EXIT

for base in "$TARGET_BASE_URL" "$CALLER_BASE_URL"; do
  for i in $(seq 1 10); do
    curl -sf "$base/healthz" >/dev/null 2>&1 && break
    echo "Waiting for $base... ($i/10)"
    sleep 2
  done
  echo "==> $base/healthz"
  curl -sf "$base/healthz" | python3 -m json.tool
  echo "==> $base/.well-known/agent-card.json"
  curl -sf "$base/.well-known/agent-card.json" | python3 -m json.tool
  echo "==> $base/a2a/jsonrpc without a bearer"
  curl -s -o /dev/null -w '%{http_code}\n' -D -  -X POST "$base/a2a/jsonrpc" \
    -H 'Content-Type: application/json' -H 'A2A-Version: 1.0' \
    -d '{"jsonrpc":"2.0","id":"1","method":"GetTask","params":{"id":"missing"}}'
done
