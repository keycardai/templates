/**
 * Runs a Claude Code agent against a template's SPEC.md to provision
 * Keycard resources and start the server.
 *
 * The agent receives: zone credentials, the template directory path,
 * and the task "Follow SPEC.md to provision the required Keycard resources
 * and start the server." It uses the Keycard CLI and Management API to
 * execute each step, then signals completion.
 */

import Anthropic from "@anthropic-ai/sdk";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import * as path from "node:path";

const execFileAsync = promisify(execFile);

export interface AgentResult {
  success: boolean;
  serverPid?: number;
  output: string;
}

export async function runSpecAgent(opts: {
  templateDir: string;
  zoneId: string;
  zoneIssuerUrl: string;
  managementToken: string;
  endpoint: string;
  timeout?: number;
}): Promise<AgentResult> {
  const client = new Anthropic();
  const specPath = path.join(opts.templateDir, "SPEC.md");
  const specContent = await import("node:fs/promises").then((fs) => fs.readFile(specPath, "utf8"));

  const systemPrompt = `You are running inside an automated eval. Your job is to follow the SPEC.md exactly to provision Keycard resources and start the MCP server.

Environment:
- Keycard endpoint: ${opts.endpoint}
- Zone ID: ${opts.zoneId}
- Zone issuer URL: ${opts.zoneIssuerUrl}
- Management API token: ${opts.managementToken}
- Template directory: ${opts.templateDir}
- Working directory: ${opts.templateDir}

Use the Management API token in Authorization headers for all Keycard API calls.
When the SPEC says to run "keycard agent api ...", translate that to a direct HTTP call using curl with the management token.
After starting the server, it must be running on port 8000.
Signal completion by printing: EVAL_COMPLETE:SUCCESS or EVAL_COMPLETE:FAILURE`;

  const task = `Follow this SPEC.md to provision the Keycard resources and start the server:\n\n${specContent}`;

  const messages: Anthropic.MessageParam[] = [{ role: "user", content: task }];
  const tools: Anthropic.Tool[] = [
    {
      name: "bash",
      description: "Run a shell command",
      input_schema: {
        type: "object" as const,
        properties: { command: { type: "string" } },
        required: ["command"],
      },
    },
    {
      name: "write_file",
      description: "Write content to a file",
      input_schema: {
        type: "object" as const,
        properties: {
          path: { type: "string" },
          content: { type: "string" },
        },
        required: ["path", "content"],
      },
    },
  ];

  let output = "";
  const startTime = Date.now();
  const timeout = opts.timeout ?? 120_000;

  while (Date.now() - startTime < timeout) {
    const response = await client.messages.create({
      model: "claude-opus-4-7",
      max_tokens: 4096,
      system: systemPrompt,
      tools,
      messages,
    });

    const assistantContent: Anthropic.ContentBlock[] = [];
    const toolResults: Anthropic.ToolResultBlockParam[] = [];

    for (const block of response.content) {
      assistantContent.push(block);

      if (block.type === "text") {
        output += block.text + "\n";
        if (block.text.includes("EVAL_COMPLETE:SUCCESS")) {
          return { success: true, output };
        }
        if (block.text.includes("EVAL_COMPLETE:FAILURE")) {
          return { success: false, output };
        }
      }

      if (block.type === "tool_use") {
        let result = "";
        try {
          if (block.name === "bash") {
            const { command } = block.input as { command: string };
            const { stdout, stderr } = await execFileAsync("bash", ["-c", command], {
              cwd: opts.templateDir,
              timeout: 30_000,
              env: { ...process.env, KEYCARD_ZONE_URL: opts.zoneIssuerUrl },
            });
            result = stdout + (stderr ? `\nSTDERR: ${stderr}` : "");
          } else if (block.name === "write_file") {
            const { path: filePath, content } = block.input as { path: string; content: string };
            const fs = await import("node:fs/promises");
            const resolved = path.resolve(opts.templateDir, filePath);
            await fs.writeFile(resolved, content, "utf8");
            result = `Written: ${resolved}`;
          }
        } catch (err) {
          result = `Error: ${err instanceof Error ? err.message : String(err)}`;
        }

        output += `[tool:${block.name}] ${result}\n`;
        toolResults.push({ type: "tool_result", tool_use_id: block.id, content: result });
      }
    }

    messages.push({ role: "assistant", content: assistantContent });

    if (response.stop_reason === "end_turn" && toolResults.length === 0) {
      break;
    }

    if (toolResults.length > 0) {
      messages.push({ role: "user", content: toolResults });
    }
  }

  return { success: false, output: output + "\n[timeout or max turns reached]" };
}
