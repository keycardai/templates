import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { mcpAuthMetadataRouter } from "@keycardai/mcp/server/auth/router";
import { requireBearerAuth } from "@keycardai/mcp/server/auth/middleware/bearerAuth";
import { registerHelloTool } from "./tools/hello.js";

const PORT = Number(process.env.PORT ?? 8000);

if (!process.env.KEYCARD_URL) {
  throw new Error("KEYCARD_URL is required");
}

const KEYCARD_URL: string = process.env.KEYCARD_URL;
const RESOURCE_ID =
  process.env.KEYCARD_RESOURCE_ID ?? "mcp-server-typescript-express";

async function main() {
  const app = express();
  app.use(express.json());

  const server = new McpServer({
    name: RESOURCE_ID,
    version: "0.1.0",
  });

  registerHelloTool(server);

  app.use(
    mcpAuthMetadataRouter({
      oauthMetadata: { issuer: KEYCARD_URL },
      scopesSupported: ["mcp:tools"],
      resourceName: RESOURCE_ID,
    }),
  );

  app.post(
    "/mcp",
    requireBearerAuth({
      issuers: KEYCARD_URL,
      requiredScopes: ["mcp:tools"],
    }),
    async (req, res) => {
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => crypto.randomUUID(),
      });
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    },
  );

  app.get("/healthz", (_req, res) => {
    res.json({ ok: true, name: RESOURCE_ID });
  });

  app.listen(PORT, () => {
    console.log(`${RESOURCE_ID} listening on http://localhost:${PORT}`);
    console.log(`Keycard: ${KEYCARD_URL}`);
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
