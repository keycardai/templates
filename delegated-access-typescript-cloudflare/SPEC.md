# SPEC: delegated-access-typescript-cloudflare

## Purpose

A local Cloudflare Worker receives a user token, authenticates as its own
Keycard application with a signed `private_key_jwt` assertion, and exchanges
the incoming token for delegated access to a protected HTTP resource.
The Worker initializes its Keycard handler and per-subject token cache once
per isolate, on the first request other than `GET /healthz`, and rebuilds
them if the bindings change.

## Keycard provisioning

1. Use a Keycard zone and its Zone Provider. Create an Application for the
   Worker. In headless eval the harness sets implicit consent.
2. Create a native HTTP Resource for `GET /call` owned by that Application,
   with the Zone Provider as its credential provider. For the default local
   port in a private zone use `http://127.0.0.1:8787/call`. In the
   [shared test zone](../docs/shared-test-zone.md), use a unique identifier
   instead. The exact identifier is the required inbound token audience,
   independent of the URL the caller uses to reach the Worker.
3. Create a second native HTTP Resource for the downstream GET endpoint
   using the Zone Provider. Use its exact registered identifier for token
   exchange and, by default, the HTTP request. Set `KEYCARD_RESOURCE_ENDPOINT`
   if the HTTP request must go to a different URL. Add the downstream
   Resource as an Application dependency. The
   endpoint must verify Keycard bearer tokens for its own audience and must
   not echo credentials. The eval harness registers both audiences on a
   per-run `*.localhost` hostname, but probes the Worker and calls the
   downstream stub on `127.0.0.1`.
4. Generate a fresh RSA 2048 PKCS#8 key with `openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048`
   and store it only in the private, gitignored `.dev.vars` file. Choose the
   application's public-key credential identifier before starting the Worker
   and use it for `KEYCARD_CLIENT_ID`. Start the Worker and expose its
   `/.well-known/jwks.json` at a public HTTPS URL reachable by the zone.
   The harness uses an anonymous cloudflared quick tunnel to the local
   Worker. Register the public-key credential on the Application with
   the chosen identifier and the public HTTPS JWKS URL as `jwks_uri`.
5. Obtain a user token for the Worker's Resource. Eval mints it by
   impersonation with a separate password credential held only by the
   harness. For that mint, the harness also adds the Worker Resource as
   a dependency and ensures its standing eval impersonation permit.

No custom policy is needed for the ordinary delegated exchange under the
zone's default on-behalf-of access policy. In eval, the existing scoped
Cedar policy in [eval/policy.ts](../eval/policy.ts) permits the separate
headless impersonation mint; do not broaden it.

## Configuration to write

Use `.env.example` as the list of bindings, but write the real values to
gitignored `.dev.vars` (mode 0600), not to `.env`. Bindings are required
unless marked optional:

| Key | Value |
|---|---|
| `KEYCARD_ISSUER` | OAuth issuer from the Keycard zone |
| `KEYCARD_PRIVATE_KEY` | Fresh PKCS#8 PEM enclosed in double quotes |
| `KEYCARD_CLIENT_ID` | Identifier chosen for the public-key credential |
| `KEYCARD_WORKER_RESOURCE` | Exact identifier of the Resource owned by the Worker Application |
| `KEYCARD_RESOURCE_URL` | Exact identifier of the downstream Resource and its default HTTP endpoint |
| `KEYCARD_RESOURCE_ENDPOINT` | Optional HTTP endpoint when it differs from the registered downstream identifier |

In `keycard.toml`, set `[org] id` and `[zone] id` to the selected Keycard
org and zone IDs. Leave `[credentials]` empty.

## Verification

```sh
npm ci
npm run build
npm run dev
```

In another shell, run the smoke test (replace the base URL if the port changed):

```sh
curl -fsS http://127.0.0.1:8787/healthz
curl -fsS http://127.0.0.1:8787/.well-known/oauth-protected-resource/call
curl -fsS http://127.0.0.1:8787/.well-known/jwks.json
curl -si http://127.0.0.1:8787/call
curl -fsS -H "Authorization: Bearer ${USER_ACCESS_TOKEN}" http://127.0.0.1:8787/call
```

Expect `ok`, metadata with the exact Worker resource and zone issuer, a
public RS256 JWK derived from the private key, `401` with a
`WWW-Authenticate: Bearer` challenge, and finally the downstream's successful
response with a correctly audienced user token.

## What the agent must not do

Do not invent resource identifiers, commit credentials, log keys or tokens,
set a Worker client secret, change zone sign-in, providers, invite or user
settings, or create Cloudflare account resources. Do not run `wrangler login`
or deploy; the build command only runs Wrangler in dry-run mode.

## Handoff

Report the zone issuer, Application and Resource identifiers, local URL,
and verification results. Never include private keys, assertions, or tokens.
