#!/usr/bin/env bash
#
# Provisions proxy application credentials and copies them into zone-vault
# resources so they can be brokered by `keycard run`.
#
# The credential material (client_id, client_secret) never leaves this
# process — it flows from the Keycard API response into jq into the vault
# resource creation calls without being printed or written to disk.
#
# Auth modes (detected automatically):
#   curl mode:  Set KEYCARD_API_ENDPOINT + KEYCARD_CLIENT_ID + KEYCARD_CLIENT_SECRET
#               in the environment. Used in CI and eval contexts.
#   CLI mode:   Uses `keycard agent api` from within a `keycard run` session.
#               Used when running interactively in a terminal.
#
# Usage:
#   bash scripts/provision-credentials.sh \
#     --zone <zone-id> \
#     --org <org-id> \
#     --app-id <proxy-application-id> \
#     --vault-provider <vault-provider-id> \
#     --name <project-name>

set -euo pipefail
umask 077

# Ensure creds_json is wiped on any exit path.
creds_json=""
cleanup() { unset creds_json 2>/dev/null || true; }
trap cleanup EXIT

# ---------------------------------------------------------------------------
# Argument parsing
# ---------------------------------------------------------------------------
zone="" org="" app_id="" vault_provider="" name=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --zone)           zone="$2";           shift 2 ;;
    --org)            org="$2";            shift 2 ;;
    --app-id)         app_id="$2";         shift 2 ;;
    --vault-provider) vault_provider="$2"; shift 2 ;;
    --name)           name="$2";           shift 2 ;;
    *)
      echo "Unknown flag: $1" >&2
      echo "Usage: bash scripts/provision-credentials.sh --zone <zone-id> --org <org-id> --app-id <proxy-application-id> --vault-provider <vault-provider-id> --name <project-name>" >&2
      exit 1
      ;;
  esac
done

missing=()
[[ -z "$zone" ]]           && missing+=(--zone)
[[ -z "$org" ]]            && missing+=(--org)
[[ -z "$app_id" ]]         && missing+=(--app-id)
[[ -z "$vault_provider" ]] && missing+=(--vault-provider)
[[ -z "$name" ]]           && missing+=(--name)

