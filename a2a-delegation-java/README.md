# a2a-delegation-java

Two A2A 1.0 agents in one Gradle project. The caller verifies a user's Keycard token, exchanges it for a token scoped to the target, and sends the message using `DelegationClient`. The target verifies its token and reports the subject, actor chain and audience.

## Run locally

Use JDK 17 or newer, `curl`, and `jq`. Follow [SPEC.md](./SPEC.md) to provision Keycard.

```bash
cp .env.example .env
# Edit .env to match the provisioned zone and Resources.
./gradlew installDist
```

In one terminal, start the target.

```bash
set -a
source .env
set +a
PORT=9101 ./build/install/a2a-delegation-java/bin/a2a-delegation-java target
```

In a second terminal, start the caller.

```bash
set -a
source .env
set +a
# Inject KEYCARD_CLIENT_ID and KEYCARD_CLIENT_SECRET from your secret store.
PORT=9100 ./build/install/a2a-delegation-java/bin/a2a-delegation-java caller
```

Get a Keycard user access token for `CALLER_BASE_URL` through your authorized OAuth client. With that token in `USER_ACCESS_TOKEN`, send a message to the caller.

```bash
curl -fsS "$CALLER_BASE_URL/a2a/jsonrpc" \
  -H "Authorization: Bearer $USER_ACCESS_TOKEN" \
  -H 'Content-Type: application/json' -H 'A2A-Version: 1.0' \
  --data '{"jsonrpc":"2.0","id":"demo","method":"SendMessage","params":{"message":{"messageId":"demo","role":"ROLE_USER","parts":[{"text":"who am I?"}]}}}' |
  jq '.result.message.parts[0].text | fromjson'
```

The report has `sub` equal to your user identifier, `act.sub` equal to the caller's Application identifier, and `aud` containing only `TARGET_BASE_URL`.

## Configuration

| Env var | Default | Purpose |
|---|---|---|
| `KEYCARD_URL` | Required | Shared Keycard zone's OIDC issuer URL. |
| `CALLER_BASE_URL` | Required for caller | Caller Resource URL, without a path. |
| `TARGET_BASE_URL` | Required for both | Target Resource URL, without a path. |
| `KEYCARD_CLIENT_ID` | Required for caller | Caller Application's OAuth client ID. |
| `KEYCARD_CLIENT_SECRET` | Required for caller | Caller Application's OAuth client secret. |
| `PORT` | `9100` for caller, `9101` for target | Listen port for the process. |

Each process exports its own agent card at `/.well-known/agent-card.json`. The card advertises its public base URL with `/a2a/jsonrpc` appended. If you change a local port, update the corresponding URL and registered Resource.
