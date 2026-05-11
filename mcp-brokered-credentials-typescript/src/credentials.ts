import * as http from "node:http";
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

// Fly Machines expose the local API as a Unix socket at /.fly/api.
// OIDC tokens are minted by POSTing to /v1/tokens/oidc over that socket.
// See https://fly.io/docs/security/openid-connect/.
const FLY_API_SOCKET = "/.fly/api";
const FLY_OIDC_PATH = "/v1/tokens/oidc";

interface FlyWorkloadIdentityOptions {
  audience: string;
  socketPath?: string;
}

export class FlyWorkloadIdentity implements ApplicationCredential {
  #audience: string;
  #socketPath: string;
  #cachedToken: string | null = null;
  #cachedExp = 0;

  constructor(options: FlyWorkloadIdentityOptions) {
    this.#audience = options.audience;
    this.#socketPath = options.socketPath ?? FLY_API_SOCKET;
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

    const { status, body } = await this.#postOverUnixSocket(
      JSON.stringify({ aud: this.#audience }),
    );

    if (status < 200 || status >= 300) {
      throw new Error(
        `FlyWorkloadIdentity: OIDC token request failed (HTTP ${status}): ${body}`,
      );
    }

    const token = body.trim();
    if (!token) {
      throw new Error("FlyWorkloadIdentity: metadata endpoint returned empty token");
    }

    const exp = this.#parseExp(token);
    this.#cachedToken = token;
    this.#cachedExp = exp - 60;

    return token;
  }

  #postOverUnixSocket(
    payload: string,
  ): Promise<{ status: number; body: string }> {
    return new Promise((resolve, reject) => {
      const req = http.request(
        {
          socketPath: this.#socketPath,
          method: "POST",
          path: FLY_OIDC_PATH,
          headers: {
            "Content-Type": "application/json",
            "Content-Length": Buffer.byteLength(payload),
            Host: "localhost",
          },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (c) => chunks.push(c));
          res.on("end", () =>
            resolve({
              status: res.statusCode ?? 0,
              body: Buffer.concat(chunks).toString("utf-8"),
            }),
          );
        },
      );
      req.on("error", (err) => {
        const msg =
          (err as NodeJS.ErrnoException).code === "ENOENT"
            ? `FlyWorkloadIdentity: Fly API socket not found at ${this.#socketPath}. ` +
              "Is this running inside a Fly Machine?"
            : `FlyWorkloadIdentity: request to ${this.#socketPath} failed: ${err.message}`;
        reject(new Error(msg));
      });
      req.write(payload);
      req.end();
    });
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
