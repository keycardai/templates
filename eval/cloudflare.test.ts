import assert from "node:assert/strict";
import test from "node:test";
import { matchesPublicKey, readQuickTunnelUrl, verifyWorker } from "./verify-cloudflare.js";
import type { StubRequestRecord } from "./calendar-stub.js";

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
