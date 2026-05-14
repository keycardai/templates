import express from "express";
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

  const { requestHandler, userBuilder } = config.a2a;
  app.use(
    "/.well-known/agent-card.json",
    agentCardHandler({ agentCardProvider: requestHandler }),
  );
  app.use(
    "/a2a/jsonrpc",
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
