import { ClientCredentialsClient } from "@keycardai/oauth";
import type { WebIdentity } from "@keycardai/mcp/server/auth/credentials";

export interface TokenProviderConfig {
  keycardUrl: string;
  identity: WebIdentity;
  refreshBufferMs?: number;
}

interface TokenEntry {
  token: string;
  expiresAt: number;
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
  private client: ClientCredentialsClient;

  constructor(config: TokenProviderConfig) {
    this.refreshBufferMs = config.refreshBufferMs ?? 60_000;
    this.client = new ClientCredentialsClient(config.keycardUrl, {
      credential: config.identity,
    });
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
    const { accessToken, expiresIn } = await this.client.requestToken({ resource });
    return {
      token: accessToken,
      expiresAt: Date.now() + (expiresIn ?? 3600) * 1000,
    };
  }
}
