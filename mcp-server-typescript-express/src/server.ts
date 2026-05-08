import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { keycardMcp } from "@keycardai/mcp";
import { registerHelloTool } from "./tools/hello.js";

const PORT = Number(process.env.PORT ?? 8000);
const ZONE_URL = process.env.KEYCARD_URL;

if (!ZONE_URL) {
  throw new Error("KEYCARD_URL is required");
}

const RESOURCE_ID = process.env.KEYCARD_RESOURCE_ID ?? "mcp-server-typescript-express";

async function main() {
  const app = express();
  app.use(express.json());

  const server = new McpServer({
    name: RESOURCE_ID,
    version: "0.1.0",
  });

  registerHelloTool(server);

  app.use(
    "/mcp",
    keycardMcp({
      zoneUrl: ZONE_URL,
      resourceId: RESOURCE_ID,
    }),
  );

  app.post("/mcp", async (req, res) => {
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => crypto.randomUUID(),
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  });

  app.get("/healthz", (_req, res) => {
    res.json({ ok: true, name: RESOURCE_ID });
  });

  app.listen(PORT, () => {
    console.log(`${RESOURCE_ID} listening on http://localhost:${PORT}`);
    console.log(`Keycard zone: ${ZONE_URL}`);
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
