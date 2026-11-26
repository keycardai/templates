# a2a-delegation-java

Two Keycard-protected A2A agents (Java, `ai.keycard:keycard-a2a`) that show agent-to-agent delegation end to end: a **caller** that acts on a user's behalf and a **target** that reports who it was called as. It's the Java counterpart of [`a2a-delegation-python`](../a2a-delegation-python) and answers the same way.

- The **target** verifies the inbound Keycard token bound to its own resource and answers each message with the verified claims it received: `sub` (the user), `act` (the delegation chain the zone recorded) and `aud`.
- The **caller** accepts a user's token, discovers the target through its agent card, exchanges the user's token for one scoped to the target (RFC 8693, resource = the target, authenticated with the caller's own application credential) with `DelegationClient`, invokes the target, and returns its answer.

Neither agent calls a model. Both speak A2A protocol 1.0 (`SendMessage`, `A2A-Version: 1.0`, agent cards with `supportedInterfaces`). Single zone only: caller and target are registered in the same zone.

## Requirements

- JDK 17+ (the Gradle wrapper downloads Gradle)
- A Keycard zone with two applications and two resources (see [SPEC.md](./SPEC.md))

## Setup

```bash
./gradlew installDist
cp .env.example .env
# Fill in KEYCARD_URL and the caller's KEYCARD_CLIENT_ID / KEYCARD_CLIENT_SECRET
```

## Run

Two processes from one start script, picked by the first argument. The program reads the process environment only, so load `.env` into the shell first:

```bash
set -a; . ./.env; set +a
./build/install/a2a-delegation-java/bin/a2a-delegation-java target &
./build/install/a2a-delegation-java/bin/a2a-delegation-java caller &
```

Each agent listens on the port of its base URL. Send a message through the caller with a zone token for the user audienced at the caller:

```bash
curl -s http://localhost:9100/a2a/jsonrpc \
  -H "Authorization: Bearer $USER_TOKEN" -H 'A2A-Version: 1.0' -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":"1","method":"SendMessage","params":{"message":{"messageId":"m1","role":"ROLE_USER","parts":[{"text":"who am I?"}]}}}'
```

The reply text ends with the target's report, for example
`{"sub":"<user>","act":{"sub":"<caller application>","sub_profile":"app"},"aud":["http://localhost:9101"],...}`.

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

| Piece | Keycard Java SDK |
|---|---|
| Inbound verification bound to the agent's resource | `TokenVerifier.builder(zone).audiences(<own URL>)` + `RequireBearerAuthFilter` (`keycard-mcp`) on `/a2a/jsonrpc` |
| Verified caller in the handler | `KeycardRequest.accessToken(request)` |
| Resource metadata | `ProtectedResourceMetadataServlet`, `AuthorizationServerMetadataServlet` |
| Discovery, exchange and invoke | `DelegationClient.invoke(target, userToken, A2aProtocol.textMessage(text))` (`keycard-a2a`) |

The contract is `specs/a2a/a2a-delegation.md` in keycard-sdk-spec. The SDK does not return the assembled `act` chain; the target reads it from the token it verified.
