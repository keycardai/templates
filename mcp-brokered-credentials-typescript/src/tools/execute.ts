import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AuthProvider } from "@keycardai/mcp/server/auth/provider";
import { z } from "zod";
import { withLinearClient } from "../upstream.js";

export function registerExecuteTool(
  server: McpServer,
  authProvider: AuthProvider,
) {
  server.tool(
    "execute",
    "Execute a tool on the upstream Linear MCP server. Use `search` first to discover available tool names and their input schemas.",
    {
      name: z
        .string()
        .min(1)
        .describe("Upstream tool name, exactly as returned by `search`."),
      arguments: z
        .record(z.unknown())
        .optional()
        .describe(
          "Arguments object matching the upstream tool's inputSchema. Omit for no-argument tools.",
        ),
    },
    async ({ name, arguments: args }, extra) => {
      const subjectToken = extra.authInfo?.token;
      if (!subjectToken) {
        throw new Error("Missing bearer token on the incoming request.");
      }

      const result = await withLinearClient(
        authProvider,
        subjectToken,
        (client) =>
          client.callTool({
            name,
            arguments: args ?? {},
          }),
      );

      // The upstream may return the legacy `{ toolResult }` shape; normalise
      // to the modern `{ content }` shape so callers always see the same
      // response structure.
      const content = Array.isArray(result.content)
        ? result.content
        : [
            {
              type: "text" as const,
              text: JSON.stringify(result.toolResult ?? result, null, 2),
            },
          ];

      return {
        content,
        ...(result.structuredContent !== undefined && {
          structuredContent: result.structuredContent as Record<string, unknown>,
        }),
        ...(result.isError !== undefined && { isError: Boolean(result.isError) }),
      };
    },
  );
}
