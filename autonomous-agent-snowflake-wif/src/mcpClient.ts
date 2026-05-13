import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  extractResourceMetadataUrl,
  discoverOAuthProtectedResourceMetadata,
} from "@modelcontextprotocol/sdk/client/auth.js";
import type { FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { KeycardTokenProvider } from "./tokenProvider.js";

/**
 * Creates an MCP client connected to any MCP server, authenticated via
 * Keycard client_credentials grant with PRM-driven resource discovery.
 *
 * Authentication flow (client_credentials, no user/subject token):
 * 1. First MCP request goes out unauthenticated
 * 2. Server returns 401 with resource_metadata in WWW-Authenticate (RFC 9728)
 * 3. PRM is fetched to discover the canonical resource URI
 * 4. Token is obtained from the shared KeycardTokenProvider (cached/refreshed)
 * 5. Request is retried with the Bearer token; subsequent requests reuse it
 * 6. On 401 (token expired), the provider invalidates its cache and re-exchanges
 */
export async function createMcpClient(
  serverUrl: string,
  tokenProvider: KeycardTokenProvider,
): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(
    new URL(serverUrl),
    {
      fetch: createAuthenticatedFetch(tokenProvider),
    },
  );

  const client = new Client(
    { name: "autonomous-agent-snowflake-wif", version: "0.1.0" },
    { capabilities: {} },
  );

  await client.connect(transport);
  return client;
}

function createAuthenticatedFetch(
  tokenProvider: KeycardTokenProvider,
): FetchLike {
  let cachedResource: string | null = null;

  async function discoverResource(
    response401: Response,
    requestUrl: string,
  ): Promise<string> {
    const resourceMetadataUrl = extractResourceMetadataUrl(response401);
    if (!resourceMetadataUrl) {
      throw new Error(
        `MCP server at ${requestUrl} returned 401 without resource_metadata in WWW-Authenticate header. ` +
          `The server must advertise its protected resource metadata per RFC 9728.`,
      );
    }

    const prm = await discoverOAuthProtectedResourceMetadata(
      new URL(requestUrl).origin,
      { resourceMetadataUrl },
    );
    return prm.resource;
  }

  return async (url, init) => {
    const requestUrl = url.toString();

    if (cachedResource) {
      const token = await tokenProvider.getToken(cachedResource);
      const headers = new Headers(init?.headers);
      headers.set("Authorization", `Bearer ${token}`);
      const response = await fetch(url, { ...init, headers });
      if (response.status !== 401) return response;

      tokenProvider.invalidate(cachedResource);
    }

    const probeResponse = await fetch(url, init);
    if (probeResponse.status !== 401) return probeResponse;

    if (!cachedResource) {
      cachedResource = await discoverResource(probeResponse, requestUrl);
    }

    const token = await tokenProvider.getToken(cachedResource);
    const headers = new Headers(init?.headers);
    headers.set("Authorization", `Bearer ${token}`);
    return fetch(url, { ...init, headers });
  };
}
