import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

export function registerHelloTool(server: McpServer) {
  server.tool(
    "hello",
    "Returns a friendly greeting. Useful as a smoke test that the server is reachable and your Keycard policy allows tool calls.",
    { name: z.string().min(1).describe("Who to greet") },
    async ({ name }) => ({
      content: [
        {
          type: "text",
          text: `Hello, ${name}!`,
        },
      ],
    }),
  );
}
