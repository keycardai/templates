import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { AuthProvider } from "@keycardai/mcp/server/auth/provider";

export const LINEAR_RESOURCE = "https://mcp.linear.app/mcp";

/**
 * Open a fresh MCP client to the upstream Linear server, authenticated with
 * a token brokered from the user's bearer token via Keycard.
 *
 * A new transport+client is opened per call. The volume of search/execute
 * traffic in this template does not justify a session pool, and per-call
 * connections keep the brokered token's lifetime tight.
 */
export async function withLinearClient<T>(
  authProvider: AuthProvider,
  subjectToken: string,
  fn: (client: Client) => Promise<T>,
): Promise<T> {
  const accessCtx = await authProvider.exchangeTokens(
    subjectToken,
    LINEAR_RESOURCE,
  );

  if (accessCtx.hasErrors()) {
    const errors = accessCtx.getErrors();
    throw new Error(
      `Token exchange for ${LINEAR_RESOURCE} failed: ${JSON.stringify(errors)}`,
    );
  }

  const linearToken = accessCtx.access(LINEAR_RESOURCE).accessToken;

  const transport = new StreamableHTTPClientTransport(new URL(LINEAR_RESOURCE), {
    requestInit: {
      headers: {
        Authorization: `Bearer ${linearToken}`,
      },
    },
  });

  const client = new Client(
    { name: "mcp-brokered-credentials-typescript", version: "0.1.0" },
    { capabilities: {} },
  );

  await client.connect(transport);
  try {
    return await fn(client);
  } finally {
    try {
      await client.close();
    } catch {
      // best-effort cleanup
    }
  }
}
