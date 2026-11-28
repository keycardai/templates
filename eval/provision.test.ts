import assert from "node:assert/strict";
import test from "node:test";
import { EvalProvisioning, provision } from "./provision.js";
import { addLoopbackProxyExclusion, evalOrigin, evalRunId } from "./run-identity.js";

test("jobs, reruns and local invocations get distinct resource URLs without changing the route", () => {
  const ci = { GITHUB_RUN_ID: "123", GITHUB_RUN_ATTEMPT: "1" };
  const runs = [
    evalRunId("mcp-server-go", ci),
    evalRunId("mcp-server-ruby", ci),
    evalRunId("mcp-server-go", { ...ci, GITHUB_RUN_ATTEMPT: "2" }),
    evalRunId("mcp-server-go", { ...ci, GITHUB_RUN_ID: "124" }),
    evalRunId("mcp-server-go", {}),
    evalRunId("mcp-server-go", {}),
  ];
  const resources = runs.map((run) => `${evalOrigin(run, 8000)}/mcp`);
  assert.equal(new Set(resources).size, runs.length);
  assert.equal(resources[0], "http://mcp-server-go.123-1.localhost:8000/mcp");
  for (const resource of resources) assert.equal(new URL(resource).pathname, "/mcp");
});

test("the loopback proxy exclusion leaves wildcards intact", () => {
  const host = "mcp-server-go.123-1.localhost";
  const wildcard = { NO_PROXY: "*", no_proxy: "example.test, * " };
  addLoopbackProxyExclusion(wildcard, host);
  assert.deepEqual(wildcard, { NO_PROXY: "*", no_proxy: "example.test, * " });

  const exclusions = { NO_PROXY: "example.test" };
  addLoopbackProxyExclusion(exclusions, host);
  assert.deepEqual(exclusions, {
    NO_PROXY: `example.test,${host}`,
    no_proxy: `example.test,${host}`,
  });
});

test("the stale sweep only deletes old per-run entities and tolerates failed deletes", async (t) => {
  const oldEndpoint = process.env.CI_KEYCARD_ENDPOINT;
  process.env.CI_KEYCARD_ENDPOINT = "https://api.example.test";
  t.after(() => {
    if (oldEndpoint === undefined) delete process.env.CI_KEYCARD_ENDPOINT;
    else process.env.CI_KEYCARD_ENDPOINT = oldEndpoint;
  });

  const old = "2026-11-27T11:59:59Z";
  const deleted: string[] = [];
  const warned = t.mock.method(console, "warn", () => undefined);
  t.mock.method(globalThis, "fetch", async (input: string, init: RequestInit) => {
    const url = new URL(input);
    if (init.method === "DELETE") {
      deleted.push(url.pathname);
      return new Response(null, { status: url.pathname.endsWith("/old-app") ? 500 : 204 });
    }

    switch (url.pathname) {
      case "/zones/fixture/resources":
        assert.equal(url.searchParams.get("query[name]"), "eval-resource-");
        if (url.searchParams.get("after") === "next") {
          return Response.json({ items: [
            { id: "old-resource", name: "eval-resource-caller-a2a-delegation-python--121-1", created_at: old },
          ], pagination: { after_cursor: null } });
        }
        return Response.json({ items: [
          { id: "fresh", name: "eval-resource-mcp-server-go--123-1", created_at: "2026-11-27T12:00:00Z" },
          { id: "other", name: "other-eval-resource-mcp-server-go--122-1", created_at: old },
          { id: "legacy", name: "eval-resource-1732660000000", created_at: old },
          { id: "unknown-age", name: "eval-resource-mcp-server-go--122-1" },
        ], pagination: { after_cursor: "next" } });
      case "/zones/fixture/applications":
        assert.equal(url.searchParams.get("query[name]"), "eval-app-");
        return Response.json({ items: [
          { id: "old-app", name: "eval-app-mcp-server-go--20953048-f8d3-4233-920b-d0237ecc4392", created_at: old },
        ], pagination: { after_cursor: null } });
      default:
        assert.fail(`Unexpected request: ${url.pathname}`);
    }
  });

  const provisioning = new EvalProvisioning("fixture", "fixture-token");
  await provisioning.sweepStale(Date.parse("2026-11-28T00:00:00Z"));
  assert.deepEqual(deleted, ["/zones/fixture/resources/old-resource", "/zones/fixture/applications/old-app"]);
  assert.match(String(warned.mock.calls[0]?.arguments[0]), /Could not remove stale eval applications/);
});

test("partial provisioning failure deletes only the application it created", async (t) => {
  const oldEndpoint = process.env.CI_KEYCARD_ENDPOINT;
  process.env.CI_KEYCARD_ENDPOINT = "https://api.example.test";
  t.after(() => {
    if (oldEndpoint === undefined) delete process.env.CI_KEYCARD_ENDPOINT;
    else process.env.CI_KEYCARD_ENDPOINT = oldEndpoint;
  });

  const requests: string[] = [];
  t.mock.method(globalThis, "fetch", async (input: string, init: RequestInit) => {
    const request = `${init.method ?? "GET"} ${new URL(input).pathname}`;
    requests.push(request);
    switch (request) {
      case "GET /zones/fixture/providers":
        return Response.json({ items: [{ id: "sts", type: "keycard-sts" }] });
      case "POST /zones/fixture/applications":
        return Response.json({ id: "own-application" }, { status: 201 });
      case "POST /zones/fixture/application-credentials":
        return Response.json({ identifier: "fixture-client", password: "fixture-password" });
      case "POST /zones/fixture/resources":
        assert.equal(JSON.parse(init.body as string).identifier, "http://mcp-server-go.123-1.localhost:8000/mcp");
        return new Response(null, { status: 500 });
      case "DELETE /zones/fixture/applications/own-application":
        return new Response(null, { status: 204 });
      default:
        assert.fail(`Unexpected request: ${request}`);
    }
  });

  const provisioning = new EvalProvisioning("fixture", "fixture-token");
  await assert.rejects(provision({
    zoneId: "fixture",
    zoneIssuerUrl: "https://zone.example.test",
    runId: evalRunId("mcp-server-go", { GITHUB_RUN_ID: "123" }),
    token: "fixture-token",
    provisioning,
    templateDir: "unused",
    serverPort: 8000,
  }), /Create resources failed: 500/);
  await provisioning.cleanup();
  assert.deepEqual(requests, [
    "GET /zones/fixture/providers",
    "POST /zones/fixture/applications",
    "POST /zones/fixture/application-credentials",
    "POST /zones/fixture/resources",
    "DELETE /zones/fixture/applications/own-application",
  ]);
});
