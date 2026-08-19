# frozen_string_literal: true

# A minimal Keycard-protected MCP server: Rack plus the official
# modelcontextprotocol/ruby-sdk `mcp` gem for the MCP transport, with Keycard
# providing the OAuth metadata endpoints and bearer-token middleware via
# keycardai-mcp.
#
# It exposes one tool, "hello". The point is the protocol plumbing around it:
# the .well-known OAuth metadata, the bearer middleware that validates
# Keycard-minted JWTs, and a scope-gated /mcp endpoint. Configure KEYCARD_URL
# (the zone's OIDC issuer) and run.
#
# Configuration is read here, in application code, and passed to the SDK
# explicitly. The SDK itself reads no environment variables.

require "json"
require "keycardai/mcp"
require "mcp"

KEYCARD_URL = ENV.fetch("KEYCARD_URL") do
  abort("KEYCARD_URL environment variable is required (the zone's OIDC issuer URL)")
end

# The registered Resource identifier, e.g. http://localhost:8000/mcp. When set,
# the verifier rejects tokens minted for any other resource.
RESOURCE_ID = ENV.fetch("KEYCARD_RESOURCE_ID", nil)

# 1. Build the MCP server and register tools. This is the official gem only;
# Keycard is not involved here. Add your own tools alongside hello.
mcp_server = MCP::Server.new(name: "mcp-server-ruby", version: "1.0.0")
mcp_server.define_tool(
  name: "hello",
  description: "Say hello to a name.",
  input_schema: { properties: { name: { type: "string" } }, required: [] },
) do |name: "world", server_context: nil|
  MCP::Tool::Response.new([{ type: "text", text: "Hello, #{name}!" }])
end

# 2. The verifier trusts only tokens issued by this Keycard zone and resolves
# their signing keys from the zone's JWKS, caching per (issuer, kid).
verifier = Keycardai::OAuth::TokenVerifier.new(issuers: KEYCARD_URL, audiences: RESOURCE_ID)

# 3a. OAuth metadata so MCP clients can discover how to authenticate.
metadata = Keycardai::MCP::MetadataApp.new(
  issuer: KEYCARD_URL,
  resource_name: "mcp-server-ruby",
  scopes_supported: ["mcp:tools"],
)

mcp_endpoint = lambda do |env|
  body = env["rack.input"].read
  [200, { "content-type" => "application/json" }, [mcp_server.handle_json(body)]]
end

# 3b. Protect /mcp with bearer auth scoped to mcp:tools. An unauthenticated
# request gets a 401 with an RFC 6750 challenge advertising resource_metadata,
# which is how a client discovers where to authenticate.
protected_mcp = Keycardai::MCP::RequireBearerAuth.new(
  mcp_endpoint, verifier: verifier, required_scopes: ["mcp:tools"],
)

run lambda { |env|
  case env["PATH_INFO"]
  # 3c. Unauthenticated liveness probe used by the smoke test.
  when "/healthz"
    [200, { "content-type" => "application/json" }, [JSON.dump({ "status" => "ok" })]]
  when %r{\A/\.well-known/}
    metadata.call(env)
  when "/mcp"
    protected_mcp.call(env)
  else
    [404, { "content-type" => "application/json" }, [JSON.dump({ "error" => "not_found" })]]
  end
}
