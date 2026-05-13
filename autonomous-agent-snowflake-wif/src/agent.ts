import { Agent } from "@earendil-works/pi-agent-core";
import { getModel } from "@earendil-works/pi-ai";
import type { AgentTool } from "@earendil-works/pi-agent-core";

const DEFAULT_SYSTEM_PROMPT = `You are an autonomous agent with access to a Snowflake data warehouse.

You are authenticated to Snowflake via Workload Identity Federation (OIDC).
Use the available tools to query Snowflake, analyze the results, and produce
a clear summary.

When you have completed the task, output your final summary and stop.`;

export interface AgentConfig {
  provider: string;
  modelId: string;
  tools: AgentTool[];
  task: string;
}

export function buildAgent(config: AgentConfig): Agent {
  const model = getModel(
    config.provider as any,
    config.modelId as any,
  );

  if (!model) {
    throw new Error(
      `Model "${config.provider}/${config.modelId}" not found. ` +
      `Check AGENT_PROVIDER and AGENT_MODEL env vars. ` +
      `Available providers: anthropic, openai, google, mistral, etc.`,
    );
  }

  const systemPrompt = `${DEFAULT_SYSTEM_PROMPT}\n\nYour task:\n${config.task}`;

  const agent = new Agent({
    initialState: {
      systemPrompt,
      model,
      tools: config.tools,
    },
  });

  agent.subscribe((event) => {
    if (
      event.type === "message_update" &&
      event.assistantMessageEvent.type === "text_delta"
    ) {
      process.stdout.write(event.assistantMessageEvent.delta);
    }
  });

  return agent;
}
