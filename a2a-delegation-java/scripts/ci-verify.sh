#!/usr/bin/env bash
set -euo pipefail

CALLER_PORT="${CALLER_PORT:-9100}"
TARGET_PORT="${TARGET_PORT:-9101}"
export CALLER_BASE_URL="http://localhost:$CALLER_PORT"
export TARGET_BASE_URL="http://localhost:$TARGET_PORT"

BIN=./build/install/a2a-delegation-java/bin/a2a-delegation-java
[ -x "$BIN" ] || ./gradlew -q installDist

"$BIN" target &
TARGET_PID=$!
"$BIN" caller &
CALLER_PID=$!
trap 'kill $TARGET_PID $CALLER_PID 2>/dev/null' EXIT

for base in "$TARGET_BASE_URL" "$CALLER_BASE_URL"; do
  for i in $(seq 1 15); do
    curl -sf "$base/healthz" >/dev/null 2>&1 && break
    echo "Waiting for $base... ($i/15)"
    sleep 2
  done
  echo "==> $base/healthz"
  curl -sf "$base/healthz" | python3 -m json.tool
  echo "==> $base/.well-known/agent-card.json"
  curl -sf "$base/.well-known/agent-card.json" | python3 -m json.tool
  echo "==> $base/a2a/jsonrpc without a bearer"
  status=$(curl -s -o /dev/null -w '%{http_code}' -D - -X POST "$base/a2a/jsonrpc" \
    -H 'Content-Type: application/json' -H 'A2A-Version: 1.0' \
    -d '{"jsonrpc":"2.0","id":"1","method":"SendMessage","params":{"message":{"messageId":"m1","role":"ROLE_USER","parts":[{"text":"hi"}]}}}' \
    | tee /dev/stderr | tail -n 1)
  [ "$status" = "401" ] || { echo "expected 401 without a bearer, got $status"; exit 1; }
done
