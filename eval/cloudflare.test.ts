import assert from "node:assert/strict";
import test from "node:test";
import { matchesPublicKey, readQuickTunnelUrl, redactProcessOutput, verifyWorker } from "./verify-cloudflare.js";
import type { StubRequestRecord } from "./calendar-stub.js";
import { cloudflareProvisioning } from "./provision-cloudflare.js";
import { evalOrigin } from "./run-identity.js";

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

test("redacts bearer tokens, assertions, and PEM keys without hiding error descriptions", () => {
  const output = "\x1b[31mOAuthError invalid_client: assertion verification failed\x1b[0m\n" +
    "Authorization: Bearer fixture-token\nclient_assertion=eyJfixture.payload.signature\n" +
    "-----BEGIN PRIVATE KEY-----\nfixture-key\n-----END PRIVATE KEY-----\n";
  assert.equal(redactProcessOutput(output),
    "OAuthError invalid_client: assertion verification failed\n" +
    "Authorization: Bearer [redacted]\nclient_assertion=[redacted JWT]\n[redacted PEM]\n");
});

test("checks the fresh downstream request, including the expected user, resource and credential", async (t) => {
  const downstreamResource = "https://resource.example.test/calendar";
  const opts = {
    workerUrl: "http://127.0.0.1:8787/call",
    downstreamResource,
    userToken: "synthetic-user-token",
    userIdentifier: "test-user",
    clientId: "fixture-worker-client",
  };
  const record = {
    method: "GET", path: "/calendar", status: 200,
    claims: { sub: opts.userIdentifier, aud: [downstreamResource], client_id: opts.clientId },
  };
  const requests: StubRequestRecord[] = [record];
  let current = record;
  t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    assert.equal(url, opts.workerUrl);
    if (!init.headers) return new Response(null, { status: 401, headers: { "WWW-Authenticate": "Bearer" } });
    requests.push(current);
    return Response.json({ kind: "calendar#events" });
  });
  assert.deepEqual((await verifyWorker({ ...opts, requests })).map(({ ok }) => ok), [true, true, true, true, true, true]);
  const log = t.mock.method(console, "log", () => undefined);
  current = { ...record, claims: { sub: "different-user", aud: ["https://other.example.test/"], client_id: "harness-client" } };
  assert.deepEqual((await verifyWorker({ ...opts, requests })).map(({ ok }) => ok), [true, true, false, false, false, true]);
  assert.deepEqual(log.mock.calls[0]?.arguments, ["Verified stub token claim names:", '["aud","client_id","sub"]']);
});

test("creates per-run Cloudflare resources without looking up or deleting existing resources", async (t) => {
  const endpoint = process.env.CI_KEYCARD_ENDPOINT;
  process.env.CI_KEYCARD_ENDPOINT = "https://management.example.test";
  t.after(() => {
    if (endpoint === undefined) delete process.env.CI_KEYCARD_ENDPOINT;
    else process.env.CI_KEYCARD_ENDPOINT = endpoint;
  });
  const runId = "delegated-access-typescript-cloudflare--123-1";
  const workerResource = `${evalOrigin(runId, 8787)}/call`;
  const downstreamResource = `${evalOrigin(runId, 8901)}/calendars/primary/events`;
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
    if (method === "POST" && path === "resources") {
      const { name, identifier } = JSON.parse(String(options?.body)) as { name: string; identifier: string };
      changes.push(`create ${name} ${identifier}`);
      return Response.json({ id: identifier === workerResource ? "worker" : "downstream" });
    }
    if (method === "PUT" && path.startsWith("applications/app/dependencies/")) {
      return new Response(null, { status: 204 });
    }
    if (path === "policy-sets") throw new Error("Reached permit setup");
    assert.fail(`Unexpected management call: ${method} ${path}`);
  });
  const provision = cloudflareProvisioning("test", "fixture-management-token");
  await assert.rejects(provision.provision({ runId, workerResource, downstreamResource }), /Reached permit setup/);
  assert.deepEqual(changes, [
    `create eval-resource-worker-${runId} ${workerResource}`,
    `create eval-resource-downstream-${runId} ${downstreamResource}`,
  ]);
});
