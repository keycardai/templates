#!/usr/bin/env bash
set -euo pipefail

# CI smoke: the agent boots under langgraph dev against a fresh zone and the
# graph registers. No model call and no grants are exercised here; those need
# provisioned resources and a signed-in user (the eval harness owns that).
PORT="${PORT:-8000}"
BASE="http://localhost:$PORT"

# The CI workflow provides KEYCARD_URL (ephemeral zone issuer) and the CI
# service-account client credentials under the same names the agent reads.
export KEYCARD_ZONE_URL="${KEYCARD_ZONE_URL:-${KEYCARD_URL:?KEYCARD_URL or KEYCARD_ZONE_URL required}}"
# The model runs on the API key path here: CI has no Anthropic federation rule
# and no Anthropic organization, so the four ANTHROPIC_*_ID variables are unset
# and the placeholder key is what the graph imports with. No request is made.
export ANTHROPIC_API_KEY="${ANTHROPIC_API_KEY:-ci-placeholder-never-called}"

# Guards on both model paths and on the private langchain-anthropic client
# construction the WIF bridge overrides. These run without network access.
echo "==> unit guards"
uv run pytest -q

uv run langgraph dev --port "$PORT" --no-browser &
PID=$!
trap 'kill $PID 2>/dev/null' EXIT

for i in $(seq 1 30); do
  curl -sf "$BASE/ok" >/dev/null 2>&1 && break
  echo "Waiting for langgraph dev... ($i/30)"
  sleep 2
done

echo "==> /ok"
curl -sf "$BASE/ok" | jq .

echo "==> graph 'agent' is registered"
curl -sf -X POST "$BASE/assistants/search" \
  -H "Content-Type: application/json" \
  -d '{"limit": 10}' | jq -e '.[] | select(.graph_id == "agent") | .graph_id'

echo "==> deploy/fly/Dockerfile builds"
docker build -q -f deploy/fly/Dockerfile -t agent-python-langchain-fly-ci .
