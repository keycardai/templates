import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AuthProvider } from "@keycardai/mcp/server/auth/provider";
import { z } from "zod";
import safe from "safe-regex2";
import { withLinearClient } from "../upstream.js";

export function registerSearchTool(
  server: McpServer,
  authProvider: AuthProvider,
) {
  server.tool(
    "search",
    "Search the upstream Linear MCP server's tool catalog by regex. Returns name, description and input schema for tools whose name or description matches.",
    {
      pattern: z
        .string()
        .min(1)
        .describe(
          "JavaScript-flavoured regex matched (case-insensitive) against each upstream tool's name and description.",
        ),
    },
    async ({ pattern }, extra) => {
      const subjectToken = extra.authInfo?.token;
      if (!subjectToken) {
        throw new Error("Missing bearer token on the incoming request.");
      }

      let regex: RegExp;
      try {
        regex = new RegExp(pattern, "i");
      } catch (err) {
        throw new Error(
          `Invalid regex pattern: ${err instanceof Error ? err.message : String(err)}`,
        );
      }

      if (!safe(regex)) {
        throw new Error(
          "This regex pattern is too complex. Try a simpler pattern.",
        );
      }

      const matches = await withLinearClient(
        authProvider,
        subjectToken,
        async (client) => {
          const { tools } = await client.listTools();
          return tools
            .filter(
              (tool) =>
                regex.test(tool.name) ||
                (tool.description ? regex.test(tool.description) : false),
            )
            .map((tool) => ({
              name: tool.name,
              description: tool.description ?? "",
              inputSchema: tool.inputSchema,
            }));
        },
      );

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ matches }, null, 2),
          },
        ],
      };
    },
  );
}
