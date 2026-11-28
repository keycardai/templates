import { pathToFileURL } from "node:url";
import { join } from "node:path";
import { decodeJwtPayload } from "./impersonate.js";
import type { StubRequestRecord } from "./calendar-stub.js";

export interface Check {
  label: string;
  ok: boolean;
}

export interface WorkerEnv {
  KEYCARD_ISSUER: string;
  KEYCARD_PRIVATE_KEY: string;
  KEYCARD_CLIENT_ID: string;
  KEYCARD_WORKER_RESOURCE: string;
  KEYCARD_RESOURCE_URL: string;
}

export function readQuickTunnelUrl(output: string): string | undefined {
  return output.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com(?=\s|$)/i)?.[0];
}

export async function matchesPublicKey(jwksUrl: string, expected: { n?: string; e?: string }): Promise<boolean> {
  const response = await fetch(jwksUrl, { signal: AbortSignal.timeout(5_000), redirect: "error" });
  if (!response.ok) return false;
  const { keys } = await response.json() as { keys?: Record<string, unknown>[] };
  return keys?.length === 1 && keys.some((key) => key.alg === "RS256" && key.kty === "RSA" &&
    Boolean(expected.n && expected.e) && key.n === expected.n && key.e === expected.e &&
    !["d", "p", "q", "dp", "dq", "qi", "oth"].some((field) => field in key));
}

export async function verifyWorker(opts: {
  workerResource: string;
  downstreamResource: string;
  userToken: string;
  userIdentifier: string;
  requests: StubRequestRecord[];
}): Promise<Check[]> {
  const { workerResource, downstreamResource, userToken, userIdentifier, requests } = opts;
  const first = requests.length;
  const response = await fetch(workerResource, {
    headers: { Authorization: `Bearer ${userToken}` },
    signal: AbortSignal.timeout(30_000),
    redirect: "error",
  });
  const body = response.status === 200
    ? await response.json() as { kind?: string }
    : (await response.body?.cancel(), undefined);
  const verified = requests.slice(first).find((request) => request.status === 200);
  const denied = await fetch(workerResource, { signal: AbortSignal.timeout(5_000), redirect: "error" });
  await denied.body?.cancel();
  const aud = verified?.claims?.aud;
  return [
    { label: `Worker returned the stub response (HTTP ${response.status})`, ok: response.status === 200 && body?.kind === "calendar#events" },
    { label: "Stub verified the exchanged token against the zone JWKS", ok: !!verified?.claims },
    { label: "Exchanged token aud is the downstream resource", ok: aud === downstreamResource || (Array.isArray(aud) && aud.includes(downstreamResource)) },
    { label: "Exchanged token sub is the test user", ok: verified?.claims?.sub === userIdentifier },
    { label: "Missing bearer token returns 401 with a challenge", ok: denied.status === 401 &&
        /^Bearer\b/i.test(denied.headers.get("WWW-Authenticate") ?? "") },
  ];
}

export async function verifyClientAssertion(templateDir: string, env: WorkerEnv): Promise<Check[]> {
  const { createTokenCache } = await import(pathToFileURL(join(templateDir, "worker.ts")).href) as {
    createTokenCache: (env: WorkerEnv) => {
      getToken(subject: string, token: string, resource: string): Promise<unknown>;
    };
  };
  const fetchReal = globalThis.fetch;
  const issuer = new URL(env.KEYCARD_ISSUER);
  const discoveryUrl = new URL(`/.well-known/oauth-authorization-server${issuer.pathname.replace(/\/$/, "")}`, issuer).href;
  const discovery = await fetchReal(discoveryUrl, { signal: AbortSignal.timeout(10_000) });
  if (!discovery.ok) throw new Error(`Assertion endpoint discovery failed: ${discovery.status}`);
  const metadata = await discovery.json() as { token_endpoint?: string };
  const tokenEndpoint = metadata.token_endpoint;
  if (!tokenEndpoint) throw new Error("Zone discovery did not return token_endpoint");

  let assertion: Record<string, unknown> | undefined;
  let assertionOnly = false;
  globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    if (request.url === discoveryUrl && request.method === "GET") {
      return Response.json(metadata);
    }
    if (request.url !== tokenEndpoint || request.method !== "POST") {
      throw new Error("Unexpected fetch from the assertion check");
    }
    const form = new URLSearchParams(await request.text());
    const jwt = form.get("client_assertion");
    if (jwt) assertion = decodeJwtPayload(jwt);
    assertionOnly = Boolean(jwt) && !request.headers.has("Authorization") && !form.has("client_secret") &&
      form.get("client_assertion_type") === "urn:ietf:params:oauth:client-assertion-type:jwt-bearer";
    return Response.json({ access_token: "not-a-real-token", token_type: "Bearer", expires_in: 60 });
  };
  try {
    await createTokenCache(env).getToken("capture-subject", "not-a-real-subject-token", env.KEYCARD_RESOURCE_URL);
  } finally {
    globalThis.fetch = fetchReal;
  }
  return [
    { label: "Token exchange uses a client assertion without a client secret", ok: assertionOnly },
    { label: "Assertion iss equals the client ID", ok: assertion?.iss === env.KEYCARD_CLIENT_ID },
    { label: "Assertion sub equals the client ID", ok: assertion?.sub === env.KEYCARD_CLIENT_ID },
    { label: "Assertion aud equals the discovered zone token endpoint", ok: assertion?.aud === tokenEndpoint },
  ];
}
