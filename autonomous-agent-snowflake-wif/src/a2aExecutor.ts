import {
  getKeycardAuth,
  Role,
  type AgentExecutor,
  type RequestContext,
  type ExecutionEventBus,
  type Message,
} from "@keycardai/a2a";
import { buildAgent, type AgentConfig } from "./agent.js";

/**
 * Creates an A2A `AgentExecutor` that delegates each inbound message
 * to a `pi-agent-core` Agent and streams the response back via the
 * A2A event bus.
 */
export function createA2AExecutor(
  config: Omit<AgentConfig, "task">,
): AgentExecutor {
  return {
    async execute(
      requestContext: RequestContext,
      eventBus: ExecutionEventBus,
    ): Promise<void> {
      const auth = getKeycardAuth(requestContext);
      if (!auth) throw new Error("unauthenticated");

      const textPart = requestContext.userMessage.parts.find(
        (p) => p.content?.$case === "text",
      );
      const task = textPart?.content?.$case === "text" ? textPart.content.value : "";

      const agent = buildAgent({ ...config, task });

      let responseText = "";
      agent.subscribe((event) => {
        if (
          event.type === "message_update" &&
          event.assistantMessageEvent.type === "text_delta"
        ) {
          responseText += event.assistantMessageEvent.delta;
        }
      });

      await agent.prompt(task);
      await agent.waitForIdle();

      const responseMessage: Message = {
        messageId: crypto.randomUUID(),
        contextId: requestContext.contextId,
        taskId: requestContext.taskId,
        role: Role.ROLE_AGENT,
        parts: [
          {
            content: { $case: "text", value: responseText },
            metadata: undefined,
            filename: "",
            mediaType: "",
          },
        ],
        metadata: undefined,
        extensions: [],
        referenceTaskIds: [],
      };
      eventBus.publish({ kind: "message", data: responseMessage });
      eventBus.finished();
    },

    async cancelTask(): Promise<void> {},
  };
}
