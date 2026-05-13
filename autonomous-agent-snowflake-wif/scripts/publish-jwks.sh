#!/usr/bin/env bash
#
# Idempotent helper: verifies the agent's JWKS URL is reachable, then
# ensures a jwks_uri application credential exists on the Keycard application.
#
# Usage:
#   bash scripts/publish-jwks.sh \
#     --zone "<zone-id>" \
#     --org "<org-id>" \
#     --app-id "<agent-application-id>" \
#     --jwks-url "<agent-base-url>/.well-known/jwks.json"

set -euo pipefail

ZONE_ID=""
ORG_ID=""
APP_ID=""
JWKS_URL=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --zone)   ZONE_ID="$2"; shift 2 ;;
    --org)    ORG_ID="$2"; shift 2 ;;
    --app-id) APP_ID="$2"; shift 2 ;;
    --jwks-url) JWKS_URL="$2"; shift 2 ;;
    *) echo "Unknown option: $1" >&2; exit 1 ;;
  esac
done

if [[ -z "$ZONE_ID" || -z "$ORG_ID" || -z "$APP_ID" || -z "$JWKS_URL" ]]; then
  echo "Usage: publish-jwks.sh --zone <zone-id> --org <org-id> --app-id <app-id> --jwks-url <url>" >&2
  exit 1
fi

echo "Verifying JWKS is reachable at ${JWKS_URL}..."
if ! curl -sf "$JWKS_URL" | jq -e '.keys | length > 0' > /dev/null 2>&1; then
  echo "ERROR: JWKS not reachable or empty at ${JWKS_URL}" >&2
  echo "Ensure the agent's Express server is running and reachable." >&2
  exit 1
fi
echo "OK: JWKS reachable."

echo "Checking existing application credentials..."
EXISTING=$(keycard agent api \
  "/zones/${ZONE_ID}/application-credentials?application_id=${APP_ID}" \
  --org "$ORG_ID" 2>/dev/null || echo '{"items":[]}')

HAS_PUBKEY=$(echo "$EXISTING" | jq -e --arg url "$JWKS_URL" \
  '.items[] | select(.type == "public-key" and .jwks_uri == $url)' 2>/dev/null || true)

if [[ -n "$HAS_PUBKEY" ]]; then
  echo "OK: public-key credential already exists for ${JWKS_URL}. Nothing to do."
  exit 0
fi

IDENTIFIER=$(echo "$JWKS_URL" | sed 's|/.well-known/jwks.json$||')

echo "Creating public-key application credential..."
keycard agent api -X POST "/zones/${ZONE_ID}/application-credentials" --org "$ORG_ID" -d "$(jq -n \
  --arg app_id "$APP_ID" \
  --arg identifier "$IDENTIFIER" \
  --arg jwks_url "$JWKS_URL" \
  '{
    application_id: $app_id,
    type: "public-key",
    identifier: $identifier,
    jwks_uri: $jwks_url
  }')"

echo "OK: public-key credential created."
