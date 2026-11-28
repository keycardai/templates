#!/usr/bin/env bash
set -euo pipefail

caller_port="${PORT:-9100}"
target_port=$((caller_port + 1))
caller="http://localhost:$caller_port"
target="http://localhost:$target_port"

pids=()
cleanup() {
  for pid in "${pids[@]}"; do
    kill "$pid" 2>/dev/null || true
  done
  for pid in "${pids[@]}"; do
    wait "$pid" 2>/dev/null || true
  done
}
trap cleanup EXIT

export CALLER_BASE_URL="${CALLER_BASE_URL:-$caller}"
export TARGET_BASE_URL="${TARGET_BASE_URL:-$target}"
app=./build/install/a2a-delegation-java/bin/a2a-delegation-java
PORT="$target_port" "$app" target &
pids+=("$!")
PORT="$caller_port" "$app" caller &
pids+=("$!")

verify() {
  local base="$1" resource="${2%/}" pid="$3" i auth_response
  for ((i = 0; i < 20; i++)); do
    curl -fsS --max-time 2 "$base/healthz" >/dev/null 2>&1 && break
    kill -0 "$pid" 2>/dev/null || { echo "Agent exited before becoming ready" >&2; exit 1; }
    sleep 1
  done

  curl -fsS --max-time 5 "$base/healthz" >/dev/null
  curl -fsS --max-time 5 "$base/.well-known/agent-card.json" |
    jq -e --arg endpoint "$resource/a2a/jsonrpc" '
      (.name | length > 0) and any(.supportedInterfaces[];
        .protocolBinding == "JSONRPC" and .protocolVersion == "1.0" and .url == $endpoint)
    ' >/dev/null
  curl -fsS --max-time 5 "$base/.well-known/oauth-protected-resource" |
    jq -e --arg resource "$resource" '.resource == $resource' >/dev/null
  curl -fsS --max-time 15 "$base/.well-known/oauth-authorization-server" |
    jq -e '.issuer | strings | length > 0' >/dev/null

  auth_response=$(curl -sS --max-time 5 -o /dev/null -D - -w '%{http_code}' \
    -H 'Content-Type: application/json' -H 'A2A-Version: 1.0' \
    --data '{"jsonrpc":"2.0","id":"check","method":"SendMessage","params":{"message":{"messageId":"check","role":"ROLE_USER","parts":[{"text":"hello"}]}}}' \
    "$base/a2a/jsonrpc")
  [[ "$auth_response" == *$'\n401' ]]
  grep -qi '^www-authenticate: Bearer' <<<"$auth_response"
}

verify "$target" "$TARGET_BASE_URL" "${pids[0]}"
verify "$caller" "$CALLER_BASE_URL" "${pids[1]}"
echo "Both agents passed health, discovery and Bearer challenge checks."
