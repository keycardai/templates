import { createKeycardWorker, IsolateSafeTokenCache, resolveCredential } from "@keycardai/cloudflare";
import { OAuthError } from "@keycardai/oauth/errors";
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

const bindingNames = [
  "KEYCARD_ISSUER", "KEYCARD_PRIVATE_KEY", "KEYCARD_CLIENT_ID", "KEYCARD_RESOURCE_URL", "KEYCARD_WORKER_RESOURCE",
] as const satisfies readonly (keyof Env)[];
let state: { bindings: string[]; handler: ReturnType<typeof buildProtectedWorker> } | undefined;

function safeErrorText(value: string, request: Request, env: Env): string {
  const token = request.headers.get("Authorization")?.match(/^Bearer\s+(\S+)/i)?.[1];
  for (const secret of [token, env.KEYCARD_PRIVATE_KEY]) {
    if (secret) value = value.replaceAll(secret, "[redacted]");
  }
  return value
    .replace(/-----BEGIN [^\r\n-]*PRIVATE KEY-----[\s\S]*?(?:-----END [^\r\n-]*PRIVATE KEY-----|$)/g, "[redacted PEM]")
    .replace(/\bBearer\s+[^\s,;"']+/gi, "Bearer [redacted]")
    .replace(/\beyJ[\w-]*\.[\w-]+\.[\w-]+\b/g, "[redacted JWT]")
    .slice(0, 512);
}

const worker: ExportedHandler<Env> = {
  async fetch(request, env, ctx) {
    const { pathname } = new URL(request.url);
    if (request.method === "GET" && pathname === "/healthz") {
      return new Response("ok");
    }

    try {
      const bindings = bindingNames.map((key) => env[key]);
      if (!state || state.bindings.some((value, index) => value !== bindings[index])) {
        state = { bindings, handler: buildProtectedWorker(env) };
      }
      return await state.handler.fetch!(request, env, ctx);
    } catch (err) {
      if (err instanceof Error) {
        console.error("Keycard request failed", {
          name: safeErrorText(err.name, request, env),
          code: err instanceof OAuthError ? safeErrorText(err.errorCode, request, env) : undefined,
          description: safeErrorText(err instanceof OAuthError ? (err.errorDescription ?? err.message) : err.message, request, env),
          status: err instanceof OAuthError ? err.status : undefined,
        });
      } else {
        console.error("Keycard request failed", { name: "UnknownError" });
      }
      return new Response("Keycard request failed", { status: 502 });
    }
  },
};

export default worker;
