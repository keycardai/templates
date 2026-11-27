import { randomUUID } from "node:crypto";
import express, { type Request, type Response } from "express";
import { McpServer } from "@modelcontextprotocol/server";
import { NodeStreamableHTTPServerTransport } from "@modelcontextprotocol/node";
import { createKeycardMiddleware } from "@keycardai/express";
import { registerHelloTool } from "./tools/hello.js";

const PORT = Number(process.env.PORT ?? 8000);

if (!process.env.KEYCARD_URL) {
  throw new Error("KEYCARD_URL is required");
}

const KEYCARD_URL: string = process.env.KEYCARD_URL;
const SERVER_NAME = "mcp-server-typescript-express";
const RESOURCE_ID = process.env.KEYCARD_RESOURCE_ID || `http://localhost:${PORT}/mcp`;
const resourceUrl = new URL(RESOURCE_ID);
if (!["http:", "https:"].includes(resourceUrl.protocol)) {
  throw new Error("KEYCARD_RESOURCE_ID must be an HTTP(S) URL");
}
const MCP_PATH = new RegExp(`^${resourceUrl.pathname.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`);

function createMcpServer(): McpServer {
  const server = new McpServer({
    name: SERVER_NAME,
    version: "0.1.0",
  });
  registerHelloTool(server);
  return server;
}

async function main() {
  const app = express();
  app.set("trust proxy", true);
  app.use(express.json());

  const keycard = createKeycardMiddleware({
    zoneUrl: KEYCARD_URL,
    resourceIdentifier: RESOURCE_ID,
  });
  app.use(keycard.metadataRouter({
    scopesSupported: ["mcp:tools"],
    resourceName: SERVER_NAME,
  }));
  const bearerAuth = keycard.requireBearerAuth({ requiredScopes: ["mcp:tools"] });

  // One transport per MCP session. The MCP SDK forbids reconnecting a
  // single server to multiple transports, so each session also gets
  // its own McpServer instance.
  //
  // NOTE: entries are removed on graceful MCP close (server.onclose) but NOT
  // on raw client disconnect, idle timeout, or token expiry. For a long-lived
  // production service, add a TTL sweep or idle-timeout reaper so stale
  // sessions don't accumulate indefinitely.
  const transports = new Map<string, NodeStreamableHTTPServerTransport>();

  app.post(MCP_PATH, bearerAuth, async (req: Request, res: Response) => {
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

      // No session id → treat as an initialize request and start a new session.
      const server = createMcpServer();
      const transport = new NodeStreamableHTTPServerTransport({
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

  app.get(MCP_PATH, bearerAuth, async (req: Request, res: Response) => {
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

  app.delete(MCP_PATH, bearerAuth, async (req: Request, res: Response) => {
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
    res.json({ ok: true, name: SERVER_NAME });
  });

  const httpServer = app.listen(PORT, () => {
    console.log(`${SERVER_NAME} listening on http://localhost:${PORT}`);
    console.log(`Keycard: ${KEYCARD_URL}`);
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
