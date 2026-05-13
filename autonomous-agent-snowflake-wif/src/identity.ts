import { Router, type Request, type Response } from "express";
import { WebIdentity } from "@keycardai/mcp/server/auth/credentials";

const DEFAULT_AGENT_NAME = "autonomous-agent-snowflake-wif";

export const CLIENT_METADATA_PATH = "/.well-known/oauth-client-metadata";

export interface IdentityConfig {
  storageDir?: string;
  keyId?: string;
}

let webIdentity: WebIdentity | undefined;
let agentBaseUrl: string | undefined;

export async function bootstrapIdentity(
  config: IdentityConfig = {},
): Promise<WebIdentity> {
  const identity = new WebIdentity({
    storageDir: config.storageDir ?? "./agent_keys",
    keyId: config.keyId ?? process.env.AGENT_NAME ?? DEFAULT_AGENT_NAME,
  });
  await identity.bootstrap();
  webIdentity = identity;
  return identity;
}

export function getIdentity(): WebIdentity {
  if (!webIdentity) {
    throw new Error("Identity not bootstrapped. Call bootstrapIdentity() first.");
  }
  return webIdentity;
}

export function setAgentBaseUrl(url: string): void {
  agentBaseUrl = url;
}

export function getClientId(): string {
  if (!agentBaseUrl) {
    throw new Error("Agent base URL not set. Call setAgentBaseUrl() first.");
  }
  return `${agentBaseUrl}${CLIENT_METADATA_PATH}`;
}

/**
 * Express router that serves the agent's well-known endpoints:
 * - `GET /.well-known/jwks.json` — public key for assertion verification
 * - `GET /oauth-client-metadata` — CIMD per draft-ietf-oauth-client-id-metadata-document
 */
export function identityRouter(): Router {
  const router = Router();

  router.get("/.well-known/jwks.json", (_req: Request, res: Response) => {
    const identity = getIdentity();
    res.json(identity.getPublicJwks());
  });

  router.get(CLIENT_METADATA_PATH, (_req: Request, res: Response) => {
    const identity = getIdentity();
    const clientId = getClientId();
    res.json({
      client_id: clientId,
      client_name: process.env.AGENT_NAME ?? DEFAULT_AGENT_NAME,
      token_endpoint_auth_method: "private_key_jwt",
      token_endpoint_auth_signing_alg: "RS256",
      grant_types: ["urn:ietf:params:oauth:grant-type:token-exchange"],
      jwks: identity.getPublicJwks(),
    });
  });

  return router;
}
