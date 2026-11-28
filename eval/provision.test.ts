import assert from "node:assert/strict";
import test from "node:test";
import { EvalProvisioning, provision } from "./provision.js";
import { evalOrigin, evalRunId } from "./run-identity.js";

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
