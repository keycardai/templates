import express from "express";
import { createKeycardMiddleware } from "@keycardai/express";
import {
  agentCardHandler,
  jsonRpcHandler,
  type DefaultRequestHandler,
  type UserBuilder,
} from "@keycardai/a2a";
import { identityRouter } from "./identity.js";

export interface A2AConfig {
  requestHandler: DefaultRequestHandler;
  userBuilder: UserBuilder;
  /** Keycard zone that issues the bearer tokens other agents present. */
  issuer: string;
  /**
   * This agent's registered Resource identifier. Defaults to the agent base URL.
   */
  audience?: string;
}

export interface ServerConfig {
  port: number;
  agentBaseUrl: string;
  a2a: A2AConfig;
}

export interface ServerHandle {
  setDegraded(reason: string): void;
}

/**
 * Starts the Express server that hosts the agent's well-known endpoints
 * and the A2A JSON-RPC interface.
 */
export async function startServer(
  config: ServerConfig,
): Promise<ServerHandle> {
  const app = express();

  let degradedReason: string | undefined;

  app.use(express.json());
  app.use(identityRouter());

  const { requestHandler, userBuilder, issuer, audience } = config.a2a;
  const keycard = createKeycardMiddleware({
    zoneUrl: issuer,
    resourceIdentifier: audience ?? config.agentBaseUrl,
  });
  app.use(keycard.metadataRouter());
  app.use(
    "/.well-known/agent-card.json",
    agentCardHandler({ agentCardProvider: requestHandler }),
  );
  app.use(
    "/a2a/jsonrpc",
    // Rejects a missing or invalid bearer with HTTP 401 and an RFC 6750
    // WWW-Authenticate challenge, and sets req.auth for the user builder.
    keycard.requireBearerAuth(),
    jsonRpcHandler({ requestHandler, userBuilder }),
  );

  app.get("/healthz", (_req, res) => {
    const status = degradedReason ? "degraded" : "ok";
    res.status(200).json({
      status,
      name: "autonomous-agent-snowflake-wif",
      ...(degradedReason && { reason: degradedReason }),
    });
  });

  return new Promise<ServerHandle>((resolve) => {
    app.listen(config.port, () => {
      console.log(`agent identity:  ${config.agentBaseUrl}/.well-known/agent-card.json`);
      resolve({
        setDegraded(reason: string) {
          degradedReason = reason;
        },
      });
    });
  });
}
