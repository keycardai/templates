import { createKeycardWorker, IsolateSafeTokenCache, resolveCredential } from "@keycardai/cloudflare";
import { TokenExchangeClient } from "@keycardai/oauth/tokenExchange";

interface Env {
  KEYCARD_ISSUER: string;
  KEYCARD_PRIVATE_KEY: string;
  KEYCARD_CLIENT_ID: string;
  KEYCARD_RESOURCE_URL: string;
  KEYCARD_WORKER_RESOURCE: string;
}

export function createTokenCache(env: Env) {
  if (!env.KEYCARD_PRIVATE_KEY || !env.KEYCARD_CLIENT_ID) {
    throw new Error("Missing Web Identity bindings");
  }
  const credential = resolveCredential(env);
  return new IsolateSafeTokenCache(new TokenExchangeClient(env.KEYCARD_ISSUER, { credential }), { credential });
}

function buildProtectedWorker(env: Env) {
  const cache = createTokenCache(env);
  return createKeycardWorker<Env>({
    resourceIdentifier: env.KEYCARD_WORKER_RESOURCE,
    fetch: async (request, env, _ctx, auth) => {
      if (request.method !== "GET" || new URL(request.url).pathname !== "/call") {
        return new Response("Not found", { status: 404 });
      }
      if (!auth.subject) return new Response("Missing token subject", { status: 401 });

      const token = await cache.getToken(auth.subject, auth.token, env.KEYCARD_RESOURCE_URL);
      const downstream = await fetch(env.KEYCARD_RESOURCE_URL, {
        headers: { Authorization: `Bearer ${token.accessToken}` },
        redirect: "manual",
      });
      return new Response(downstream.body, {
        status: downstream.status,
        headers: { "Content-Type": downstream.headers.get("Content-Type") ?? "application/octet-stream" },
      });
    },
  });
}

let protectedWorker: ReturnType<typeof buildProtectedWorker> | undefined;

const worker: ExportedHandler<Env> = {
  async fetch(request, env, ctx) {
    const { pathname } = new URL(request.url);
    if (request.method === "GET" && pathname === "/healthz") {
      return new Response("ok");
    }

    try {
      protectedWorker ??= buildProtectedWorker(env);
      return await protectedWorker.fetch!(request, env, ctx);
    } catch {
      return new Response("Keycard request failed", { status: 502 });
    }
  },
};

export default worker;
