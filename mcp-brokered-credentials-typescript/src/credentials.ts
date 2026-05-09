import * as fs from "node:fs";
import { ClientSecret } from "@keycardai/mcp/server/auth/credentials";
import { WebIdentity, EKSWorkloadIdentity } from "@keycardai/mcp/server/auth/credentials";
import type { ApplicationCredential } from "@keycardai/mcp/server/auth/credentials";

// Re-export so server.ts only imports from this module.
export type { ApplicationCredential };

const JWT_BEARER_ASSERTION_TYPE =
  "urn:ietf:params:oauth:client-assertion-type:jwt-bearer";
const ACCESS_TOKEN_TYPE =
  "urn:ietf:params:oauth:token-type:access_token";

// ── Fly workload-identity credential ────────────────────────────────

const FLY_METADATA_URL =
  "http://_api.internal:4280/v1/tokens/oidc";

interface FlyWorkloadIdentityOptions {
  audience: string;
  metadataUrl?: string;
}

/**
 * Fly.io machine OIDC credential provider.
 *
 * Inside a Fly Machine the platform exposes an internal metadata endpoint
 * that mints short-lived OIDC tokens (`POST /v1/tokens/oidc`). The token
 * is used as a client assertion in RFC 8693 token-exchange requests —
 * the same shape as EKSWorkloadIdentity.
 *
 * The OIDC provider + application-credential binding must already exist
 * in Keycard (see deploy-fly.md §4–§5).
 */
export class FlyWorkloadIdentity implements ApplicationCredential {
  #audience: string;
  #metadataUrl: string;
  #cachedToken: string | null = null;
  #cachedExp = 0;

  constructor(options: FlyWorkloadIdentityOptions) {
    this.#audience = options.audience;
    this.#metadataUrl = options.metadataUrl ?? FLY_METADATA_URL;
  }

  getAuth(): null {
    return null;
  }

  async prepareTokenExchangeRequest(
    subjectToken: string,
    resource: string,
  ) {
    const token = await this.#getToken();
    return {
      subjectToken,
      resource,
      subjectTokenType: ACCESS_TOKEN_TYPE,
      clientAssertionType: JWT_BEARER_ASSERTION_TYPE,
      clientAssertion: token,
    };
  }

  async #getToken(): Promise<string> {
    if (this.#cachedToken && Date.now() / 1000 < this.#cachedExp) {
      return this.#cachedToken;
    }

    const apiToken = this.#readMachineToken();
    const res = await fetch(this.#metadataUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ aud: this.#audience }),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(
        `FlyWorkloadIdentity: OIDC token request failed (HTTP ${res.status}): ${body}`,
      );
    }

    const token = (await res.text()).trim();
    if (!token) {
      throw new Error("FlyWorkloadIdentity: metadata endpoint returned empty token");
    }

    const exp = this.#parseExp(token);
    this.#cachedToken = token;
    this.#cachedExp = exp - 60;

    return token;
  }

  #readMachineToken(): string {
    const envToken = process.env.FLY_API_TOKEN;
    if (envToken) return envToken;

    try {
      return fs.readFileSync("/.fly/api", "utf-8").trim();
    } catch {
      throw new Error(
        "FlyWorkloadIdentity: could not read machine token. " +
          "Expected FLY_API_TOKEN env var or /.fly/api file.",
      );
    }
  }

  /** Decode the JWT payload to extract `exp` without verifying the signature. */
  #parseExp(jwt: string): number {
    const parts = jwt.split(".");
    if (parts.length < 2) return 0;
    try {
      const payload = JSON.parse(
        Buffer.from(parts[1], "base64url").toString(),
      );
      return typeof payload.exp === "number" ? payload.exp : 0;
    } catch {
      return 0;
    }
  }
}

// ── Credential discovery ────────────────────────────────────────────

const EKS_TOKEN_ENV_VARS = [
  "KEYCARD_EKS_WORKLOAD_IDENTITY_TOKEN_FILE",
  "AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE",
  "AWS_WEB_IDENTITY_TOKEN_FILE",
];

export interface DiscoverOptions {
  serverName?: string;
  zoneUrl: string;
}

/**
 * Environment-driven credential discovery.
 *
 * Priority (mirrors the Python SDK's `AuthProvider._discover_application_credential`):
 *
 *  1. KEYCARD_CLIENT_ID + KEYCARD_CLIENT_SECRET  →  ClientSecret
 *  2. KEYCARD_APPLICATION_CREDENTIAL_TYPE         →  explicit override
 *  3. EKS token file env vars                     →  EKSWorkloadIdentity
 *  4. FLY_APP_NAME                                →  FlyWorkloadIdentity
 *  5. Throw with actionable guidance.
 */
export function discoverApplicationCredential(
  options: DiscoverOptions,
): ApplicationCredential {
  const clientId = process.env.KEYCARD_CLIENT_ID;
  const clientSecret = process.env.KEYCARD_CLIENT_SECRET;
  if (clientId && clientSecret) {
    return new ClientSecret(clientId, clientSecret);
  }

  const credType = process.env.KEYCARD_APPLICATION_CREDENTIAL_TYPE;
  if (credType) {
    switch (credType) {
      case "eks_workload_identity": {
        const tokenFile = process.env.KEYCARD_EKS_WORKLOAD_IDENTITY_TOKEN_FILE;
        return new EKSWorkloadIdentity(
          tokenFile ? { tokenFilePath: tokenFile } : undefined,
        );
      }
      case "fly_workload_identity":
        return new FlyWorkloadIdentity({ audience: options.zoneUrl });
      case "web_identity":
        return new WebIdentity({
          serverName: options.serverName,
        });
      default:
        throw new Error(
          `Unknown KEYCARD_APPLICATION_CREDENTIAL_TYPE: "${credType}". ` +
            `Supported values: eks_workload_identity, fly_workload_identity, web_identity`,
        );
    }
  }

  if (EKS_TOKEN_ENV_VARS.some((v) => process.env[v])) {
    return new EKSWorkloadIdentity();
  }

  if (process.env.FLY_APP_NAME) {
    return new FlyWorkloadIdentity({ audience: options.zoneUrl });
  }

  throw new Error(
    "Could not discover application credentials. Provide one of:\n" +
      "  - KEYCARD_CLIENT_ID + KEYCARD_CLIENT_SECRET (e.g. via `keycard run`)\n" +
      "  - KEYCARD_APPLICATION_CREDENTIAL_TYPE=eks_workload_identity|fly_workload_identity|web_identity\n" +
      "  - Deploy on EKS (auto-detected via AWS_*_TOKEN_FILE env vars)\n" +
      "  - Deploy on Fly.io (auto-detected via FLY_APP_NAME env var)\n",
  );
}
