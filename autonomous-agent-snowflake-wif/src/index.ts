import { bootstrapIdentity, setAgentBaseUrl, getClientId } from "./identity.js";
import { startServer } from "./server.js";
import { KeycardTokenProvider } from "./tokenProvider.js";
import { SnowflakeClient } from "./snowflake.js";
import {
  buildAgentCard,
  createKeycardRequestHandler,
  keycardUserBuilder,
} from "@keycardai/a2a";
import { createA2AExecutor } from "./a2aExecutor.js";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { loadEnv } from "./env.js";

async function main() {
  const env = loadEnv();

  // 1. Bootstrap the agent's cryptographic identity (generates/loads keypair).
  console.log("Bootstrapping agent identity...");
  const identity = await bootstrapIdentity({
    storageDir: env.AGENT_KEYS_DIR,
  });

  // 2. Build the A2A executor, agent card, and auth layer.
  const tools: AgentTool[] = [];
  const executor = createA2AExecutor({ provider: env.AGENT_PROVIDER, modelId: env.AGENT_MODEL, tools });

  const agentCard = buildAgentCard({
    serviceName: env.AGENT_NAME,
    clientId: "",
    clientSecret: "",
    identityUrl: env.AGENT_BASE_URL,
    description: "Autonomous Snowflake WIF agent",
  });

  const requestHandler = createKeycardRequestHandler(executor, agentCard);
  const userBuilder = keycardUserBuilder({ issuer: env.KEYCARD_URL });

  // 3. Start Express server with identity + A2A endpoints.
  //    Must be running before token exchange — Keycard fetches the agent's JWKS
  //    to verify the client assertion.
  setAgentBaseUrl(env.AGENT_BASE_URL);
  await startServer({
    port: env.PORT,
    agentBaseUrl: env.AGENT_BASE_URL,
    a2a: { requestHandler, userBuilder },
  });

  const clientId = getClientId();

  // 4. Create shared Keycard token provider.
  const tokenProvider = new KeycardTokenProvider({
    keycardUrl: env.KEYCARD_URL,
    identity,
    clientId,
  });

  // 5. Establish Snowflake connection with managed token lifecycle.
  console.log("\nConnecting to Snowflake via Keycard WIF...");
  const snowflake = new SnowflakeClient(tokenProvider, {
    account: env.SNOWFLAKE_ACCOUNT,
    user: env.SNOWFLAKE_USER,
    database: env.SNOWFLAKE_DATABASE,
    warehouse: env.SNOWFLAKE_WAREHOUSE,
    role: env.SNOWFLAKE_ROLE,
  });
  await snowflake.connect();
  console.log("Snowflake connection established successfully.");

  console.log(`\nAgent ready (${env.AGENT_PROVIDER}/${env.AGENT_MODEL}). Waiting for A2A requests...`);

  // 6. Graceful shutdown.
  const shutdown = async () => {
    console.log("\nShutting down...");
    await snowflake.destroy().catch((err) => {
      console.error("Error destroying Snowflake connection:", err);
    });
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
