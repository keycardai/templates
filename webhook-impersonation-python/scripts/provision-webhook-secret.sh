#!/usr/bin/env bash
#
# Generates a random 32-byte webhook secret and stores it in a
# zone-vault resource so it can be brokered by `keycard run`.
#
# The secret never leaves this process — it flows from /dev/urandom
# through jq into the vault resource creation call without being
# printed or written to disk.
#
# Usage:
#   bash scripts/provision-webhook-secret.sh \
#     --zone <zone-id> \
#     --org <org-id> \
#     --vault-provider <vault-provider-id> \
#     --name <project-name>

set -euo pipefail
umask 077

secret=""
cleanup() { unset secret 2>/dev/null || true; }
trap cleanup EXIT

# ---------------------------------------------------------------------------
# Argument parsing
# ---------------------------------------------------------------------------
zone="" org="" vault_provider="" name=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --zone)           zone="$2";           shift 2 ;;
    --org)            org="$2";            shift 2 ;;
    --vault-provider) vault_provider="$2"; shift 2 ;;
    --name)           name="$2";           shift 2 ;;
    *)
      echo "Unknown flag: $1" >&2
      echo "Usage: bash scripts/provision-webhook-secret.sh --zone <zone-id> --org <org-id> --vault-provider <vault-provider-id> --name <project-name>" >&2
      exit 1
      ;;
  esac
done

missing=()
[[ -z "$zone" ]]           && missing+=(--zone)
[[ -z "$org" ]]            && missing+=(--org)
[[ -z "$vault_provider" ]] && missing+=(--vault-provider)
[[ -z "$name" ]]           && missing+=(--name)

if [[ ${#missing[@]} -gt 0 ]]; then
  echo "Error: missing required flags: ${missing[*]}" >&2
  exit 1
fi

# ---------------------------------------------------------------------------
# Pre-flight: required tools
# ---------------------------------------------------------------------------
for cmd in keycard jq openssl; do
  if ! command -v "$cmd" &>/dev/null; then
    echo "Error: '$cmd' is not on PATH. Install it and retry." >&2
    exit 1
  fi
done

# ---------------------------------------------------------------------------
# Pre-flight: vault resource must not already exist
# ---------------------------------------------------------------------------
urn_webhook_secret="urn:${name}:webhook_secret"

existing_resources=$(keycard agent api "/zones/${zone}/resources" --org "$org" 2>/dev/null || echo '{"items":[]}')

if echo "$existing_resources" | jq -e --arg u "$urn_webhook_secret" '.items[] | select(.identifier == $u)' &>/dev/null; then
  echo "Error: vault resource '${urn_webhook_secret}' already exists." >&2
  echo "Delete it first (or pick a different --name) to rotate the secret." >&2
  exit 1
fi

# ---------------------------------------------------------------------------
# Generate a random 32-byte hex secret
# ---------------------------------------------------------------------------
echo "Generating webhook secret..."
secret=$(openssl rand -hex 32)

# ---------------------------------------------------------------------------
# Create vault resource and attach the secret
# ---------------------------------------------------------------------------
echo "Creating vault resource ${urn_webhook_secret}..."

resource_id=$(jq -n --arg n "$name" --arg pid "$vault_provider" '{
  name: ("urn:" + $n + ":webhook_secret"),
  identifier: ("urn:" + $n + ":webhook_secret"),
  credential_provider_id: $pid
}' | keycard agent api -X POST "/zones/${zone}/resources" --org "$org" | jq -r '.id')

[[ -n "$resource_id" && "$resource_id" != "null" ]] || {
  echo "Error: failed to create vault resource ${urn_webhook_secret}." >&2
  exit 1
}

echo "Attaching secret to ${urn_webhook_secret}..."

jq -n --arg eid "$resource_id" --arg n "$name" --arg s "$secret" '{
  name: ($n + "-webhook-secret"),
  entity_id: $eid,
  data: { type: "token", token: $s }
}' | keycard agent api -X POST "/zones/${zone}/secrets" --org "$org" >/dev/null

# ---------------------------------------------------------------------------
# Cleanup
# ---------------------------------------------------------------------------
unset secret

echo ""
echo "OK: created ${urn_webhook_secret}"
echo "This will be brokered into WEBHOOK_SECRET by 'keycard run'."
