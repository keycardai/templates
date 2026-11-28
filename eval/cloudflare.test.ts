import assert from "node:assert/strict";
import test from "node:test";
import { matchesPublicKey, readQuickTunnelUrl, verifyWorker } from "./verify-cloudflare.js";
import type { StubRequestRecord } from "./calendar-stub.js";
import { cloudflareProvisioning } from "./provision-cloudflare.js";

test("finds the quick tunnel URL in cloudflared output, not the signup URL", () => {
  assert.equal(readQuickTunnelUrl("INF requesting Tunnel on trycloudflare.com"), undefined);
  assert.equal(readQuickTunnelUrl("https://sample.trycloudflare.com.example.test"), undefined);
  assert.equal(
    readQuickTunnelUrl("INF |  https://sample-1.trycloudflare.com   |"),
    "https://sample-1.trycloudflare.com",
  );
});

test("requires the exact RSA public key and rejects private JWK data", async (t) => {
  const key = { alg: "RS256", kty: "RSA", n: "modulus", e: "AQAB" };
  let keys: object[] = [key];
  t.mock.method(globalThis, "fetch", async () => Response.json({ keys }));
  assert.equal(await matchesPublicKey("https://sample.trycloudflare.com/.well-known/jwks.json", key), true);
  keys = [{ ...key, n: "different" }];
  assert.equal(await matchesPublicKey("https://sample.trycloudflare.com/.well-known/jwks.json", key), false);
  keys = [{ ...key, d: "private" }];
  assert.equal(await matchesPublicKey("https://sample.trycloudflare.com/.well-known/jwks.json", key), false);
});

test("checks the fresh downstream request, including the expected user and resource", async (t) => {
  const downstreamResource = "https://resource.example.test/calendar";
  const opts = {
    workerResource: "https://worker.example.test/call",
    downstreamResource,
    userToken: "synthetic-user-token",
    userIdentifier: "test-user",
  };
  const record = { method: "GET", path: "/calendar", status: 200, claims: { sub: opts.userIdentifier, aud: [downstreamResource] } };
  const requests: StubRequestRecord[] = [record];
  let current = record;
  t.mock.method(globalThis, "fetch", async (_url: string, init: RequestInit) => {
    if (!init.headers) return new Response(null, { status: 401, headers: { "WWW-Authenticate": "Bearer" } });
    requests.push(current);
    return Response.json({ kind: "calendar#events" });
  });
  assert.deepEqual((await verifyWorker({ ...opts, requests })).map(({ ok }) => ok), [true, true, true, true, true]);
  current = { ...record, claims: { sub: "different-user", aud: ["https://other.example.test/"] } };
  assert.deepEqual((await verifyWorker({ ...opts, requests })).map(({ ok }) => ok), [true, true, false, false, true]);
});

test("removes resources with matching identifiers before provisioning replacements", async (t) => {
  const endpoint = process.env.CI_KEYCARD_ENDPOINT;
  process.env.CI_KEYCARD_ENDPOINT = "https://management.example.test";
  t.after(() => {
    if (endpoint === undefined) delete process.env.CI_KEYCARD_ENDPOINT;
    else process.env.CI_KEYCARD_ENDPOINT = endpoint;
  });
  const workerResource = "http://127.0.0.1:8787/call";
  const downstreamResource = "http://127.0.0.1:8901/calendars/primary/events";
  const changes: string[] = [];
  t.mock.method(globalThis, "fetch", async (url: string, options?: RequestInit) => {
    const path = new URL(url).pathname.replace("/zones/test/", "");
    const method = options?.method ?? "GET";
    if (method === "GET" && path === "providers") {
      return Response.json({ items: [{ id: "provider", type: "keycard-sts" }] });
    }
    if (method === "POST" && path === "applications") return Response.json({ id: "app" });
    if (method === "POST" && path === "application-credentials") {
      return Response.json({ id: "password", identifier: "fixture-id", password: "fixture-password" });
    }
    if (method === "GET" && path === "resources") {
      return Response.json({ items: [
        { id: "stale-worker", identifier: workerResource },
        { id: "stale-downstream", identifier: downstreamResource },
      ] });
    }
    if (method === "DELETE" && path.startsWith("resources/")) {
      changes.push(`delete ${path}`);
      return new Response(null, { status: 204 });
    }
    if (method === "POST" && path === "resources") {
      const { identifier } = JSON.parse(String(options?.body)) as { identifier: string };
      changes.push(`create ${identifier}`);
      return Response.json({ id: identifier === workerResource ? "worker" : "downstream" });
    }
    if (method === "PUT" && path.startsWith("applications/app/dependencies/")) {
      return new Response(null, { status: 204 });
    }
    throw new Error("Reached permit setup");
  });
  const provision = cloudflareProvisioning("test", "fixture-management-token");
  await assert.rejects(provision.provision({ runId: "fixture", workerResource, downstreamResource }), /Reached permit setup/);
  assert.deepEqual(changes, [
    "delete resources/stale-worker", `create ${workerResource}`,
    "delete resources/stale-downstream", `create ${downstreamResource}`,
  ]);
});
