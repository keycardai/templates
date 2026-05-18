# webhook-impersonation-python

A webhook bridge that uses [Keycard](https://keycard.ai) impersonation to create Linear issues on behalf of users — without any user secrets stored and without the user being present at call time.

## How it works

1. **Users consent once.** Each user runs `keycard auth resource https://mcp.linear.app/mcp` to authorize the bridge to act on their behalf.
2. **Webhooks arrive.** An upstream system (GitHub, Slack, a scheduler, or the bundled CLI) sends an HMAC-signed POST to `/webhooks/events` naming a `user_identifier`.
3. **Impersonation.** The bridge calls Keycard's token exchange to get a Linear-scoped token for that user, then calls Linear's MCP server to create the issue.

All credentials (`client_id`, `client_secret`, `webhook_secret`) are vault-brokered by `keycard run` at startup — nothing lives on disk.

## Prerequisites

- Python 3.10+
- [uv](https://docs.astral.sh/uv/)
- [Keycard CLI](https://docs.keycard.ai) with an active zone
- A Keycard zone with a `keycard-vault` provider

## Quick start

```bash
# Install dependencies
uv sync

# Start the bridge (keycard run brokers secrets from the vault)
keycard run -- uvicorn main:app --host 0.0.0.0 --port 8000
```

## Demo (three terminals)

### Terminal 1 — User consent (once)

```bash
keycard auth resource https://mcp.linear.app/mcp
```

### Terminal 2 — Start the bridge

```bash
cd webhook-impersonation-python
keycard run -- uvicorn main:app --host 0.0.0.0 --port 8000
```

### Terminal 3 — Send test events

```bash
# Happy path: create an issue as alice
uv run send-webhook --user alice@example.com --title "Investigate flaky test"

# Test HMAC rejection (expect 401)
uv run send-webhook --user alice@example.com --title "tamper test" --tamper

# Test missing consent (expect 403)
uv run send-webhook --user nobody@example.com --title "no consent"
```

## Verify

- **Server logs:** `webhook verified → impersonating alice@example.com → Linear 201`
- **Linear:** New issue authored by Alice's account
- **Keycard Console → Audit Logs:** Substitute-user token exchange entry

## Webhook contract

```
POST /webhooks/events
Content-Type: application/json
X-Signature: sha256=<hex hmac_sha256(secret, body)>

{
  "event": "issue.create_requested",
  "user_identifier": "alice@example.com",
  "data": {
    "title": "Issue title",
    "description": "Optional description",
    "team": "ENG"
  }
}
```

## Provisioning

See [SPEC.md](SPEC.md) for the full agent-facing scaffolding contract. The key Keycard primitives:

- Linear OAuth provider + application + resource
- Bridge application with Linear as a dependency
- Application credentials + webhook secret in the zone vault
- Cedar impersonation policy permitting the bridge to act on behalf of users