if [[ ${#missing[@]} -gt 0 ]]; then
  echo "Error: missing required flags: ${missing[*]}" >&2
  exit 1
fi

# ---------------------------------------------------------------------------
# Auth mode detection + API helpers
# ---------------------------------------------------------------------------
if [[ -n "${KEYCARD_API_ENDPOINT:-}" && -n "${KEYCARD_CLIENT_ID:-}" && -n "${KEYCARD_CLIENT_SECRET:-}" ]]; then
  # curl mode: obtain a bearer token and use curl for all calls
  _API_TOKEN=$(curl -sf -X POST "${KEYCARD_API_ENDPOINT}/service-account-token" \
    -d "grant_type=client_credentials" \
    -d "client_id=${KEYCARD_CLIENT_ID}" \
    -d "client_secret=${KEYCARD_CLIENT_SECRET}" \
    | jq -r '.access_token')
  [[ -n "$_API_TOKEN" && "$_API_TOKEN" != "null" ]] || { echo "Error: failed to obtain API token via curl" >&2; exit 1; }

  # GET /path → stdout
  kc_get() { curl -sf "${KEYCARD_API_ENDPOINT}${1}" -H "Authorization: Bearer ${_API_TOKEN}"; }
  # POST /path with stdin body → stdout
  kc_post() { curl -sf -X POST "${KEYCARD_API_ENDPOINT}${1}" \
    -H "Authorization: Bearer ${_API_TOKEN}" \
    -H "Content-Type: application/json" \
    --data-binary @-; }
  # POST /path with inline -d body → stdout
  kc_post_d() { curl -sf -X POST "${KEYCARD_API_ENDPOINT}${1}" \
    -H "Authorization: Bearer ${_API_TOKEN}" \
    -H "Content-Type: application/json" \
    -d "${2}"; }
else
  # CLI mode: use `keycard agent api` from within a `keycard run` session
  for cmd in keycard jq; do
    command -v "$cmd" &>/dev/null || { echo "Error: '$cmd' not on PATH" >&2; exit 1; }
  done
  kc_get()    { keycard agent api "${1}" --org "$org"; }
  kc_post()   { keycard agent api -X POST "${1}" --org "$org"; }
  kc_post_d() { keycard agent api -X POST "${1}" --org "$org" -d "${2}"; }
fi

command -v jq &>/dev/null || { echo "Error: 'jq' not on PATH" >&2; exit 1; }

# ---------------------------------------------------------------------------
# Pre-flight: vault resources must not already exist
# ---------------------------------------------------------------------------
urn_client_id="urn:${name}:client_id"
urn_client_secret="urn:${name}:client_secret"

existing_resources=$(kc_get "/zones/${zone}/resources" 2>/dev/null || echo '{"items":[]}')

for urn in "$urn_client_id" "$urn_client_secret"; do
  if echo "$existing_resources" | jq -e --arg u "$urn" '.items[] | select(.identifier == $u)' &>/dev/null; then
    echo "Error: vault resource '${urn}' already exists." >&2
    echo "Delete it first (or pick a different --name) to rotate credentials." >&2
    exit 1
  fi
done

# ---------------------------------------------------------------------------
# Step 1: Issue application credentials
# ---------------------------------------------------------------------------
echo "Issuing application credentials for ${name}..."

creds_json=$(kc_post_d "/zones/${zone}/application-credentials" \
  "{\"application_id\":\"${app_id}\",\"type\":\"password\"}" 2>&1) || {
    echo "Error: failed to issue application credentials." >&2
    echo "Create them at https://console.keycard.ai -> Applications -> ${name} -> Credentials, then provision vault resources manually." >&2
    exit 1
  }

if ! echo "$creds_json" | jq -e '.identifier // empty' &>/dev/null ||
   ! echo "$creds_json" | jq -e '.password // empty' &>/dev/null; then
  echo "Error: credential response missing identifier or password: ${creds_json}" >&2
  exit 1
fi

echo "Credentials issued (not printed)."

# ---------------------------------------------------------------------------
# Step 2: Create vault resources and attach secrets
# ---------------------------------------------------------------------------
echo "Creating vault resource ${urn_client_id}..."

resource_id_client_id=$(jq -n --arg n "$name" --arg pid "$vault_provider" '{
  name: ("urn:" + $n + ":client_id"),
  identifier: ("urn:" + $n + ":client_id"),
  credential_provider_id: $pid
}' | kc_post "/zones/${zone}/resources" | jq -r '.id')

[[ -n "$resource_id_client_id" && "$resource_id_client_id" != "null" ]] || {
  echo "Error: failed to create vault resource ${urn_client_id}." >&2; exit 1
}

echo "Attaching secret to ${urn_client_id}..."

echo "$creds_json" | jq --arg eid "$resource_id_client_id" --arg n "$name" '{
  name: ($n + "-client-id"),
  entity_id: $eid,
  data: { type: "token", token: .identifier }
}' | kc_post "/zones/${zone}/secrets" >/dev/null

echo "Creating vault resource ${urn_client_secret}..."

resource_id_client_secret=$(jq -n --arg n "$name" --arg pid "$vault_provider" '{
  name: ("urn:" + $n + ":client_secret"),
  identifier: ("urn:" + $n + ":client_secret"),
  credential_provider_id: $pid
}' | kc_post "/zones/${zone}/resources" | jq -r '.id')

[[ -n "$resource_id_client_secret" && "$resource_id_client_secret" != "null" ]] || {
  echo "Error: failed to create vault resource ${urn_client_secret}." >&2; exit 1
}

echo "Attaching secret to ${urn_client_secret}..."

echo "$creds_json" | jq --arg eid "$resource_id_client_secret" --arg n "$name" '{
  name: ($n + "-client-secret"),
  entity_id: $eid,
  data: { type: "token", token: .password }
}' | kc_post "/zones/${zone}/secrets" >/dev/null

unset creds_json

echo ""
echo "OK: created ${urn_client_id} and ${urn_client_secret}"
echo "These will be brokered into KEYCARD_CLIENT_ID and KEYCARD_CLIENT_SECRET by 'keycard run'."
