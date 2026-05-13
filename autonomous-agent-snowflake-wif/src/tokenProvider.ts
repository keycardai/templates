import type { WebIdentity } from "@keycardai/mcp/server/auth/credentials";

export interface TokenProviderConfig {
  keycardUrl: string;
  identity: WebIdentity;
  clientId: string;
  refreshBufferMs?: number;
}

interface TokenEntry {
  token: string;
  expiresAt: number;
}

interface TokenResponse {
  access_token: string;
  expires_in: number;
}

/**
 * Centralised Keycard token provider that caches access tokens per resource
 * and refreshes them proactively before expiry. Concurrent requests for the
 * same resource are serialised to avoid redundant token exchanges.
 *
 * Follows the same cache-check-refresh pattern as pi-ai's `getOAuthApiKey`.
 */
export class KeycardTokenProvider {
  private cache = new Map<string, TokenEntry>();
  private pending = new Map<string, Promise<TokenEntry>>();
  private refreshBufferMs: number;

  constructor(private config: TokenProviderConfig) {
    this.refreshBufferMs = config.refreshBufferMs ?? 60_000;
  }

  async getToken(resource: string): Promise<string> {
    const cached = this.cache.get(resource);
    if (cached && Date.now() < cached.expiresAt - this.refreshBufferMs) {
      return cached.token;
    }

    if (!this.pending.has(resource)) {
      this.pending.set(
        resource,
        this.exchange(resource).finally(() => {
          this.pending.delete(resource);
        }),
      );
    }
    const entry = await this.pending.get(resource)!;
    this.cache.set(resource, entry);
    return entry.token;
  }

  invalidate(resource: string): void {
    this.cache.delete(resource);
  }

  private async exchange(resource: string): Promise<TokenEntry> {
    const tokenEndpoint = `${this.config.keycardUrl}/oauth/2/token`;
    const request = await this.config.identity.prepareTokenExchangeRequest(
      "",
      resource,
      {
        tokenEndpoint,
        authInfo: { resource_client_id: this.config.clientId },
      },
    );

    const { access_token, expires_in } = await clientCredentialsGrant(
      tokenEndpoint,
      request.clientAssertion!,
      resource,
    );
    return {
      token: access_token,
      expiresAt: Date.now() + expires_in * 1000,
    };
  }
}

export async function clientCredentialsGrant(
  tokenEndpoint: string,
  assertion: string,
  resource: string,
): Promise<TokenResponse> {
  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_assertion_type:
      "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
    client_assertion: assertion,
    resource,
  });

  const response = await fetch(tokenEndpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });

  if (!response.ok) {
    const text = await response.text();
    let desc = `HTTP ${response.status}`;
    try {
      const errorBody = JSON.parse(text);
      desc = errorBody.error_description ?? errorBody.error ?? desc;
    } catch {
      desc = text || desc;
    }
    throw new Error(`Keycard token exchange failed (${response.status}): ${desc}`);
  }

  const json = await response.json();
  if (typeof json.access_token !== "string") {
    throw new Error("Token response missing access_token");
  }
  return {
    access_token: json.access_token,
    expires_in: typeof json.expires_in === "number" ? json.expires_in : 3600,
  };
}
