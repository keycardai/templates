#!/usr/bin/env bash
#
# Provisions proxy application credentials and copies them into zone-vault
# resources so they can be brokered by `keycard run`.
#
# The credential material (client_id, client_secret) never leaves this
# process — it flows from the Keycard API response into jq into the vault
# resource creation calls without being printed or written to disk.
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
    --zone)          zone="$2";           shift 2 ;;
    --org)           org="$2";            shift 2 ;;
    --app-id)        app_id="$2";         shift 2 ;;
    --vault-provider) vault_provider="$2"; shift 2 ;;
    --name)          name="$2";           shift 2 ;;
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
# Pre-flight: required tools
# ---------------------------------------------------------------------------
for cmd in keycard jq; do
  if ! command -v "$cmd" &>/dev/null; then
    echo "Error: '$cmd' is not on PATH. Install it and retry." >&2
    exit 1
  fi
done

# ---------------------------------------------------------------------------
# Pre-flight: vault resources must not already exist
# ---------------------------------------------------------------------------
urn_client_id="urn:${name}:client_id"
urn_client_secret="urn:${name}:client_secret"

existing_resources=$(keycard agent api "/zones/${zone}/resources" --org "$org" 2>/dev/null || echo "[]")

for urn in "$urn_client_id" "$urn_client_secret"; do
  if echo "$existing_resources" | jq -e --arg u "$urn" '.[] | select(.identifier == $u)' &>/dev/null; then
    echo "Error: vault resource '${urn}' already exists." >&2
    echo "Delete it first (or pick a different --name) to rotate credentials." >&2
    exit 1
  fi
done

# ---------------------------------------------------------------------------
# Step 1: Issue application credentials
# ---------------------------------------------------------------------------
echo "Issuing application credentials for ${name}..."

creds_json=$(keycard agent api -X POST \
  "/zones/${zone}/application-credentials" \
  --org "$org" \
  -d "{\"application_id\":\"${app_id}\",\"type\":\"password\"}" 2>&1) || {
    echo "Error: failed to issue application credentials." >&2
    echo "" >&2
    echo "Could not auto-issue application credentials. Create them at" >&2
    echo "https://console.keycard.ai -> Applications -> ${name} -> Credentials," >&2
    echo "then provision vault resources manually." >&2
    exit 1
  }

# Password-type response uses { identifier: <client_id>, password: <client_secret> }.
# `password` is only returned on creation; if it's missing, the request didn't actually mint a secret.
if ! echo "$creds_json" | jq -e '.identifier // empty' &>/dev/null ||
   ! echo "$creds_json" | jq -e '.password // empty' &>/dev/null; then
  echo "Error: credential response missing identifier or password." >&2
  echo "" >&2
  echo "Could not auto-issue application credentials. Create them at" >&2
  echo "https://console.keycard.ai -> Applications -> ${name} -> Credentials," >&2
  echo "then provision vault resources manually." >&2
  exit 1
fi

echo "Credentials issued (not printed)."

# ---------------------------------------------------------------------------
# Step 2: Create vault resources — secrets flow via jq pipe, never echoed
# ---------------------------------------------------------------------------
echo "Creating vault resource ${urn_client_id}..."

echo "$creds_json" | jq --arg n "$name" --arg pid "$vault_provider" '{
  name: ($n + "-client-id"),
  identifier: ("urn:" + $n + ":client_id"),
  description: ("Brokered client_id for the " + $n + " proxy application"),
  credential_provider_id: $pid,
  secret: .identifier
}' | keycard agent api -X POST "/zones/${zone}/resources" --org "$org" -d @- >/dev/null

echo "Creating vault resource ${urn_client_secret}..."

echo "$creds_json" | jq --arg n "$name" --arg pid "$vault_provider" '{
  name: ($n + "-client-secret"),
  identifier: ("urn:" + $n + ":client_secret"),
  description: ("Brokered client_secret for the " + $n + " proxy application"),
  credential_provider_id: $pid,
  secret: .password
}' | keycard agent api -X POST "/zones/${zone}/resources" --org "$org" -d @- >/dev/null

# ---------------------------------------------------------------------------
# Cleanup
# ---------------------------------------------------------------------------
unset creds_json

echo ""
echo "OK: created ${urn_client_id} and ${urn_client_secret}"
echo "These will be brokered into KEYCARD_CLIENT_ID and KEYCARD_CLIENT_SECRET by 'keycard run'."
