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

  // 1. Create (or load) a keypair that gives this agent a verifiable identity.
  console.log("Bootstrapping agent identity...");
  const identity = await bootstrapIdentity({
    storageDir: env.AGENT_KEYS_DIR,
  });

  // 2. Configure the A2A layer: how this agent describes itself (agent card)
  //    and how it handles incoming requests from other agents.
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

  // 3. Start the HTTP server with identity discovery (JWKS, OAuth client
  //    metadata) and A2A endpoints. Must be up before token exchange — the
  //    authorization server needs to reach our public keys.
  setAgentBaseUrl(env.AGENT_BASE_URL);
  const server = await startServer({
    port: env.PORT,
    agentBaseUrl: env.AGENT_BASE_URL,
    a2a: { requestHandler, userBuilder },
  });

  const clientId = getClientId();

  // 4. Set up the token provider. It uses the agent's identity to request
  //    scoped access tokens from the authorization server (OAuth 2.0).
  const tokenProvider = new KeycardTokenProvider({
    keycardUrl: env.KEYCARD_URL,
    identity,
    clientId,
  });

  // 5. Connect to Snowflake via Workload Identity Federation (WIF) using
  //    the token provider's access token. Falls back to degraded mode if
  //    Snowflake is not configured.
  let snowflake: SnowflakeClient | undefined;

  if (env.SNOWFLAKE_ACCOUNT) {
    try {
      console.log("\nConnecting to Snowflake via Keycard WIF...");
      snowflake = new SnowflakeClient(tokenProvider, {
        account: env.SNOWFLAKE_ACCOUNT,
        user: env.SNOWFLAKE_USER,
        database: env.SNOWFLAKE_DATABASE,
        warehouse: env.SNOWFLAKE_WAREHOUSE,
        role: env.SNOWFLAKE_ROLE,
      });
      await snowflake.connect();
      console.log("Snowflake connection established successfully.");
    } catch (err) {
      console.warn("WARNING: Snowflake connection failed — running in degraded mode.", err);
      snowflake = undefined;
      server.setDegraded("Snowflake connection failed");
    }
  } else {
    console.warn("WARNING: SNOWFLAKE_ACCOUNT not set — running in degraded mode (no Snowflake access).");
    server.setDegraded("SNOWFLAKE_ACCOUNT not configured");
  }

  console.log(`\nAgent ready (${env.AGENT_PROVIDER}/${env.AGENT_MODEL}). Waiting for A2A requests...`);

  // 6. Graceful shutdown — close the Snowflake connection pool.
  const shutdown = async () => {
    console.log("\nShutting down...");
    await snowflake?.destroy().catch((err) => {
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
