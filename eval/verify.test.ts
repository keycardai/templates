import assert from "node:assert/strict";
import test from "node:test";
import { verifyServer } from "./verify.js";

test("MCP verification probes localhost without changing the advertised OAuth resource", async (t) => {
  const local = "http://localhost:8000";
  const registered = "http://mcp-server-go.123-1.localhost:8000";
  const requests: string[] = [];
  t.mock.method(globalThis, "fetch", async (input: string, init?: RequestInit) => {
    const url = new URL(input);
    assert.equal(url.origin, local);
    requests.push(url.pathname + url.search);
    switch (url.pathname) {
      case "/healthz":
        return new Response(null, { status: 200 });
      case "/mcp":
        return new Headers(init?.headers).has("Authorization")
          ? new Response(null, { status: 400 })
          : new Response(null, {
            status: 401,
            headers: { "WWW-Authenticate": `Bearer resource_metadata="${registered}/.well-known/oauth-protected-resource/mcp?example=1"` },
          });
      case "/.well-known/oauth-protected-resource/mcp":
        return Response.json({ resource: `${registered}/mcp` });
      case "/.well-known/oauth-authorization-server":
        return Response.json({ issuer: "https://zone.example.test" });
      case "/broker":
        return new Response(null, { status: 404 });
      default:
        assert.fail(`Unexpected request: ${input}`);
    }
  });

  const result = await verifyServer({
    serverUrl: local,
    resourceIdentifier: `${registered}/mcp`,
    accessToken: "fixture-token",
  });
  assert.equal(result.passed, true);
  assert.ok(requests.includes("/.well-known/oauth-protected-resource/mcp?example=1"));
});
