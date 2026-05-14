/**
 * Two eval agent modes:
 *
 * runBuildAgent — basic templates (express, python-mcp).
 *   Harness has already provisioned resources. Agent verifies config
 *   and runs install + build.
 *
 * runProvisioningAgent — brokered-credentials templates.
 *   Agent provisions ALL Keycard primitives from SPEC.md (Linear provider,
 *   applications, resources, dependency wiring, vault credentials), writes
 *   .env and keycard.toml, then installs and builds.
 *   This mirrors the actual `keycard-template-app` skill flow documented at
 *   https://docs.keycard.ai/guides/access-apis-on-behalf-of-users.md
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

const TOOLS: Anthropic.Tool[] = [
  {
    name: "bash",
    description: "Run a shell command in the template directory. Use this for keycard agent api calls, npm/uv install, builds, etc.",
    input_schema: {
      type: "object" as const,
      properties: { command: { type: "string" } },
      required: ["command"],
    },
  },
  {
    name: "write_file",
    description: "Write or overwrite a file. Paths are relative to the template directory.",
    input_schema: {
      type: "object" as const,
      properties: {
        path: { type: "string" },
        content: { type: "string" },
      },
      required: ["path", "content"],
    },
  },
  {
    name: "read_file",
    description: "Read a file. Paths are relative to the template directory.",
    input_schema: {
      type: "object" as const,
      properties: { path: { type: "string" } },
      required: ["path"],
    },
  },
];

async function runAgentLoop(
  client: Anthropic,
  systemPrompt: string,
  task: string,
  templateDir: string,
  extraEnv: Record<string, string>,
  maxTurns: number,
  successSignal: string,
  failureSignal: string,
): Promise<AgentResult> {
  const messages: Anthropic.MessageParam[] = [{ role: "user", content: task }];
  let output = "";

  for (let turn = 0; turn < maxTurns; turn++) {
    const response = await client.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 8192,
      system: systemPrompt,
      tools: TOOLS,
      messages,
    });

    const assistantContent: Anthropic.ContentBlock[] = [];
    const toolResults: Anthropic.ToolResultBlockParam[] = [];

    for (const block of response.content) {
      assistantContent.push(block);

      if (block.type === "text") {
        process.stdout.write(block.text);
        output += block.text + "\n";
        if (block.text.includes(successSignal)) return { success: true, output };
        if (block.text.includes(failureSignal)) return { success: false, output };
      }

      if (block.type === "tool_use") {
        let result = "";
        process.stdout.write(`\n[${block.name}: ${JSON.stringify(block.input).slice(0, 120)}]\n`);
        try {
          if (block.name === "bash") {
            const { command } = block.input as { command: string };
            const { stdout, stderr } = await execFileAsync("bash", ["-c", command], {
              cwd: templateDir,
              timeout: 120_000,
              env: { ...process.env, ...extraEnv },
            });
            result = stdout + (stderr ? `\nSTDERR: ${stderr}` : "");
          } else if (block.name === "write_file") {
            const { path: filePath, content } = block.input as { path: string; content: string };
            const resolved = path.resolve(templateDir, filePath);
            await fs.writeFile(resolved, content, "utf8");
            result = `Written: ${resolved}`;
          } else if (block.name === "read_file") {
            const { path: filePath } = block.input as { path: string };
            const resolved = path.resolve(templateDir, filePath);
            result = await fs.readFile(resolved, "utf8");
          }
        } catch (err) {
          const e = err as { stdout?: string; stderr?: string; message?: string };
          result = `FAILED\nSTDOUT: ${e.stdout ?? ""}\nSTDERR: ${e.stderr ?? ""}\n${e.message ?? String(err)}`;
        }
        if (result) process.stdout.write(`→ ${result.slice(0, 400)}\n`);
        output += `[tool:${block.name}] ${result.slice(0, 800)}\n`;
        toolResults.push({ type: "tool_result", tool_use_id: block.id, content: result });
      }
    }

    messages.push({ role: "assistant", content: assistantContent });
    if (response.stop_reason === "end_turn" && toolResults.length === 0) break;
    if (toolResults.length > 0) messages.push({ role: "user", content: toolResults });
  }

  return { success: false, output: output + "\n[max turns reached]" };
}

/** Basic templates: harness has already provisioned, agent verifies config + builds. */
export async function runBuildAgent(opts: {
  templateDir: string;
  zoneIssuerUrl: string;
  resourceIdentifier: string;
  language?: "python" | "typescript";
}): Promise<AgentResult> {
  const client = new Anthropic();
  const specContent = await fs.readFile(path.join(opts.templateDir, "SPEC.md"), "utf8");
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
1. Read the SPEC.md and verify .env and keycard.toml look correct for this provisioned zone
2. Fix any config issues
3. ${opts.language === "python" ? "Run: uv sync" : "Run: npm install"}
4. ${opts.language === "python" ? "Run: uv run python -c \"import main\"" : "Run: npm run build"}
5. Print exactly: BUILD_COMPLETE:SUCCESS or BUILD_COMPLETE:FAILURE`;

  return runAgentLoop(
    client,
    systemPrompt,
    `SPEC.md:\n\n${specContent}\n\nVerify config, fix if needed, then build.`,
    opts.templateDir,
    {},
    15,
    "BUILD_COMPLETE:SUCCESS",
    "BUILD_COMPLETE:FAILURE",
  );
}

/**
 * Brokered-credentials templates: agent provisions ALL Keycard primitives from
 * SPEC.md then configures and builds. This is the exact flow a user goes through
 * with the keycard-template-app skill.
 */
export async function runProvisioningAgent(opts: {
  templateDir: string;
  zoneId: string;
  zoneIssuerUrl: string;
  orgId: string;
  language: "python" | "typescript";
  keycardEndpoint: string;
  keycardClientId: string;
  keycardClientSecret: string;
}): Promise<AgentResult> {
  const client = new Anthropic();
  const specContent = await fs.readFile(path.join(opts.templateDir, "SPEC.md"), "utf8");

  // Pre-write a valid keycard.toml so `keycard agent api` has auth context from the start.
  // The agent will overwrite this at the end of §2 with the full credential entries.
  await fs.writeFile(
    path.join(opts.templateDir, "keycard.toml"),
    `[org]\nid = "${opts.orgId}"\n\n[zone]\nid = "${opts.zoneId}"\n`,
    "utf8",
  );

  // Environment the agent's bash commands run in.
  // KEYCARD_CLIENT_ID/SECRET let `keycard agent api` authenticate as the CI service account.
  const extraEnv: Record<string, string> = {
    KEYCARD_CLIENT_ID: opts.keycardClientId,
    KEYCARD_CLIENT_SECRET: opts.keycardClientSecret,
    KEYCARD_API_ENDPOINT: opts.keycardEndpoint,
    ZONE_ID: opts.zoneId,
    ORG_ID: opts.orgId,
  };

  const systemPrompt = `You are an automated CI eval agent testing a Keycard MCP template.

Your job is to provision all required Keycard resources by following the SPEC.md exactly, then configure and build the template. This mirrors the flow a user goes through with the keycard-template-app skill.

Context:
  Zone ID:     ${opts.zoneId}
  Org ID:      ${opts.orgId}
  Issuer URL:  ${opts.zoneIssuerUrl}
  Template:    ${opts.templateDir}

Rules:
- Make all Keycard Management API calls using curl. A bearer token is obtained once at the start and reused:
    TOKEN=$(curl -sf -X POST "\${KEYCARD_API_ENDPOINT}/service-account-token" \\
      -d "grant_type=client_credentials" \\
      -d "client_id=\${KEYCARD_CLIENT_ID}" \\
      -d "client_secret=\${KEYCARD_CLIENT_SECRET}" \\
      | jq -r '.access_token')
  Then use it for every call:
    curl -sf -X POST "\${KEYCARD_API_ENDPOINT}/zones/\${ZONE_ID}/..." \\
      -H "Authorization: Bearer \$TOKEN" \\
      -H "Content-Type: application/json" \\
      -d '{"name":"..."}'
  Always check that TOKEN is non-empty before proceeding.
- Follow SPEC.md sections in order: §1 (provision primitives), §2 (write config files), §4 (install + verify).
- The SPEC.md shows \`keycard agent api\` commands — translate each one to the equivalent curl call against \${KEYCARD_API_ENDPOINT}.
- For §1g (vault credentials), run: bash scripts/provision-credentials.sh with the correct flags. That script uses \`keycard agent api\` internally and will work correctly from the terminal context.
- Do NOT start the server — the harness does that after you signal success.
- Do NOT run keycard run.
- KEYCARD_URL for .env is: ${opts.zoneIssuerUrl}
- When writing keycard.toml: use the exact format from SPEC.md §2 (only [org].id, [zone].id, and [[credentials.default]] blocks — no schema_version, [project], or [server]).

Signal completion by printing exactly one of:
  PROVISION_COMPLETE:SUCCESS
  PROVISION_COMPLETE:FAILURE: <reason>`;

  return runAgentLoop(
    client,
    systemPrompt,
    `SPEC.md:\n\n${specContent}\n\nProvision all primitives, configure the template, install dependencies, and verify the build.`,
    opts.templateDir,
    extraEnv,
    35,
    "PROVISION_COMPLETE:SUCCESS",
    "PROVISION_COMPLETE:FAILURE",
  );
}
