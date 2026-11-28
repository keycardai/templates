import { randomUUID } from "node:crypto";
import express from "express";
import { createKeycardMiddleware } from "@keycardai/express";
import {
  agentCardHandler,
  buildAgentCard,
  createKeycardRequestHandler,
  DelegationClient,
  getKeycardAuth,
  jsonRpcHandler,
  keycardUserBuilder,
  Role,
  type AgentExecutor,
  type Message,
  type RequestContext,
} from "@keycardai/a2a";

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Set ${name} before starting the agent`);
  return value;
}

function messageText(message: Message): string {
  return message.parts
    .map(({ content }) => content?.$case === "text" ? content.value : "")
    .join("");
}

function createExecutor(reply: (context: RequestContext) => string | Promise<string>): AgentExecutor {
  return {
    async execute(context, eventBus) {
      const text = await reply(context);
      const message: Message = {
        messageId: randomUUID(),
        contextId: context.contextId,
        taskId: context.taskId,
        role: Role.ROLE_AGENT,
        parts: [{ content: { $case: "text", value: text }, metadata: undefined, filename: "", mediaType: "" }],
        metadata: undefined,
        extensions: [],
        referenceTaskIds: [],
      };
      eventBus.publish({ kind: "message", data: message });
      eventBus.finished();
    },
    async cancelTask() {},
  };
}

function verifiedAuth(context: RequestContext) {
  const auth = getKeycardAuth(context);
  if (!auth) throw new Error("Expected a verified Keycard token");
  return auth;
}

const role = process.argv[2];
if (role !== "caller" && role !== "target") throw new Error("Choose the caller or target role");

const caller = role === "caller";
const port = Number(caller ? process.env.CALLER_PORT ?? 9100 : process.env.TARGET_PORT ?? 9101);
const zoneUrl = required("KEYCARD_URL");
const identityUrl = required(caller ? "CALLER_BASE_URL" : "TARGET_BASE_URL");
const config = {
  serviceName: `delegation-${role}`,
  description: caller ? "Delegates the user's message" : "Reports the verified token claims",
  identityUrl,
  authorizationServerUrl: zoneUrl,
  clientId: caller ? required("KEYCARD_CLIENT_ID") : "",
  clientSecret: caller ? required("KEYCARD_CLIENT_SECRET") : "",
};

function callerExecutor(targetUrl: string): AgentExecutor {
  const delegation = new DelegationClient(config);
  return createExecutor(async (context) => {
    const result = await delegation.invokeService(targetUrl, messageText(context.userMessage), {
      subjectToken: verifiedAuth(context).token,
    });
    if (!result.message) throw new Error("The target did not return an inline message");
    return messageText(result.message);
  });
}

const executor = caller
  ? callerExecutor(required("TARGET_BASE_URL"))
  : createExecutor((context) => {
    const { sub, act, aud } = verifiedAuth(context);
    return JSON.stringify({ sub, act, aud });
  });

const keycard = createKeycardMiddleware({ zoneUrl, resourceIdentifier: identityUrl });
const requestHandler = createKeycardRequestHandler(executor, buildAgentCard(config));
const app = express();
app.get("/healthz", (_req, res) => { res.json({ status: "ok", role }); });
app.use(keycard.metadataRouter());
app.use("/.well-known/agent-card.json", agentCardHandler({ agentCardProvider: requestHandler }));
app.use(
  "/a2a/jsonrpc",
  keycard.requireBearerAuth(),
  express.json(),
  jsonRpcHandler({ requestHandler, userBuilder: keycardUserBuilder() }),
);
app.listen(port, () => console.log(`${role} listening on port ${port}`));
