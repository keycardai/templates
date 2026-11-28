# TypeScript A2A delegation

A caller agent uses Keycard to exchange a user's token for one scoped to a target agent. The target verifies the delegated token and reports its subject (`sub`), actor (`act`), and audience (`aud`). Neither agent uses a language model.

## Run locally

Use Node.js 22.9 or later, npm, Bash, curl, and jq. Follow [SPEC.md](./SPEC.md) to provision both agents in one Keycard zone. Copy `.env.example` to `.env` and fill in the zone and caller credential.

```sh
npm ci
npm run build
npm run start:target
```

In another terminal in the same directory:

```sh
npm run start:caller
```

With a user access token issued by your zone for the caller's Resource, set `USER_ACCESS_TOKEN` in your shell and send an A2A 1.0 message:

```sh
curl -fsS http://localhost:9100/a2a/jsonrpc \
  -H "Authorization: Bearer $USER_ACCESS_TOKEN" \
  -H 'Content-Type: application/json' \
  -H 'A2A-Version: 1.0' \
  -d '{"jsonrpc":"2.0","id":"1","method":"SendMessage","params":{"message":{"messageId":"hello","role":"ROLE_USER","parts":[{"text":"who am I?"}]}}}' |
  jq -r '.result.message.parts[].text'
```

The returned JSON has `sub` equal to the user identifier, `act.sub` equal to the caller's **Application identifier** (not its credential ID), and `aud` containing only `http://localhost:9101`. Sending the original token directly to the target returns HTTP 401. Omit the bearer on either agent and it returns HTTP 401 with a `WWW-Authenticate: Bearer` challenge.

Stop both agents before running `npm run ci:verify`, which starts both and verifies their cards, resource metadata, and unauthenticated requests.

## Configuration

Both processes read `.env` if it exists; process environment values take precedence.

| Variable | Required by | Purpose and default |
| --- | --- | --- |
| `KEYCARD_URL` | Both | Zone OAuth issuer URL; no default. |
| `KEYCARD_CLIENT_ID` | Caller | Identifier of its Keycard password credential; no default. |
| `KEYCARD_CLIENT_SECRET` | Caller | Password of that credential; no default. |
| `CALLER_BASE_URL` | Caller | Public caller base URL and registered caller Resource identifier; no default. |
| `TARGET_BASE_URL` | Both | Target discovery URL and registered target Resource identifier; no default. |
| `CALLER_PORT` | Optional | Caller listen port; defaults to `9100`. |
| `TARGET_PORT` | Optional | Target listen port; defaults to `9101`. |

Set the base URLs without trailing slashes and use exactly those identifiers when registering the Resources. For `npm run ci:verify`, export the ports and base URLs in the shell if you need to override the localhost defaults. The target does not need the caller's credential.
