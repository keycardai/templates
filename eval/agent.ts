/**
 * Runs a Claude agent to verify the template config and build the server.
 *
 * The harness has already provisioned Keycard resources and written
 * .env + keycard.toml. The agent's job: read the SPEC.md, confirm the
 * config looks correct, then npm install + npm run build.
 *
 * This tests: does the agent understand the config requirements well
 * enough to validate them, and can it produce a working build?
 */

import Anthropic from "@anthropic-ai/sdk";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import * as fs from "node:fs/promises";
import * as path from "node:path";

const execFileAsync = promisify(execFile);

export interface AgentResult {
  success: boolean;
  output: string;
}

export async function runBuildAgent(opts: {
  templateDir: string;
  zoneIssuerUrl: string;
  resourceIdentifier: string;
  language?: "python" | "typescript" | "go";
}): Promise<AgentResult> {
  const client = new Anthropic();
  const specPath = path.join(opts.templateDir, "SPEC.md");
  const specContent = await fs.readFile(specPath, "utf8");

  const envContent = await fs.readFile(path.join(opts.templateDir, ".env"), "utf8").catch(() => "(not found)");
  const tomlContent = await fs.readFile(path.join(opts.templateDir, "keycard.toml"), "utf8").catch(() => "(not found)");

  const systemPrompt = `You are an automated eval agent. The Keycard resources have already been provisioned.

Current .env:
${envContent}

Current keycard.toml:
${tomlContent}

Zone issuer URL: ${opts.zoneIssuerUrl}
Resource identifier: ${opts.resourceIdentifier}
Working directory: ${opts.templateDir}

Your task:
1. Read the SPEC.md (provided below) and verify the .env and keycard.toml look correct for this provisioned zone
2. Fix any config issues you find
3. ${opts.language === "python" ? "Run: uv sync" : opts.language === "go" ? "Run: go mod download" : "Run: npm install"}
4. ${opts.language === "python" ? "Verify the server can start (uv run python -c \"import main\" or similar)" : opts.language === "go" ? "Run: go build ./... and confirm it compiles" : "Run: npm run build"}
5. If successful, print exactly: BUILD_COMPLETE:SUCCESS
6. If something fails, print exactly: BUILD_COMPLETE:FAILURE and explain why`;

  const task = `SPEC.md:\n\n${specContent}\n\nVerify config, fix if needed, then build.`;

  const messages: Anthropic.MessageParam[] = [{ role: "user", content: task }];
  const tools: Anthropic.Tool[] = [
    {
      name: "bash",
      description: "Run a shell command in the template directory",
      input_schema: {
        type: "object" as const,
        properties: { command: { type: "string" } },
        required: ["command"],
      },
    },
    {
      name: "write_file",
      description: "Write or overwrite a file",
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

  for (let turn = 0; turn < 15; turn++) {
    const response = await client.messages.create({
      model: "claude-sonnet-4-6",
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
        if (block.text.includes("BUILD_COMPLETE:SUCCESS")) return { success: true, output };
        if (block.text.includes("BUILD_COMPLETE:FAILURE")) return { success: false, output };
      }

      if (block.type === "tool_use") {
        let result = "";
        try {
          if (block.name === "bash") {
            const { command } = block.input as { command: string };
            const { stdout, stderr } = await execFileAsync("bash", ["-c", command], {
              cwd: opts.templateDir,
              timeout: 60_000,
            });
            result = stdout + (stderr ? `\nSTDERR: ${stderr}` : "");
          } else if (block.name === "write_file") {
            const { path: filePath, content } = block.input as { path: string; content: string };
            const resolved = path.resolve(opts.templateDir, filePath);
            await fs.writeFile(resolved, content, "utf8");
            result = `Written: ${resolved}`;
          }
        } catch (err) {
          result = `Error: ${err instanceof Error ? err.message : String(err)}`;
        }
        output += `[tool:${block.name}] ${result.slice(0, 500)}\n`;
        toolResults.push({ type: "tool_result", tool_use_id: block.id, content: result });
      }
    }

    messages.push({ role: "assistant", content: assistantContent });
    if (response.stop_reason === "end_turn" && toolResults.length === 0) break;
    if (toolResults.length > 0) messages.push({ role: "user", content: toolResults });
  }

  return { success: false, output: output + "\n[max turns reached]" };
}
