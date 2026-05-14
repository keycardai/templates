import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import { Type, type TSchema } from "typebox";

/**
 * Discovers all tools from an MCP server and adapts each one into a
 * pi-agent-core `AgentTool`. The adapter forwards tool calls to the
 * server via `client.callTool()`.
 */
export async function discoverTools(client: Client): Promise<AgentTool[]> {
  const { tools } = await client.listTools();
  return tools.map((tool) => mcpToolToAgentTool(client, tool));
}

interface McpToolDef {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

function mcpToolToAgentTool(client: Client, tool: McpToolDef): AgentTool {
  const parameters: TSchema = tool.inputSchema
    ? Type.Unsafe(tool.inputSchema)
    : Type.Object({});

  return {
    name: tool.name,
    label: tool.name,
    description: tool.description ?? "",
    parameters,
    execute: async (
      _toolCallId: string,
      params: unknown,
    ): Promise<AgentToolResult<unknown>> => {
      const result = await client.callTool({
        name: tool.name,
        arguments: params as Record<string, unknown>,
      });

      const textParts = (result.content as Array<{ type: string; text?: string }>)
        .filter((c) => c.type === "text" && c.text)
        .map((c) => ({ type: "text" as const, text: c.text! }));

      return {
        content: textParts.length > 0
          ? textParts
          : [{ type: "text", text: JSON.stringify(result.content) }],
        details: result,
      };
    },
  };
}
