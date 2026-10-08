# a2a-delegation-python

Two Keycard-protected A2A agents (Python, `keycardai-a2a`) that show agent-to-agent delegation end to end: a **caller** that acts on a user's behalf and a **target** that reports who it was called as.

- The **target** verifies the inbound Keycard token bound to its own resource and answers each message with the verified claims it received: `sub` (the user), `act` (the delegation chain the zone recorded) and `aud`.
- The **caller** accepts a user's token, discovers the target through its agent card, exchanges the user's token for one scoped to the target (RFC 8693, resource = the target, authenticated with the caller's own application credential), invokes the target, and returns its answer.

Neither agent calls a model. Both speak A2A protocol 1.0 (`SendMessage`, `A2A-Version: 1.0`, agent cards with `supportedInterfaces`). Single zone only: caller and target are registered in the same zone.

## Requirements

- Python 3.10+
- [uv](https://docs.astral.sh/uv/)
- A Keycard zone with two applications and two resources (see [SPEC.md](./SPEC.md))

## Setup

```bash
uv sync
cp .env.example .env
# Fill in KEYCARD_URL and the caller's KEYCARD_CLIENT_ID / KEYCARD_CLIENT_SECRET
```

## Run

Two processes, one per agent:

```bash
uv run uvicorn target_agent:app --host 0.0.0.0 --port 9101
uv run uvicorn caller_agent:app --host 0.0.0.0 --port 9100
```

Send a message through the caller with a zone token for the user audienced at the caller:

```bash
curl -s http://localhost:9100/a2a/jsonrpc \
  -H "Authorization: Bearer $USER_TOKEN" -H 'A2A-Version: 1.0' -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":"1","method":"SendMessage","params":{"message":{"messageId":"m1","role":"ROLE_USER","parts":[{"text":"who am I?"}]}}}'
```

The reply text ends with the target's report, for example
`{"sub": "<user>", "act": {"sub": "<caller application>", "sub_profile": "app"}, "aud": ["http://localhost:9101"], ...}`.

## Environment variables

| Variable | Description | Default |
|---|---|---|
| `KEYCARD_URL` | Zone issuer URL, e.g. `https://<id>.keycard.cloud` | required |
| `KEYCARD_CLIENT_ID` | The caller application's credential; authenticates the token exchange | required by the caller |
| `KEYCARD_CLIENT_SECRET` | Its secret | required by the caller |
| `CALLER_BASE_URL` | The caller's base URL and resource identifier; its verifier is bound to it | `http://localhost:9100` |
| `TARGET_BASE_URL` | The target's base URL and resource identifier; its verifier is bound to it, and the caller exchanges for it | `http://localhost:9101` |

## Endpoints (each agent)

| Path | Description |
|---|---|
| `GET /healthz` | Health check |
| `GET /.well-known/agent-card.json` | A2A 1.0 agent card |
| `GET /.well-known/oauth-protected-resource` | OAuth resource metadata (RFC 9728) |
| `GET /.well-known/oauth-authorization-server` | OAuth AS metadata (RFC 8414) |
| `POST /a2a/jsonrpc` | A2A JSON-RPC; a missing or foreign-audience bearer gets HTTP 401 with a `WWW-Authenticate: Bearer` challenge |

## How it maps to the SDK

| Piece | keycardai-a2a |
|---|---|
| Inbound verification bound to the agent's resource | `AuthProvider(audience=<own URL>)` + `KeycardAuthBackend(require_authentication=True)` on the `/a2a` mount |
| Verified caller in the executor | `KeycardServerCallContextBuilder` + `keycard_user(context)` |
| Agent card | `build_agent_card_from_config(AgentServiceConfig(...))` |
| Discovery | `ServiceDiscovery.get_service_card(target)` |
| Exchange and invoke | `DelegationClient.invoke_service(target, text, subject_token=user_token)` |

The contract is `specs/a2a/a2a-delegation.md` in keycard-sdk-spec. The SDK does not return the assembled `act` chain; the target reads it from the token it verified.
