#!/usr/bin/env bash
#
# Provisions a single application with two workload identity credentials
# (Vercel OIDC + Fly OIDC) and copies them into zone-vault resources so
# they can be brokered by `keycard run`.
#
# This template uses ONE Keycard application with TWO application credentials
# (one per deployment platform). No client_id/client_secret needed at runtime —
# workload identity handles authentication. The vault resources here are for
# local development fallback only.
#
# Usage:
#   bash scripts/provision-credentials.sh \
#     --zone <zone-id> \
#     --org <org-id> \
#     --app-id <application-id> \
#     --vault-provider <vault-provider-id> \
#     --name <project-name>

set -euo pipefail
umask 077

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
      echo "Usage: bash scripts/provision-credentials.sh --zone <zone-id> --org <org-id> --app-id <application-id> --vault-provider <vault-provider-id> --name <project-name>" >&2
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

existing_resources=$(keycard agent api "/zones/${zone}/resources" --org "$org" 2>/dev/null || echo '{"items":[]}')

for urn in "$urn_client_id" "$urn_client_secret"; do
  if echo "$existing_resources" | jq -e --arg u "$urn" '.items[] | select(.identifier == $u)' &>/dev/null; then
    echo "Error: vault resource '${urn}' already exists." >&2
    echo "Delete it first (or pick a different --name) to rotate credentials." >&2
    exit 1
  fi
done

# ---------------------------------------------------------------------------
# Step 1: Issue application credentials (password type for local dev)
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
# Step 2: Create vault resources and attach secrets
# ---------------------------------------------------------------------------
echo "Creating vault resource ${urn_client_id}..."

resource_id_client_id=$(jq -n --arg n "$name" --arg pid "$vault_provider" '{
  name: ("urn:" + $n + ":client_id"),
  identifier: ("urn:" + $n + ":client_id"),
  credential_provider_id: $pid
}' | keycard agent api -X POST "/zones/${zone}/resources" --org "$org" | jq -r '.id')

[[ -n "$resource_id_client_id" && "$resource_id_client_id" != "null" ]] || {
  echo "Error: failed to create vault resource ${urn_client_id}." >&2
  exit 1
}

echo "Attaching secret to ${urn_client_id}..."

echo "$creds_json" | jq --arg eid "$resource_id_client_id" --arg n "$name" '{
  name: ($n + "-client-id"),
  entity_id: $eid,
  data: { type: "token", token: .identifier }
}' | keycard agent api -X POST "/zones/${zone}/secrets" --org "$org" >/dev/null

echo "Creating vault resource ${urn_client_secret}..."

resource_id_client_secret=$(jq -n --arg n "$name" --arg pid "$vault_provider" '{
  name: ("urn:" + $n + ":client_secret"),
  identifier: ("urn:" + $n + ":client_secret"),
  credential_provider_id: $pid
}' | keycard agent api -X POST "/zones/${zone}/resources" --org "$org" | jq -r '.id')

[[ -n "$resource_id_client_secret" && "$resource_id_client_secret" != "null" ]] || {
  echo "Error: failed to create vault resource ${urn_client_secret}." >&2
  exit 1
}

echo "Attaching secret to ${urn_client_secret}..."

echo "$creds_json" | jq --arg eid "$resource_id_client_secret" --arg n "$name" '{
  name: ($n + "-client-secret"),
  entity_id: $eid,
  data: { type: "token", token: .password }
}' | keycard agent api -X POST "/zones/${zone}/secrets" --org "$org" >/dev/null

# ---------------------------------------------------------------------------
# Cleanup
# ---------------------------------------------------------------------------
unset creds_json

echo ""
echo "OK: created ${urn_client_id} and ${urn_client_secret}"
echo "These will be brokered into KEYCARD_CLIENT_ID and KEYCARD_CLIENT_SECRET by 'keycard run'."
echo ""
echo "NOTE: In production, workload identity (Vercel OIDC / Fly OIDC) is used"
echo "instead of client_id/client_secret. The vault resources above are for"
echo "local development with 'keycard run' only."
