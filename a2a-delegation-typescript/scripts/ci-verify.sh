#!/usr/bin/env bash
set -euo pipefail

export CALLER_PORT="${CALLER_PORT:-9100}"
export TARGET_PORT="${TARGET_PORT:-9101}"
export CALLER_BASE_URL="${CALLER_BASE_URL:-http://localhost:$CALLER_PORT}"
export TARGET_BASE_URL="${TARGET_BASE_URL:-http://localhost:$TARGET_PORT}"

node_args=()
if [[ -f .env ]]; then node_args+=(--env-file=.env); fi

node "${node_args[@]}" dist/index.js target &
TARGET_PID=$!
node "${node_args[@]}" dist/index.js caller &
CALLER_PID=$!
trap 'kill "$TARGET_PID" "$CALLER_PID" 2>/dev/null || true' EXIT

verify_agent() {
  local port="$1" resource="$2" role="$3"
  local url="http://localhost:$port" headers

  for ((attempt = 1; attempt <= 20; attempt++)); do
    if curl -fsS --max-time 2 "$url/healthz" >/dev/null 2>&1; then break; fi
    sleep 1
  done
  curl -fsS --max-time 5 "$url/healthz" |
    jq -e --arg role "$role" '.status == "ok" and .role == $role' >/dev/null
  curl -fsS --max-time 5 "$url/.well-known/agent-card.json" |
    jq -e --arg endpoint "$resource/a2a/jsonrpc" '
      .supportedInterfaces | any(.protocolBinding == "JSONRPC" and
        .protocolVersion == "1.0" and .url == $endpoint)
    ' >/dev/null
  curl -fsS --max-time 5 "$url/.well-known/oauth-protected-resource" |
    jq -e --arg resource "$resource" '.resource == $resource' >/dev/null

  headers=$(curl -sS --max-time 5 -o /dev/null -D - -X POST "$url/a2a/jsonrpc" \
    -H 'Content-Type: application/json' -H 'A2A-Version: 1.0' \
    -d '{"jsonrpc":"2.0","id":"1","method":"SendMessage","params":{"message":{"messageId":"1","role":"ROLE_USER","parts":[{"text":"hello"}]}}}')
  [[ "$headers" == HTTP/*' 401 '* ]]
  printf '%s\n' "$headers" | grep -qi '^www-authenticate: bearer'
  echo "$role: health, A2A 1.0 card, resource metadata and bearer challenge passed"
}

verify_agent "$CALLER_PORT" "$CALLER_BASE_URL" caller
verify_agent "$TARGET_PORT" "$TARGET_BASE_URL" target
