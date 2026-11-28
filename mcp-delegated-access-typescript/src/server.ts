import express from "express";
import {
  createKeycardMiddleware,
  requireBearerAuth,
  type AuthenticatedRequest,
} from "@keycardai/express";
import { requireToolScopes } from "@keycardai/mcp/server/auth/toolScopes";
import { OAuthError } from "@keycardai/oauth/errors";
import { ClientSecret } from "@keycardai/oauth/server/clientSecret";
import { TokenExchangeClient } from "@keycardai/oauth/tokenExchange";
import { toNodeHandler } from "@modelcontextprotocol/node";
import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";

const name = "mcp-delegated-access-typescript";
const scopes = ["mcp:tools"];
const port = Number(process.env.PORT || "8000");
const zoneUrl = requiredEnv("KEYCARD_URL");
const resourceId = process.env.KEYCARD_RESOURCE_ID || `http://localhost:${port}/mcp`;
const downstreamUrl = process.env.KEYCARD_DOWNSTREAM_URL || `http://localhost:${port}/profile`;
const downstreamResourceId = process.env.KEYCARD_DOWNSTREAM_RESOURCE_ID || downstreamUrl;

if (new URL(resourceId).pathname !== "/mcp") {
  throw new Error("KEYCARD_RESOURCE_ID must point to /mcp");
}
if (resourceId === downstreamResourceId) {
  throw new Error("The MCP and downstream resources need distinct identifiers");
}

const exchange = new TokenExchangeClient(zoneUrl, {
  credential: new ClientSecret(requiredEnv("KEYCARD_CLIENT_ID"), requiredEnv("KEYCARD_CLIENT_SECRET")),
});
const keycard = createKeycardMiddleware({ zoneUrl, resourceIdentifier: resourceId });

function requiredEnv(key: string): string {
  const value = process.env[key];
  if (!value) throw new Error(`${key} is required`);
  return value;
}

function exchangeForDownstream(subjectToken: string) {
  return exchange.exchangeToken({ subjectToken, resource: downstreamResourceId });
}

const mcp = createMcpHandler(() => {
  const server = new McpServer({ name, version: "0.1.0" });
  server.registerTool("get_profile", {
    description: "Read the signed-in user's profile from a protected downstream API.",
  }, async (ctx) => {
    const { token: subjectToken } = requireToolScopes(ctx, scopes);
    try {
      const { accessToken } = await exchangeForDownstream(subjectToken);
      const response = await fetch(downstreamUrl, {
        headers: { Authorization: `Bearer ${accessToken}` },
        redirect: "error",
        signal: AbortSignal.timeout(5_000),
      });
      if (!response.ok) throw new Error(`Downstream API returned HTTP ${response.status}`);
      const { subject } = await response.json();
      if (typeof subject !== "string" || !subject) throw new Error("Downstream profile has no subject");
      const profile = { subject };
      return {
        content: [{ type: "text", text: JSON.stringify(profile) }],
        structuredContent: profile,
      };
    } catch {
      return {
        isError: true,
        content: [{ type: "text", text: "Could not retrieve the downstream profile." }],
      };
    }
  });
  return server;
});

const app = express();
app.use(keycard.metadataRouter({ resourceName: name, scopesSupported: scopes }));

// The MCP transport carries the verified req.auth into each tool's context.
app.all("/mcp", keycard.requireBearerAuth(), toNodeHandler(mcp));

app.get("/broker", keycard.requireBearerAuth({ requiredScopes: scopes }), async (req, res) => {
  try {
    const { tokenType, expiresIn } = await exchangeForDownstream((req as AuthenticatedRequest).auth.token);
    res.json({
      status: "success",
      brokered: true,
      resource: downstreamResourceId,
      token_type: tokenType,
      expires_in: expiresIn,
    });
  } catch (error) {
    res.json({
      status: "partial_error",
      brokered: false,
      error: "Downstream token exchange failed",
      error_code: error instanceof OAuthError ? error.errorCode : undefined,
    });
  }
});

// A runnable downstream API with its own audience. The inbound MCP token
// cannot access it. Read the subject only after verifying the exchanged token.
app.get("/profile", requireBearerAuth({ zoneUrl, resourceIdentifier: downstreamResourceId }), (req, res) => {
  const { sub } = (req as AuthenticatedRequest).auth;
  if (!sub) {
    res.status(403).json({ error: "The downstream token has no subject" });
    return;
  }
  res.json({ subject: sub });
});

app.get("/healthz", (_req, res) => {
  res.json({ status: "ok" });
});

app.listen(port, () => {
  console.log(`${name} listening on http://localhost:${port}/mcp`);
});
