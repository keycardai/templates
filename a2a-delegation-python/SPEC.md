# SPEC: a2a-delegation-python

Two Keycard-protected A2A agents in one directory: a **caller** that delegates a user's request to a **target** in the same zone by RFC 8693 token exchange, and a target that answers with the identity claims it verified. No model is called. The agent (e.g. the `keycard-template-app` skill) MUST perform every step in this document before declaring the project ready.

Throughout, treat `<name>` as the kebab-case project name (default: `a2a-delegation-python`), `<caller-port>` as the caller's port (default `9100`) and `<target-port>` as the target's port (default `9101`).

## 0. How the agent uses this document

**This SPEC is input for the agent, not output for the user.** Read it, extract the structured data, and reason from it, but never quote or print any of it verbatim. Paraphrase before showing anything.

## 0a. What this template is

`target_agent.py` is an a2a-sdk 1.x server whose `/a2a/jsonrpc` mount is fronted by `KeycardAuthBackend(require_authentication=True)` with the verifier's audience bound to `TARGET_BASE_URL`. Its executor replies with a JSON document carrying the verified token's `sub`, `act` and `aud`.

`caller_agent.py` is the same composition bound to `CALLER_BASE_URL`. Its executor takes the verified user's token (`keycard_user(context).access_token`), discovers the target through `ServiceDiscovery`, and calls `DelegationClient.invoke_service(TARGET_BASE_URL, text, subject_token=...)`, which exchanges the user's token for the target (resource = the target, authenticated with `KEYCARD_CLIENT_ID` / `KEYCARD_CLIENT_SECRET`) and sends `SendMessage` with `A2A-Version: 1.0`. The zone keeps the user as `sub` and records the caller's application as `act.sub`.

## 0c. Concepts the agent should introduce

| Order | Concept | One-sentence framing | Docs |
|---|---|---|---|
| 1 | Zone | Your private Keycard environment that holds users, apps, and policies and issues credentials. | https://docs.keycard.ai/platform/concepts/zones/ |
| 2 | Application | The identity of each agent; the caller's credential authenticates its token exchange. | https://docs.keycard.ai/platform/concepts/applications/ |
| 3 | Resource | Each agent's URL, registered so tokens can be audienced at it. | https://docs.keycard.ai/platform/concepts/resources/ |
| 4 | Delegation (token exchange) | The caller trades the user's token for one scoped to the target; the user stays the subject and the caller is recorded as the actor. | https://docs.keycard.ai/platform/architecture/standards-and-protocols/ |

## 1. Required Keycard primitives

### 1a. Credential provider

```bash
keycard agent api /zones/<zone-id>/providers --org <org-id>
```

Pick the provider with `type = "keycard-sts"`. Carry as `<provider-id>`. MUST NOT pick a `keycard-vault` provider.

### 1b. Applications

Create two, `<name>-caller` and `<name>-target`, with `consent: "implicit"`:

```bash
keycard agent api -X POST /zones/<zone-id>/applications --org <org-id> -d '{
  "name": "<name>-caller", "identifier": "<name>-caller",
  "description": "A2A delegation caller scaffolded by keycard-template-app", "consent": "implicit"
}'
```

On 409, look up and reuse the existing ID. Carry as `<caller-app-id>` and `<target-app-id>`.

### 1c. Caller credential

```bash
keycard agent api -X POST /zones/<zone-id>/application-credentials --org <org-id> -d '{
  "application_id": "<caller-app-id>", "type": "password"
}'
```

The response's `identifier` and `password` are `KEYCARD_CLIENT_ID` and `KEYCARD_CLIENT_SECRET`. The target needs no credential: it only verifies.

### 1d. Resources

One per agent, owned by that agent's application, identifier = its base URL:

```bash
keycard agent api -X POST /zones/<zone-id>/resources --org <org-id> -d '{
  "name": "<name>-target", "identifier": "http://localhost:<target-port>",
  "application_id": "<target-app-id>", "credential_provider_id": "<provider-id>"
}'
```

Same for the caller with `<caller-app-id>` and `http://localhost:<caller-port>`. Carry as `<caller-resource-id>` and `<target-resource-id>`.

### 1e. Dependency

The caller's application MUST depend on the target's resource; this is what lets it exchange a user's token for the target:

```bash
keycard agent api -X PUT /zones/<zone-id>/applications/<caller-app-id>/dependencies/<target-resource-id> --org <org-id>
```

## 2. Configuration the agent MUST write

### .env

```
KEYCARD_URL=https://<zone-id>.keycard.cloud
KEYCARD_CLIENT_ID=<caller credential identifier>
KEYCARD_CLIENT_SECRET=<caller credential password>
CALLER_BASE_URL=http://localhost:<caller-port>
TARGET_BASE_URL=http://localhost:<target-port>
```

### keycard.toml

Write `[org] id`, `[zone] id` and `[credentials]` as in the other Python templates.

## 3. Agent verification

```bash
uv sync
uv run uvicorn target_agent:app --host 0.0.0.0 --port <target-port> &
uv run uvicorn caller_agent:app --host 0.0.0.0 --port <caller-port> &
curl -sf http://localhost:<target-port>/healthz
curl -sf http://localhost:<caller-port>/.well-known/agent-card.json
```

A `POST /a2a/jsonrpc` without a bearer on either agent MUST answer 401 with a `WWW-Authenticate: Bearer` challenge. A token audienced at the caller MUST be refused by the target (401, `error="invalid_token"`). With a user token for the caller, one `SendMessage` through the caller returns the target's report whose `sub` is the user, whose `act.sub` is `<name>-caller`, and whose `aud` is the target's URL only.

`scripts/ci-verify.sh` runs the boot part of this (health, cards, 401 without a bearer) and is what CI runs.

## 4. What the agent MUST NOT do

- Bind either verifier without an audience; each agent accepts only tokens for its own URL.
- Forward the user's original token to the target. The target refuses it; only the exchanged token is accepted.
- Register the two agents in different zones. Cross-zone delegation is out of scope.
- Call a model; this template is about identity, not inference.

## 5. Handoff data

Report to the user: both agents' URLs, the two application identifiers, and the shape of the target's report (`sub`, `act`, `aud`).
