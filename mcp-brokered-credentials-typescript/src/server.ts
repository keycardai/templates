import { randomUUID } from "node:crypto";
import express, { type Request, type Response } from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { mcpAuthMetadataRouter } from "@keycardai/mcp/server/auth/router";
import { requireBearerAuth } from "@keycardai/mcp/server/auth/middleware/bearerAuth";
import { AuthProvider } from "@keycardai/mcp/server/auth/provider";
import { discoverApplicationCredential } from "./credentials.js";
import { registerSearchTool } from "./tools/search.js";
import { registerExecuteTool } from "./tools/execute.js";

const PORT = Number(process.env.PORT ?? 8000);

if (!process.env.KEYCARD_URL) {
  throw new Error("KEYCARD_URL is required");
}

const KEYCARD_URL: string = process.env.KEYCARD_URL;
const RESOURCE_ID =
  process.env.KEYCARD_RESOURCE_ID ?? "mcp-brokered-credentials-typescript";

const applicationCredential = discoverApplicationCredential({
  serverName: RESOURCE_ID,
  zoneUrl: KEYCARD_URL,
});

const authProvider = new AuthProvider({
  zoneUrl: KEYCARD_URL,
  applicationCredential,
});

function createMcpServer(): McpServer {
  const server = new McpServer({
    name: RESOURCE_ID,
    version: "0.1.0",
  });
  registerSearchTool(server, authProvider);
  registerExecuteTool(server, authProvider);
  return server;
}

async function main() {
  const app = express();
  app.set("trust proxy", true);
  app.use(express.json());

  app.use(
    mcpAuthMetadataRouter({
      oauthMetadata: { issuer: KEYCARD_URL },
      scopesSupported: ["mcp:tools"],
      resourceName: RESOURCE_ID,
    }),
  );

  const bearerAuth = requireBearerAuth({
    issuers: KEYCARD_URL,
    requiredScopes: ["mcp:tools"],
  });

  const transports = new Map<string, StreamableHTTPServerTransport>();

  app.post("/mcp", bearerAuth, async (req: Request, res: Response) => {
    try {
      const sessionId = req.headers["mcp-session-id"] as string | undefined;

      if (sessionId) {
        const transport = transports.get(sessionId);
        if (!transport) {
          res.status(400).json({
            jsonrpc: "2.0",
            error: {
              code: -32000,
              message: "Bad Request: unknown mcp-session-id",
            },
            id: req.body?.id ?? null,
          });
          return;
        }
        await transport.handleRequest(req, res, req.body);
        return;
      }

      const server = createMcpServer();
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id: string) => {
          transports.set(id, transport);
        },
      });

      server.server.onclose = () => {
        const sid = transport.sessionId;
        if (sid) transports.delete(sid);
      };

      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      console.error("Error handling MCP POST:", err);
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: "2.0",
          error: { code: -32603, message: "Internal server error" },
          id: req.body?.id ?? null,
        });
      }
    }
  });

  app.get("/mcp", bearerAuth, async (req: Request, res: Response) => {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    const transport = sessionId ? transports.get(sessionId) : undefined;
    if (!transport) {
      res.status(400).json({
        jsonrpc: "2.0",
        error: {
          code: -32000,
          message: "Bad Request: unknown or missing mcp-session-id",
        },
        id: null,
      });
      return;
    }
    await transport.handleRequest(req, res);
  });

  app.delete("/mcp", bearerAuth, async (req: Request, res: Response) => {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    const transport = sessionId ? transports.get(sessionId) : undefined;
    if (!transport) {
      res.status(400).json({
        jsonrpc: "2.0",
        error: {
          code: -32000,
          message: "Bad Request: unknown or missing mcp-session-id",
        },
        id: null,
      });
      return;
    }
    await transport.handleRequest(req, res);
  });

  app.get("/healthz", (_req, res) => {
    res.json({ ok: true, name: RESOURCE_ID });
  });

  const httpServer = app.listen(PORT, () => {
    console.log(`${RESOURCE_ID} listening on http://localhost:${PORT}`);
    console.log(`Keycard: ${KEYCARD_URL}`);
    console.log(`Upstream: https://mcp.linear.app/mcp (brokered)`);
  });

  const shutdown = async () => {
    console.log("Shutting down...");
    for (const [sid, transport] of transports) {
      try {
        await transport.close();
      } catch (err) {
        console.error(`Error closing session ${sid}:`, err);
      }
    }
    transports.clear();
    httpServer.close(() => process.exit(0));
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
