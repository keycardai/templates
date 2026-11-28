# Delegated access on Cloudflare Workers

A local Worker verifies a user's Keycard bearer token and exchanges it for downstream access using a signed client assertion (RFC 7523), not a client secret.

## Run locally

Use Node.js 22.12 or later, npm, curl, and OpenSSL. Follow [SPEC.md](./SPEC.md) to provision Keycard.
No Cloudflare account or login is required.

```sh
npm ci
npm run build
(umask 077; cp .env.example .dev.vars)
# Fill in .dev.vars per SPEC.md, then:
npm run dev
```

Wrangler reads `.dev.vars` in the project directory in local mode. Keep the PEM
inside double quotes, including its BEGIN and END lines. The actual vars file is
gitignored; do not put credentials in `.env.example` or `wrangler.jsonc`.
Local mode uses Miniflare and binds to `127.0.0.1:8787`. Override the port
with `npm run dev -- --port <port>` and use the corresponding registered
resource identifier if changing the local resource URL.

```sh
curl -fsS http://127.0.0.1:8787/healthz
curl -fsS -H "Authorization: Bearer ${USER_ACCESS_TOKEN}" http://127.0.0.1:8787/call
```

Health returns `ok`. Use a user token minted for the Worker's resource, not
for the downstream resource. The authenticated request returns the downstream
status and body. Without a bearer token, `/call` returns `401` and a Bearer challenge.
Each Worker isolate initializes the Keycard handler and token cache lazily on
its first request other than `GET /healthz` and reuses them until a binding changes.

## Configuration

All Worker bindings are required and have no default.

| Binding | Purpose |
|---|---|
| `KEYCARD_ISSUER` | Zone OAuth issuer for metadata, bearer verification, and exchange |
| `KEYCARD_PRIVATE_KEY` | RSA private key in PKCS#8 PEM format |
| `KEYCARD_CLIENT_ID` | Identifier of the application's public-key credential |
| `KEYCARD_WORKER_RESOURCE` | Exact resource identifier for `/call` and expected inbound token audience |
| `KEYCARD_RESOURCE_URL` | Exact downstream resource identifier and HTTP endpoint to call |
