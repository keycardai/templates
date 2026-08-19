# mcp-server-ruby

A minimal MCP server, integrated with Keycard identity, authentication and authorization, using [`keycardai-mcp`](https://rubygems.org/gems/keycardai-mcp), the official [`mcp` gem](https://github.com/modelcontextprotocol/ruby-sdk), and plain Rack.

This template is a plain Rack application. There is no scaffolding step — copy the directory, set `KEYCARD_URL`, and run.

## Run it

```bash
cp -R mcp-server-ruby my-mcp-server
cd my-mcp-server
bundle install
export KEYCARD_URL=https://your-zone.keycard.cloud
bundle exec rackup --port 8000
```

The server listens on `http://localhost:8000/mcp` and validates Keycard-minted JWTs against `KEYCARD_URL`.

No `Gemfile.lock` ships with the template, so `bundle install` resolves against your Ruby. Commit the lockfile your project generates.

## Configure

| Env var | Default | Purpose |
|---|---|---|
| `KEYCARD_URL` | _(required)_ | The zone's OIDC issuer URL. The verifier trusts tokens from it and resolves its JWKS. |
| `KEYCARD_RESOURCE_ID` | _(unset)_ | The registered Resource identifier, e.g. `http://localhost:8000/mcp`. When set, tokens minted for any other resource are rejected. |
| `PORT` | `8000` | Local HTTP port. |

Keycard configuration is read in `config.ru` and passed to the SDK explicitly. The gems read no environment variables of their own.

## Keycard provisioning

Before the server can accept requests, the zone needs an Application and a Resource for the `/mcp` endpoint, backed by the zone's `keycard-sts` provider. See [`SPEC.md`](./SPEC.md) for the exact primitives an agent should provision.

## Add a tool

Register another tool with `mcp_server.define_tool(name:, description:, input_schema:) { ... }` in `config.ru`, following the `hello` pattern. Tools are gated by the `mcp:tools` scope the bearer middleware enforces.

## Ruby version

Requires Ruby >= 3.2, matching `keycardai-mcp`.
